import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const dockerfile = () => readFile(new URL('../Dockerfile', import.meta.url).pathname, 'utf8');

// The stage that ships is the one with no name: every stage above it is a builder or a separate image.
async function shippingStage() {
  const lines = (await dockerfile()).split('\n');
  const start = lines.findLastIndex(line => line.startsWith('FROM ') && !line.includes(' AS '));
  assert.notEqual(start, -1, 'the Dockerfile ends with no unnamed stage');
  return lines.slice(start);
}

const directive = (stage: string[], keyword: string) => {
  const line = stage.find(candidate => candidate.startsWith(`${keyword} `));
  assert.ok(line, `the shipping stage has no ${keyword}`);
  return line.slice(keyword.length + 1);
};

const buildCopies = (stage: string[]) => stage
  .filter(line => line.startsWith('COPY --from=build '))
  .map(line => {
    const [, , source, destination] = line.split(/\s+/);
    return { source: source!, destination: destination! };
  });

test('the image takes from the build only the code the server runs, never the probe', async () => {
  const sources = buildCopies(await shippingStage()).map(copy => copy.source).sort();
  assert.deepEqual(sources, ['/app/dist/src/pi', '/app/dist/src/server']);
});

test('the entrypoint runs a file that the image has copied in', async () => {
  const stage = await shippingStage();
  const workdir = directive(stage, 'WORKDIR');
  const roots = buildCopies(stage).map(copy => resolve(workdir, copy.destination));
  const entrypoint = JSON.parse(directive(stage, 'ENTRYPOINT')) as string[];
  const main = entrypoint.find(argument => argument.endsWith('.js'));
  assert.ok(main, 'the entrypoint runs no JavaScript file');
  assert.ok(roots.some(root => main.startsWith(`${root}/`)), `${main} is outside ${roots.join(' ')}`);
});

// ADR 0044: natsumi draws with sdctl in the workspace, at a fixed version, with the default params baked in beside it.
const workspaceStage = async () => {
  const text = await dockerfile();
  const start = text.indexOf(' AS workspace\n');
  return text.slice(start, text.indexOf('\nFROM ', start));
};
const root = new URL('..', import.meta.url).pathname;

test('the workspace image has sdctl built from a fixed version of its source', async () => {
  const text = await dockerfile();
  const stage = text.slice(text.indexOf(' AS sdctl\n'), text.indexOf('\nFROM ', text.indexOf(' AS sdctl\n')));
  assert.ok(text.includes(' AS sdctl\n'), 'no stage builds sdctl');
  assert.match(stage, /go install [^\n]*github\.com\/yuanying\/sdctl@v0\.3\.1\b/);
  assert.doesNotMatch(stage, /@latest/);
  assert.match(await workspaceStage(), /^COPY --from=sdctl \/out\/sdctl \/usr\/local\/bin\/sdctl$/m);
});

test('the default params are in the workspace image, for Anima, with a negative prompt and the model set per request', async () => {
  const copy = /^COPY (docker\/sdctl\/\S+) (\/etc\/sdctl\/\S+)$/m.exec(await workspaceStage());
  assert.ok(copy, 'the params are not copied into the workspace image');
  assert.equal(copy[2], '/etc/sdctl/anima.yaml');
  const params = await readFile(`${root}${copy[1]}`, 'utf8');
  assert.match(params, /^negative_prompt: "[^"]+"$/m);
  // The model and its modules go with each request: the relay refuses POST options, so `models set` is no way.
  assert.match(params, /^override_settings:\n  sd_model_checkpoint: "anima_mignolia_v10"\n  forge_additional_modules:\n    - "qwen_image_vae\.safetensors"\n    - "qwen_3_06b_base\.safetensors"$/m);
  for (const key of ['steps', 'width', 'height', 'cfg_scale', 'sampler', 'scheduler', 'seed']) assert.match(params, new RegExp(`^${key}: `, 'm'), key);
  assert.doesNotMatch(params, /^prompt:/m, 'the prompt is hers to write');
});

// sdctl v0.3.1 reads its defaults from the environment: she writes the prompt and nothing else.
test('the workspace image makes the default params and /work/images sdctl\'s own defaults, and leaves the URL to the environment', async () => {
  const stage = await workspaceStage();
  assert.match(stage, /^ENV SDCTL_PARAMS=\/etc\/sdctl\/anima\.yaml$/m);
  assert.match(stage, /^ENV SDCTL_OUTPUT_DIR=\/work\/images$/m);
  assert.doesNotMatch(stage, /^ENV SDCTL_URL/m, 'the relay is the environment\'s to name');
});

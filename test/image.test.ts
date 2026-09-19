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

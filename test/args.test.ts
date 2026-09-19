import assert from 'node:assert/strict';
import test from 'node:test';
import { COMPATIBLE_KEY_ENV } from '../src/probe/auth.ts';
import { parseProbeArgs } from '../src/probe/args.ts';

const key = { [COMPATIBLE_KEY_ENV]: 'fixture-key' };

test('the live route must be chosen explicitly and exactly once', () => {
  assert.throws(() => parseProbeArgs([], key), { message: 'missing-route' });
  assert.throws(() => parseProbeArgs(['--auth-path', '/fixture/auth.json',
    '--compatible-base-url', 'https://llm.example.invalid/v1', '--compatible-model', 'm'], key), { message: 'missing-route' });
});

test('subscription route requires an absolute auth path', () => {
  assert.throws(() => parseProbeArgs(['--auth-path', 'auth.json'], {}), { message: 'missing-auth' });
  assert.deepEqual(parseProbeArgs(['--auth-path', '/fixture/auth.json'], {}),
    { kind: 'subscription', authPath: '/fixture/auth.json' });
});

test('compatible route requires URL, model, and an environment key', () => {
  const argv = ['--compatible-base-url', 'https://llm.example.invalid/v1', '--compatible-model', 'fixture-model'];
  assert.throws(() => parseProbeArgs(argv, {}), { message: 'missing-key' });
  assert.throws(() => parseProbeArgs(argv.slice(0, 2), key), { message: 'missing-route' });
  assert.deepEqual(parseProbeArgs(argv, key),
    { kind: 'compatible', baseUrl: 'https://llm.example.invalid/v1', model: 'fixture-model' });
});

test('a key passed on the command line is refused', () => {
  assert.throws(() => parseProbeArgs(['--api-key', 'x'], key));
});

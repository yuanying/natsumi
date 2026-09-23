import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { decodePublicKey, openPush, PUSH_INFO, PUSH_TEXT_MAX_CHARS, pushPlaintext, sealPush } from '../src/server/push-crypto.ts';

const vector = JSON.parse(readFileSync(new URL('./fixtures/push/vector-v1.json', import.meta.url), 'utf8'));
const bytes = (base64: string) => Buffer.from(base64, 'base64');

function devicePair() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { privateKey: ecdh.getPrivateKey(), publicKey: ecdh.getPublicKey() };
}

test('the shared vector is marked as test-only and uses the info of version 1', () => {
  assert.equal(vector.testOnly, true);
  assert.match(vector.description, /TEST ONLY/);
  assert.equal(vector.info, PUSH_INFO);
  assert.equal(PUSH_INFO, 'natsumi-push-v1');
});

test('sealing with the fixed ephemeral key and nonce reproduces the shared vector byte for byte', () => {
  const sealed = sealPush({
    devicePublicKey: bytes(vector.device.publicKey), messageId: vector.messageId, plaintext: Buffer.from(vector.plaintext),
    ephemeralPrivateKey: bytes(vector.ephemeral.privateKey), nonce: bytes(vector.nonce),
  });
  assert.deepEqual(sealed, vector.e);
});

test('the device key opens the shared vector, and ct is the ciphertext followed by the 16-byte tag', async () => {
  const opened = openPush({ devicePrivateKey: bytes(vector.device.privateKey), messageId: vector.messageId, sealed: vector.e });
  assert.equal(opened.toString('utf8'), vector.plaintext);
  const ct = bytes(vector.e.ct);
  assert.equal(ct.length, Buffer.byteLength(vector.plaintext) + 16);

  // The same bytes read as WebCrypto reads AES-GCM (ciphertext ‖ tag), the layout CryptoKit's combined form uses after the nonce.
  const key = await crypto.subtle.importKey('raw', bytes(vector.intermediate.key), 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(vector.nonce), additionalData: Buffer.from(vector.messageId) }, key, ct);
  assert.equal(Buffer.from(plain).toString('utf8'), vector.plaintext);
});

test('the base64 in e is standard base64 with padding', () => {
  const sealed = sealPush({ devicePublicKey: devicePair().publicKey, messageId: 'message-1', plaintext: Buffer.from('{"text":"a"}') });
  for (const value of [sealed.epk, sealed.nonce, sealed.ct]) assert.match(value, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(bytes(sealed.epk).length, 65);
  assert.equal(bytes(sealed.epk)[0], 0x04);
  assert.equal(bytes(sealed.nonce).length, 12);
  assert.equal(sealed.v, 1);
});

test('every seal uses a new ephemeral key and nonce', () => {
  const { publicKey } = devicePair();
  const input = { devicePublicKey: publicKey, messageId: 'message-1', plaintext: Buffer.from('{"text":"a"}') };
  const a = sealPush(input);
  const b = sealPush(input);
  assert.notEqual(a.epk, b.epk);
  assert.notEqual(a.nonce, b.nonce);
  assert.notEqual(a.ct, b.ct);
});

test('the messageId is bound as AAD: another ID or a changed byte does not open', () => {
  const pair = devicePair();
  const sealed = sealPush({ devicePublicKey: pair.publicKey, messageId: 'message-1', plaintext: Buffer.from('{"text":"a"}') });
  assert.equal(openPush({ devicePrivateKey: pair.privateKey, messageId: 'message-1', sealed }).toString(), '{"text":"a"}');
  assert.throws(() => openPush({ devicePrivateKey: pair.privateKey, messageId: 'message-2', sealed }));
  const ct = bytes(sealed.ct);
  ct[0]! ^= 1;
  assert.throws(() => openPush({ devicePrivateKey: pair.privateKey, messageId: 'message-1', sealed: { ...sealed, ct: ct.toString('base64') } }));
  assert.throws(() => openPush({ devicePrivateKey: devicePair().privateKey, messageId: 'message-1', sealed }));
});

test('the plaintext is { text, expression } and the text is cut to 1000 characters without splitting one', () => {
  assert.equal(PUSH_TEXT_MAX_CHARS, 1000);
  assert.equal(pushPlaintext({ text: 'はい', expression: 'happy' }).toString(), '{"text":"はい","expression":"happy"}');
  assert.equal(pushPlaintext({ text: 'はい' }).toString(), '{"text":"はい"}');
  const long = '😀'.repeat(1200);
  const cut = JSON.parse(pushPlaintext({ text: long, expression: 'neutral' }).toString()) as { text: string };
  assert.equal([...cut.text].length, 1000);
  assert.ok(cut.text.endsWith('…'));
  assert.ok(long.startsWith(cut.text.slice(0, -1)));
  // A limit smaller than the default, for fitting a payload.
  assert.equal(JSON.parse(pushPlaintext({ text: 'あいうえお' }, 3).toString()).text, 'あい…');
  assert.equal(JSON.parse(pushPlaintext({ text: 'あいう' }, 3).toString()).text, 'あいう');
});

test('a device public key is standard base64 of an uncompressed P-256 point, or it is refused', () => {
  assert.deepEqual(decodePublicKey(vector.device.publicKey), bytes(vector.device.publicKey));
  const valid: string = vector.device.publicKey;
  const refused = [
    '', 'not base64!', valid.replace(/=$/, ''), valid.replaceAll('+', '-'), `${valid} `,
    Buffer.alloc(65, 4).toString('base64'), // right length, not on the curve
    bytes(valid).subarray(0, 33).toString('base64'), // compressed length
    Buffer.concat([Buffer.from([0x02]), bytes(valid).subarray(1)]).toString('base64'), // wrong prefix
    Buffer.alloc(0).toString('base64'), 42, null,
  ];
  for (const value of refused) assert.equal(decodePublicKey(value), undefined, String(value));
});

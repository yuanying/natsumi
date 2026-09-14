import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APP_REDIRECT, approveAtGitHub, beginLogin, CLIENT_SECRET, finishCallback, login, MINUTE, newVerifier, OWNER,
  PUBLIC_ORIGIN, redeem, startFixture, UPSTREAM_DETAIL, type Fixture,
} from './support/server-fixture.ts';

async function withFixture(fn: (f: Fixture) => Promise<void>, options?: Parameters<typeof startFixture>[0]) {
  const f = await startFixture(options);
  try { await fn(f); } finally { await f.cleanup(); }
}

/** Nothing sensitive may reach a log line, or a response seen from index `from` on. */
function assertNoLeaks(f: Fixture, extra: string[] = [], from = 0) {
  const haystack = [...f.seen.slice(from), ...f.logs].join('\n');
  for (const needle of [CLIENT_SECRET, UPSTREAM_DETAIL, ...f.stub.accessTokens, ...extra]) {
    assert.ok(!haystack.includes(needle), `leaked a secret value: ${needle.slice(0, 12)}…`);
  }
}

test('the allowed account logs in with state and PKCE and receives a short-lived session', () => withFixture(async f => {
  const { verifier, appState, authorize } = await beginLogin(f);
  const q = authorize.searchParams;
  assert.equal(q.get('client_id'), 'Iv1.fixtureclient');
  assert.equal(q.get('redirect_uri'), `${PUBLIC_ORIGIN}/auth/github/callback`);
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.ok((q.get('state') ?? '').length >= 32);
  assert.ok(q.get('code_challenge'));
  assert.notEqual(q.get('state'), appState, 'the GitHub state is the server’s own, not the app’s');

  const { res, app } = await finishCallback(f, await approveAtGitHub(f, authorize));
  assert.equal(res.status, 302);
  assert.equal(app?.get('state'), appState);
  assert.equal(app?.get('error'), null);

  const session = await redeem(f, app!.get('code')!, verifier);
  assert.equal(session.status, 200);
  const body = session.json() as { token: string; expiresAt: string };
  assert.ok(body.token.length >= 43);
  const lifetime = Date.parse(body.expiresAt) - f.clock.now;
  assert.ok(lifetime > 0 && lifetime <= 24 * 60 * MINUTE);
  assert.ok(!f.logs.join('\n').includes(body.token), 'the session token is never logged');
  assertNoLeaks(f);
}));

test('an account is identified by numeric ID: the allowed login name with another ID is refused', () => withFixture(async f => {
  f.stub.user = { id: 7777777, login: OWNER.login };
  const { authorize } = await beginLogin(f);
  const { app } = await finishCallback(f, await approveAtGitHub(f, authorize));
  assert.equal(app?.get('error'), 'account-not-allowed');
  assert.equal(app?.get('code'), null);

  f.stub.user = { id: OWNER.id, login: 'renamed-owner' };
  assert.ok((await login(f)).token, 'a renamed login with the allowed ID is accepted');
  assertNoLeaks(f);
}));

test('a callback with a missing or mismatched state is refused', () => withFixture(async f => {
  const { authorize } = await beginLogin(f);
  const callback = await approveAtGitHub(f, authorize);
  const url = new URL(callback, PUBLIC_ORIGIN);

  url.searchParams.set('state', 'fixture-forged-state');
  let result = await finishCallback(f, `${url.pathname}${url.search}`);
  assert.equal(result.res.status, 400);
  assert.equal(result.res.json().error, 'invalid-state');

  url.searchParams.delete('state');
  result = await finishCallback(f, `${url.pathname}${url.search}`);
  assert.equal(result.res.status, 400);
  assert.equal(result.res.json().error, 'invalid-state');

  // A forged state consumes nothing; the genuine callback still completes.
  assert.ok((await finishCallback(f, callback)).app?.get('code'));
}));

test('a PKCE mismatch is refused at GitHub and at session redemption', () => withFixture(async f => {
  // A code issued for another challenge (an injected authorization code) fails the exchange.
  const { authorize } = await beginLogin(f);
  authorize.searchParams.set('code_challenge', 'fixture-attacker-challenge-0000000000000000000');
  let { app } = await finishCallback(f, await approveAtGitHub(f, authorize));
  assert.equal(app?.get('error'), 'github-exchange-failed');
  assert.equal(app?.get('code'), null);

  // The app's own verifier must match the challenge it started with; a failed attempt burns the code.
  const started = await beginLogin(f);
  ({ app } = await finishCallback(f, await approveAtGitHub(f, started.authorize)));
  const code = app!.get('code')!;
  const wrong = await redeem(f, code, newVerifier());
  assert.equal(wrong.status, 400);
  assert.equal(wrong.json().error, 'invalid-grant');
  assert.equal((await redeem(f, code, started.verifier)).status, 400);

  for (const query of ['code_challenge_method=S256&state=x', `code_challenge=${'a'.repeat(43)}&code_challenge_method=plain&state=x`,
    `code_challenge=short&code_challenge_method=S256&state=x`, `code_challenge=${'a'.repeat(43)}&code_challenge_method=S256`]) {
    const res = await f.fetch(`/auth/github/start?${query}`);
    assert.equal(res.status, 400, query);
    assert.equal(res.json().error, 'invalid-request');
  }
  assertNoLeaks(f);
}));

test('an expired login attempt or login code is refused', () => withFixture(async f => {
  const { authorize } = await beginLogin(f);
  const callback = await approveAtGitHub(f, authorize);
  f.clock.advance(11 * MINUTE);
  const { app } = await finishCallback(f, callback);
  assert.equal(app?.get('error'), 'login-expired');
  assert.equal(app?.get('code'), null);

  const started = await beginLogin(f);
  const done = await finishCallback(f, await approveAtGitHub(f, started.authorize));
  f.clock.advance(2 * MINUTE);
  const late = await redeem(f, done.app!.get('code')!, started.verifier);
  assert.equal(late.status, 400);
  assert.equal(late.json().error, 'invalid-grant');
}));

test('state, login codes and GitHub codes cannot be reused', () => withFixture(async f => {
  const { verifier, authorize } = await beginLogin(f);
  const callback = await approveAtGitHub(f, authorize);
  const { app } = await finishCallback(f, callback);
  const code = app!.get('code')!;

  const replay = await finishCallback(f, callback);
  assert.equal(replay.res.status, 400);
  assert.equal(replay.res.json().error, 'invalid-state');

  assert.equal((await redeem(f, code, verifier)).status, 200);
  const again = await redeem(f, code, verifier);
  assert.equal(again.status, 400);
  assert.equal(again.json().error, 'invalid-grant');

  // The same GitHub code under a fresh, valid state is refused by the exchange.
  const fresh = await beginLogin(f);
  const url = new URL(callback, PUBLIC_ORIGIN);
  url.searchParams.set('state', fresh.authorize.searchParams.get('state')!);
  const reused = await finishCallback(f, `${url.pathname}${url.search}`);
  assert.equal(reused.app?.get('error'), 'github-exchange-failed');
  assertNoLeaks(f);
}));

test('GitHub denial and upstream failures surface only safe codes', () => withFixture(async f => {
  const { authorize } = await beginLogin(f);
  const denied = new URL(`${PUBLIC_ORIGIN}/auth/github/callback`);
  denied.searchParams.set('error', 'access_denied');
  denied.searchParams.set('error_description', UPSTREAM_DETAIL);
  denied.searchParams.set('state', authorize.searchParams.get('state')!);
  let result = await finishCallback(f, `${denied.pathname}${denied.search}`);
  assert.equal(result.app?.get('error'), 'github-denied');

  f.stub.userStatus = 500;
  const started = await beginLogin(f);
  result = await finishCallback(f, await approveAtGitHub(f, started.authorize));
  assert.equal(result.app?.get('error'), 'github-unavailable');
  for (const value of result.app!.values()) assert.ok(!value.includes(UPSTREAM_DETAIL));
  assertNoLeaks(f);
}));

test('startup fails without the GitHub client secret and does not echo configuration values', async () => {
  await assert.rejects(startFixture({ env: {} }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /github\.clientSecretEnv/);
    assert.doesNotMatch(error.message, /NATSUMI_GITHUB_CLIENT_SECRET|fixture/);
    return true;
  });
});

test('logout revokes the session; requests without a valid session are refused', () => withFixture(async f => {
  const { token } = await login(f);
  const afterLogin = f.seen.length; // The session response itself legitimately carries the token.
  const auth = { authorization: `Bearer ${token}` };
  assert.equal((await f.fetch('/auth/logout', { method: 'POST' })).status, 401);
  assert.equal((await f.fetch('/auth/logout', { method: 'POST', headers: { authorization: 'Bearer fixture-bogus' } })).status, 401);
  const out = await f.fetch('/auth/logout', { method: 'POST', headers: auth });
  assert.equal(out.status, 204);
  assert.equal((await f.fetch('/auth/logout', { method: 'POST', headers: auth })).status, 401);
  assertNoLeaks(f, [token], afterLogin);
}));

test('responses are not cacheable and unknown routes are not found', () => withFixture(async f => {
  const missing = await f.fetch('/nothing-here');
  assert.equal(missing.status, 404);
  assert.equal(missing.json().error, 'not-found');
  assert.equal(missing.headers.get('cache-control'), 'no-store');
  const start = await f.fetch(`/auth/github/start?code_challenge=${'a'.repeat(43)}&code_challenge_method=S256&state=s`);
  assert.equal(start.headers.get('cache-control'), 'no-store');
  assert.ok(start.headers.get('location')?.startsWith(f.stub.endpoints.authorizeUrl));
  assert.equal((await f.fetch('/auth/session', { method: 'POST', body: 'not json' })).status, 400);
  assert.ok(!APP_REDIRECT.startsWith('http'));
}));

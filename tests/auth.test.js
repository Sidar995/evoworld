import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server/app.js';
const password = 'correct owner password';
const origin = 'https://evoworld.example';
async function fixture(t, overrides = {}) {
  let calls = 0;
  const store = Object.fromEntries(['ready', 'list', 'get', 'save', 'delete'].map(name => [name, async () => { calls++; throw new Error('Storage must not be reached'); }]));
  const server = createApp({ store, ...overrides }).listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const request = (path, options = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, options);
  const login = (value = password) => request('/api/auth/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: value }) });
  return { request, login, calls: () => calls };
}
test('omitted authentication fails closed and guests cannot touch storage with any experiment verb', async t => {
  const f = await fixture(t);
  assert.deepEqual(await (await f.request('/api/auth/session')).json(), { mode: 'owner', authenticated: false, csrfToken: null, configured: false });
  for (const method of ['GET', 'HEAD', 'POST', 'DELETE', 'PUT', 'PATCH', 'OPTIONS']) {
    for (const path of ['/api/experiments', '/api/experiments/00000000-0000-4000-8000-000000000001']) assert.equal((await f.request(path, { method })).status, 401);
  }
  assert.equal((await f.login()).status, 503); assert.equal(f.calls(), 0);
});
test('owner login, session rotation, CSRF/origin checks and logout protect all storage routes', async t => {
  const f = await fixture(t, { auth: { mode: 'owner', password, publicOrigin: origin, secure: true } });
  assert.equal((await f.login('incorrect')).status, 401);
  const response = await f.login(); assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0]; assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Max-Age=14400; Secure/);
  const state = await response.json(); assert.equal(state.authenticated, true); assert.equal(state.csrfToken.length, 64);
  assert.deepEqual(await (await f.request('/api/auth/session', { headers: { cookie } })).json(), state);
  for (const headers of [{ cookie }, { cookie, origin }, { cookie, origin: 'https://attacker.example', 'x-csrf-token': state.csrfToken }, { cookie, origin, 'x-csrf-token': 'wrong' }]) {
    for (const path of ['/api/experiments', '/api/experiments/00000000-0000-4000-8000-000000000001', '/api/auth/logout']) assert.equal((await f.request(path, { method: path.includes('000000') ? 'DELETE' : 'POST', headers })).status, 403);
  }
  assert.equal(f.calls(), 0);
  assert.equal((await f.request('/api/experiments', { headers: { cookie } })).status, 503); assert.equal(f.calls(), 1);
  const rotated = await f.request('/api/auth/login', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  const rotatedState = await rotated.json(); const rotatedCookie = rotated.headers.get('set-cookie').split(';')[0];
  assert.notEqual(rotatedState.csrfToken, state.csrfToken); assert.equal((await f.request('/api/experiments', { headers: { cookie } })).status, 401);
  const logout = await f.request('/api/auth/logout', { method: 'POST', headers: { cookie: rotatedCookie, origin, 'x-csrf-token': rotatedState.csrfToken } });
  assert.equal(logout.status, 200); assert.equal((await logout.json()).authenticated, false); assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await f.request('/api/experiments', { headers: { cookie: rotatedCookie } })).status, 401);
});
test('session expiry, malformed/duplicate cookies, cache controls and security headers fail safely', async t => {
  let time = 0;
  const f = await fixture(t, { auth: { mode: 'owner', password, publicOrigin: origin, now: () => time } });
  const login = await f.login(); const cookie = login.headers.get('set-cookie').split(';')[0];
  for (const malformed of ['evoworld_owner=%ZZ', 'evoworld_owner=' + 'x'.repeat(64), `${cookie}; ${cookie}`]) assert.equal((await f.request('/api/experiments', { headers: { cookie: malformed } })).status, 401);
  time = 14400000;
  const expired = await f.request('/api/experiments', { headers: { cookie } }); assert.equal(expired.status, 401); assert.equal(expired.headers.get('cache-control'), 'no-store'); assert.equal(expired.headers.get('x-content-type-options'), 'nosniff'); assert.match(expired.headers.get('content-security-policy'), /worker-src 'self'/);
  assert.equal(f.calls(), 0);
});
test('login rejects cross-origin attempts and bounds wrong-password attempts with Retry-After', async t => {
  const f = await fixture(t, { auth: { mode: 'owner', password, publicOrigin: origin } });
  assert.equal((await f.request('/api/auth/login', { method: 'POST', headers: { origin: 'https://attacker.example' } })).status, 403);
  for (let i = 0; i < 5; i++) assert.equal((await f.login('wrong')).status, 401);
  const limited = await f.login(); assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '600'); assert.equal(f.calls(), 0);
});

test('global rate and concurrent derivations remain bounded despite forged forwarded headers', async () => {
  const { createAuth } = await import('../server/auth.js');
  const auth = createAuth({ mode: 'owner', password, publicOrigin: origin });
  const req = ip => ({ is: type => type === 'application/json', headers: { origin, 'x-forwarded-for': Math.random().toString() }, socket: { remoteAddress: ip }, body: { password: null } });
  const response = () => ({ code: 200, headers: {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; }, setHeader(name, value) { this.headers[name] = value; } });
  for (let i = 0; i < 40; i++) { const res = response(); await auth.login(req(`ip-${i}`), res); assert.equal(res.code, 401); }
  const blocked = response(); await auth.login(req('another-ip'), blocked); assert.equal(blocked.code, 429);
  const parallelAuth = createAuth({ mode: 'owner', password, publicOrigin: origin });
  const requests = [0, 1, 2].map(i => { const request = req(`parallel-${i}`); request.body.password = password; const res = response(); return { res, done: parallelAuth.login(request, res) }; });
  await Promise.all(requests.map(item => item.done)); assert.deepEqual(requests.map(item => item.res.code), [200, 200, 429]);
});

test('sessions are capped at 64 and a fresh authentication instance invalidates old sessions', async () => {
  const { createAuth } = await import('../server/auth.js');
  let time = 0;
  const options = { mode: 'owner', password, publicOrigin: origin, now: () => time };
  const auth = createAuth(options); const cookies = [];
  for (let i = 0; i < 65; i++) {
    const req = { is: type => type === 'application/json', headers: { origin }, socket: { remoteAddress: `owner-${i}` }, body: { password } };
    const res = { status(code) { throw new Error(`Unexpected ${code}`); }, setHeader(_name, value) { cookies.push(value.split(';')[0]); }, json() {} };
    await auth.login(req, res);
    if (i === 35) time += 600001;
  }
  assert.equal(auth.state({ headers: { cookie: cookies[0] } }).authenticated, false);
  assert.equal(auth.state({ headers: { cookie: cookies.at(-1) } }).authenticated, true);
  assert.equal(createAuth(options).state({ headers: { cookie: cookies.at(-1) } }).authenticated, false);
});


test('bounded auth parser accepts the supported Unicode password range and rejects oversized requests safely', async t => {
  const unicodePassword = '\u754c'.repeat(900);
  const f = await fixture(t, { auth: { mode: 'owner', password: unicodePassword, publicOrigin: origin } });
  const accepted = await f.login(unicodePassword);
  assert.equal(accepted.status, 200); assert.equal((await accepted.json()).authenticated, true);
  const oversized = await f.login('x'.repeat(9000));
  assert.equal(oversized.status, 413); assert.deepEqual(await oversized.json(), { error: 'Sign-in request is too large.' });
  assert.equal(oversized.headers.get('set-cookie'), null);
  assert.equal((await (await f.request('/api/auth/session')).json()).authenticated, false);
  assert.equal(f.calls(), 0);
});

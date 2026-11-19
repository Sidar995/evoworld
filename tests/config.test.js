import test from 'node:test';
import assert from 'node:assert/strict';
import { readRuntimeConfig } from '../server/config.js';
const owner = { OWNER_PASSWORD: 'a long owner password', PUBLIC_ORIGIN: 'https://example.onrender.com' };
test('local runtime defaults to loopback and local authentication', () => {
  const config = readRuntimeConfig({}); assert.equal(config.host, '127.0.0.1'); assert.equal(config.port, 3000); assert.equal(config.auth.mode, 'local');
});
test('production and Render require secure owner configuration', () => {
  for (const marker of [{ NODE_ENV: 'production' }, { RENDER: 'true' }]) {
    assert.throws(() => readRuntimeConfig(marker));
    const config = readRuntimeConfig({ ...marker, ...owner }); assert.equal(config.host, '0.0.0.0'); assert.equal(config.auth.mode, 'owner'); assert.equal(config.auth.secure, true);
    assert.throws(() => readRuntimeConfig({ ...marker, ...owner, AUTH_MODE: 'local' }));
    assert.throws(() => readRuntimeConfig({ ...marker, ...owner, PUBLIC_ORIGIN: 'http://example.com' }));
  }
});
test('configuration rejects unsafe origins, weak secrets, invalid ports and exposed local mode', () => {
  for (const env of [{ HOST: '0.0.0.0' }, { HOST: '0.0.0.0', AUTH_MODE: 'local' }, { PORT: '1.5' }, { PORT: '65536' }, { PORT: '-1' }, { HOST: 'bad host' }, { AUTH_MODE: 'unknown' }, { AUTH_MODE: 'owner', ...owner, OWNER_PASSWORD: 'short' }, ...['https://u:p@example.com', 'https://example.com/path', 'https://example.com/?x=1', 'file:///tmp'].map(PUBLIC_ORIGIN => ({ AUTH_MODE: 'owner', ...owner, PUBLIC_ORIGIN }))]) assert.throws(() => readRuntimeConfig(env));
});

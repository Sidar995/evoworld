import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('hosting template explicitly selects free web service, manual deployment and private secrets', async () => {
  const yaml = await read('render.yaml');
  assert.match(yaml, /type: web/);
  assert.match(yaml, /runtime: node/);
  assert.match(yaml, /plan: free/);
  assert.match(yaml, /autoDeployTrigger: ['"]off['"]/);
  assert.match(yaml, /buildCommand: npm ci/);
  assert.match(yaml, /startCommand: npm start/);
  assert.doesNotMatch(yaml, /^databases:|disk:|plan: (?:starter|standard|pro)/m);
  for (const key of ['OWNER_PASSWORD', 'DATABASE_URL', 'PUBLIC_ORIGIN']) {
    assert.match(yaml, new RegExp(`key: ${key}\\s+sync: false`));
  }
});

test('public release rules use a root allowlist and exclude private secret/export variants', async () => {
  const rules = await read('.gitignore');
  assert.ok(rules.split(/\r?\n/).includes('/*'));
  for (const path of ['public/', 'server/', 'tests/', 'README.md', 'package.json', 'package-lock.json', '.env.example', 'render.yaml']) {
    assert.ok(rules.split(/\r?\n/).includes(`!/${path}`), `Missing explicit release inclusion: ${path}`);
  }
  for (const pattern of ['**/.env', '**/.env.*', '**/node_modules/', '**/*.log', '**/*.zip', '**/*.dump', '**/*.bak', '**/logbook.md']) {
    assert.ok(rules.includes(pattern), `Missing private-file exclusion: ${pattern}`);
  }
  assert.doesNotMatch(rules, /^!\/(?:docs|logbook|HOSTING_UPDATE|BUGS_AND_CHANGES|AGENTS)/m);
});

test('public README is portable and declared Node major agrees with the lockfile', async () => {
  const text = await read('README.md');
  assert.doesNotMatch(text, /[A-Z]:\\Users\\|\+91[\s-]*\d{5}|\]\((?:logbook|docs\/|HOSTING_UPDATE)/i);
  const manifest = JSON.parse(await read('package.json'));
  const lock = JSON.parse(await read('package-lock.json'));
  assert.equal(manifest.engines.node, '>=22.9.0 <23');
  assert.equal(lock.packages[''].engines.node, manifest.engines.node);
  const example = await read('.env.example');
  assert.match(example, /YOUR_PASSWORD/);
  assert.doesNotMatch(example, /OWNER_PASSWORD=(?!<)[^\s#]+/);
});

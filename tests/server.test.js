import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { encodeCursor } from '../server/archive.js';
import { createApp, validateExperiment, PgStore } from '../server/app.js';
import { createSimulation, start, step, end, toExperiment } from '../public/simulation.js';

function endedRecord() {
  const sim = createSimulation({ seed: 42 });
  start(sim);
  for (let i = 0; i < 23; i++) step(sim);
  end(sim);
  return toExperiment(sim, { id: randomUUID(), name: 'HTTP fixture', notes: 'Exported from the actual engine' });
}

// Explicit test double: these tests establish HTTP behavior, not PostgreSQL persistence.
class MemoryStoreDouble {
  records = new Map();
  unavailable = false;
  async ready() { if (this.unavailable) throw new Error('Deliberate test database failure'); }
  listCalls = [];
  async list({ limit = 20, before = null } = {}) {
    await this.ready();
    this.listCalls.push(structuredClone({ limit, before }));
    const ordered = [...this.records.values()].sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? -1 : 1;
      return a.id > b.id ? -1 : a.id < b.id ? 1 : 0;
    });
    const eligible = before ? ordered.filter(item => item.createdAt < before.createdAt || (item.createdAt === before.createdAt && item.id < before.id)) : ordered;
    const page = eligible.slice(0, limit);
    return {
      experiments: page.map(({ measurements, interventions, ...summary }) => structuredClone(summary)),
      nextCursor: eligible.length > limit ? encodeCursor(page.at(-1)) : null,
    };
  }
  async get(id) { await this.ready(); return structuredClone(this.records.get(id) ?? null); }
  deleteCalls = [];
  async delete(id) { await this.ready(); this.deleteCalls.push(id); return this.records.delete(id); }
  async save(record) {
    await this.ready();
    const existing = this.records.get(record.id);
    if (existing) {
      const { createdAt, ...persisted } = existing;
      if (!isDeepStrictEqual(persisted, record)) {
        const error = new Error('This experiment ID already belongs to a different result.'); error.status = 409; throw error;
      }
      return { experiment: structuredClone(existing), duplicate: true };
    }
    const experiment = { ...structuredClone(record), createdAt: '2026-11-03T00:00:00.000Z' };
    this.records.set(record.id, experiment);
    return { experiment: structuredClone(experiment), duplicate: false };
  }
}

async function httpFixture(t, store = new MemoryStoreDouble()) {
  const server = createApp({ store, auth: { mode: 'local' } }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, { raw, body, ...options } = {}) {
    const response = await fetch(base + path, {
      ...options,
      ...(body !== undefined || raw !== undefined ? { headers: { 'content-type': 'application/json' }, body: raw ?? JSON.stringify(body) } : {}),
    });
    return response;
  }
  return { store, base, request };
}

test('an actual ended engine record is valid and preserves initial/final measurement times', () => {
  const record = endedRecord();
  assert.equal(validateExperiment(record), null);
  assert.equal(record.measurements[0].tick, 0);
  assert.equal(record.measurements.at(-1).tick, 23);
  assert.ok(Math.abs(record.duration - 1.15) <= 1e-9);
});

test('validator rejects malformed records, bounds, ordering and missing states', () => {
  const changes = [
    record => { record.id = 'invalid'; },
    record => { record.name = ' '; },
    record => { record.name = 'n'.repeat(101); },
    record => { record.notes = 'n'.repeat(2001); },
    record => { record.seed = -1; },
    record => { record.seed = 2 ** 32; },
    record => { record.version = ''; },
    record => { record.outcome = 'running'; },
    record => { record.duration = -1; },
    record => { record.duration = 1.151; },
    record => { record.measurements = []; },
    record => { record.measurements[0].population = 301; },
    record => { record.measurements[0].food = -1; },
    record => { record.measurements[0].herbivores.meanSpeed = 81; },
    record => { record.measurements[0].herbivores.sdSpeed = -1; },
    record => { record.measurements[0].births = 0.5; },
    record => { record.measurements[0].time = 0.5; },
    record => { record.measurements.shift(); },
    record => { record.measurements.pop(); },
    record => { record.measurements[1].tick = 0; },
    record => { record.interventions = [{ tick: 24, value: 8 }]; },
    record => { record.interventions = [{ tick: 2, value: 8 }, { tick: 1, value: 9 }]; },
    record => { record.interventions = [{ tick: 1, value: 31 }]; },
    record => { record.settings.width = Infinity; },
    record => { record.finalSummary.time = NaN; },
  ];
  for (const change of changes) {
    const record = endedRecord(); change(record);
    assert.equal(typeof validateExperiment(record), 'string', `Invalid change accepted: ${change.toString()}`);
  }
  for (const value of [null, [], 'record', 0]) assert.equal(typeof validateExperiment(value), 'string');
});

test('validator requires complete reproducibility settings within their allowed bounds', () => {
  for (const mutate of [
    record => { record.settings = {}; },
    record => { delete record.settings.width; },
    record => { record.settings.foodRate = -1; },
    record => { record.settings.initialPopulation = 301; },
    record => { record.settings.dt = 0; },
  ]) {
    const record = endedRecord(); mutate(record);
    assert.equal(typeof validateExperiment(record), 'string', `Invalid settings accepted: ${mutate.toString()}`);
  }
});

test('validator rejects absent or contradictory final summaries', () => {
  for (const mutate of [
    record => { record.finalSummary = {}; },
    record => { record.finalSummary.tick = 0; },
    record => { record.finalSummary.population = 299; },
  ]) {
    const record = endedRecord(); mutate(record);
    assert.equal(typeof validateExperiment(record), 'string', `Invalid summary accepted: ${mutate.toString()}`);
  }
});

test('extinct categories require null traits and explicit outcome flags', () => {
  const sim=createSimulation({initialHerbivores:0,initialCarnivores:0}); start(sim);
  const record=toExperiment(sim,{id:randomUUID(),name:'Extinct fixture',notes:''});
  assert.equal(validateExperiment(record),null);
  record.measurements[0].herbivores.meanSpeed=0;
  assert.equal(typeof validateExperiment(record),'string');
});
test('HTTP saves engine records, retrieves them, and exposes duplicate/conflict outcomes', async t => {
  const { request, store } = await httpFixture(t);
  const record = endedRecord();
  const saved = await request('/api/experiments', { method: 'POST', body: record });
  assert.equal(saved.status, 201);
  const first = await saved.json(); assert.equal(first.duplicate, false);
  assert.equal(first.experiment.id, record.id); assert.ok(first.experiment.createdAt);
  const retry = await request('/api/experiments', { method: 'POST', body: record });
  assert.equal(retry.status, 200); assert.equal((await retry.json()).duplicate, true);
  assert.equal(store.records.size, 1);
  const conflict = await request('/api/experiments', { method: 'POST', body: { ...record, name: 'Changed result' } });
  assert.equal(conflict.status, 409); assert.equal(typeof (await conflict.json()).error, 'string');
  const retrieved = await request(`/api/experiments/${record.id}`);
  assert.equal(retrieved.status, 200); assert.deepEqual(await retrieved.json(), first.experiment);
  const listed = await request('/api/experiments');
  const archive = await listed.json();
  const { measurements, interventions, ...summary } = first.experiment;
  assert.deepEqual(archive.experiments, [summary]); assert.equal(archive.nextCursor, null);
});

test('HTTP returns usable 400 and 404 errors without storing invalid input', async t => {
  const { request, store } = await httpFixture(t);
  const bad = await request('/api/experiments', { method: 'POST', body: { id: 'bad' } });
  assert.equal(bad.status, 400); assert.equal(typeof (await bad.json()).error, 'string');
  const malformed = await request('/api/experiments', { method: 'POST', raw: '{ broken json' });
  assert.equal(malformed.status, 400); assert.equal(typeof (await malformed.json()).error, 'string');
  const invalidID = await request('/api/experiments/not-a-uuid'); assert.equal(invalidID.status, 400);
  const missing = await request(`/api/experiments/${randomUUID()}`); assert.equal(missing.status, 404);
  const unknown = await request('/api/not-a-route'); assert.equal(unknown.status, 404);
  assert.equal(store.records.size, 0);
});

test('database failure gives 503 without losing a retryable client record, then recovers', async t => {
  const { request, store } = await httpFixture(t);
  const record = endedRecord(); const original = structuredClone(record);
  store.unavailable = true;
  const health = await request('/api/health'); assert.equal(health.status, 200);
  assert.deepEqual({ ...(await health.json()), message: undefined }, { ok: true, database: false, message: undefined });
  for (const [path, options] of [
    ['/api/experiments', {}],
    [`/api/experiments/${record.id}`, {}],
    ['/api/experiments', { method: 'POST', body: record }],
  ]) {
    const failed = await request(path, options);
    assert.equal(failed.status, 503); assert.equal(typeof (await failed.json()).error, 'string');
  }
  assert.deepEqual(record, original); assert.equal(store.records.size, 0);
  store.unavailable = false;
  const recovered = await request('/api/experiments', { method: 'POST', body: record });
  assert.equal(recovered.status, 201); assert.equal(store.records.size, 1);
  const healthy = await request('/api/health'); assert.equal((await healthy.json()).database, true);
});

test('static UI remains available with database unavailable', async t => {
  const { request, store } = await httpFixture(t); store.unavailable = true;
  for (const path of ['/', '/styles.css', '/app.js', '/simulation.js']) {
    const response = await request(path);
    assert.equal(response.status, 200, `${path} should be served`);
    const text = await response.text(); assert.ok(text.length > 0);
    if (path === '/') assert.match(text, /EvoWorld/i);
  }
});

const databaseURL = process.env.TEST_DATABASE_URL;
test('real PostgreSQL isolated UUID save/read/retry/conflict round-trip', { skip: !databaseURL }, async t => {
  // Explicit opt-in only: TEST_DATABASE_URL must name a dedicated disposable test database.
  // This is the only persistence test and it deletes only its own UUID fixture.
  const store = new PgStore(databaseURL); const record = endedRecord();
  t.after(async () => {
    try { if (store.initialized) await store.pool.query('DELETE FROM evo_experiments WHERE id=$1', [record.id]); }
    finally { await store.close(); }
  });
  await store.ready();
  const saved = await store.save(record); assert.equal(saved.duplicate, false);
  const loaded = await store.get(record.id); const { createdAt, ...persisted } = loaded;
  assert.ok(createdAt); assert.deepEqual(persisted, record);
  assert.equal((await store.save(record)).duplicate, true);
  await assert.rejects(() => store.save({ ...record, name: 'Conflicting fixture' }), error => error.status === 409);
  assert.equal(await store.delete(record.id), true);
  assert.equal(await store.get(record.id), null);
  assert.equal(await store.delete(record.id), false);
});




test('archive defaults to 20 summaries and pages tied timestamps without duplicate or missing IDs', async t => {
  const store = new MemoryStoreDouble();
  const base = endedRecord();
  for (let i = 1; i <= 25; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    await store.save({ ...structuredClone(base), id, name: `Archive fixture ${i}` });
  }
  const { request } = await httpFixture(t, store);
  const firstResponse = await request('/api/experiments'); assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json();
  assert.equal(first.experiments.length, 20); assert.equal(typeof first.nextCursor, 'string');
  assert.deepEqual(store.listCalls[0], { limit: 20, before: null });
  for (const summary of first.experiments) {
    assert.equal(Object.hasOwn(summary, 'measurements'), false);
    assert.equal(Object.hasOwn(summary, 'interventions'), false);
    assert.ok(summary.id); assert.ok(summary.createdAt); assert.ok(summary.settings); assert.ok(summary.finalSummary);
  }
  const boundary = first.experiments.at(-1);
  const secondResponse = await request(`/api/experiments?limit=20&before=${encodeURIComponent(first.nextCursor)}`);
  assert.equal(secondResponse.status, 200); const second = await secondResponse.json();
  assert.equal(second.experiments.length, 5); assert.equal(second.nextCursor, null);
  assert.deepEqual(store.listCalls[1], { limit: 20, before: { createdAt: boundary.createdAt, id: boundary.id } });
  const actualIDs = [...first.experiments, ...second.experiments].map(item => item.id);
  const expectedIDs = [...store.records.keys()].sort().reverse();
  assert.deepEqual(actualIDs, expectedIDs); assert.equal(new Set(actualIDs).size, 25);
  const full = await request(`/api/experiments/${first.experiments[0].id}`);
  assert.equal(full.status, 200); const detailed = await full.json();
  assert.deepEqual(detailed.measurements, base.measurements); assert.deepEqual(detailed.interventions, base.interventions);
});

test('archive rejects invalid limits and opaque cursors before invoking storage', async t => {
  const { request, store } = await httpFixture(t);
  for (const query of [
    'limit=0', 'limit=51', 'limit=1.5', 'limit=abc', 'limit=-1',
    'before=not-base64-json',
    `before=${Buffer.from(JSON.stringify({ createdAt: 'invalid', id: randomUUID() })).toString('base64url')}`,
    `before=${Buffer.from(JSON.stringify({ createdAt: '2026-11-03T00:00:00.000Z', id: 'invalid' })).toString('base64url')}`,
  ]) {
    const response = await request(`/api/experiments?${query}`);
    assert.equal(response.status, 400, `Invalid archive query accepted: ${query}`);
    assert.equal(typeof (await response.json()).error, 'string');
  }
  assert.equal(store.listCalls.length, 0);
});

test('BUG-001: application DATABASE_URL alone never opts into the real database fixture', () => {
  const childEnvironment = { ...process.env, DATABASE_URL: 'postgres://unreachable-sentinel.invalid:1/not-a-test-database' };
  delete childEnvironment.TEST_DATABASE_URL;
  delete childEnvironment.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, [
    '--test', '--test-reporter=tap', '--test-name-pattern=^real PostgreSQL', fileURLToPath(import.meta.url),
  ], { env: childEnvironment, encoding: 'utf8', timeout: 10000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  assert.match(child.stdout, /real PostgreSQL[^\n]*# SKIP/);
});

test('legacy baseline viewing infers type without rewriting stored records or retries', async t => {
  const {request,store}=await httpFixture(t);
  const record=JSON.parse(readFileSync(new URL('./baseline-fixture.json',import.meta.url),'utf8'));
  const raw=structuredClone(record);
  const first=await request('/api/experiments',{method:'POST',body:record});
  assert.equal(first.status,201);
  const detail=await(await request(`/api/experiments/${record.id}`)).json();
  assert.equal(detail.modelType,'baseline'); assert.deepEqual(detail.measurements,record.measurements);
  assert.equal(Object.hasOwn(detail.measurements[0],'carnivores'),false);
  assert.equal(Object.hasOwn(store.records.get(record.id),'modelType'),false);
  const retry=await request('/api/experiments',{method:'POST',body:raw});
  assert.equal(retry.status,200); assert.equal((await retry.json()).duplicate,true);
  assert.deepEqual(record,raw);
});

test('BUG-009: malformed cursor ID types return HTTP 400 before storage is called', async t => {
  const { request, store } = await httpFixture(t);
  const id = '00000000-0000-4000-8000-000000000001';
  for (const invalidID of [[id], [[id]], { id }, null, true, false, 42]) {
    const before = encodeCursor({ createdAt: '2026-11-04T00:00:00.123456Z', id: invalidID });
    const response = await request(`/api/experiments?before=${encodeURIComponent(before)}`);
    assert.equal(response.status, 400); assert.equal(typeof (await response.json()).error, 'string');
  }
  assert.equal(store.listCalls.length, 0);
});
test('BUG-008: category resurrection POST is rejected before save', async t => {
  const { request, store } = await httpFixture(t); let saveCalls = 0;
  const originalSave = store.save.bind(store); store.save = record => { saveCalls++; return originalSave(record); };
  for (const category of ['herbivores', 'carnivores']) {
    const sim = createSimulation(category === 'herbivores' ? { initialHerbivores: 0, initialCarnivores: 6 } : { initialHerbivores: 6, initialCarnivores: 0 });
    start(sim); for (let i = 0; i < 250; i++) step(sim); end(sim);
    const record = toExperiment(sim, { id: randomUUID(), name: 'Impossible resurrection', notes: '' });
    const final = record.measurements.at(-1);
    Object.assign(final[category], { population: 1, births: 1, meanSpeed: 40, sdSpeed: 0, meanSensing: category === 'herbivores' ? 70 : 110, sdSensing: 0 });
    final.population++; final.births++; record.finalSummary = { ...structuredClone(final), error: null };
    const response = await request('/api/experiments', { method: 'POST', body: record });
    assert.equal(response.status, 400); assert.equal(typeof (await response.json()).error, 'string');
  }
  assert.equal(saveCalls, 0); assert.equal(store.records.size, 0);
});

test('HTTP deletion removes only the named experiment and reports absent or invalid IDs', async t => {
  const {request,store}=await httpFixture(t);
  const target=endedRecord(), retained=endedRecord();
  await store.save(target); await store.save(retained);
  const removed=await request(`/api/experiments/${target.id}`,{method:'DELETE'});
  assert.equal(removed.status,204); assert.equal(await removed.text(),'');
  assert.equal((await request(`/api/experiments/${target.id}`)).status,404);
  assert.equal((await request(`/api/experiments/${retained.id}`)).status,200);
  assert.equal((await request(`/api/experiments/${target.id}`,{method:'DELETE'})).status,404);
  assert.equal((await request('/api/experiments/not-a-uuid',{method:'DELETE'})).status,400);
  assert.deepEqual(store.deleteCalls,[target.id,target.id]);
});

test('HTTP deletion failure returns 503 and retains the experiment', async t => {
  const {request,store}=await httpFixture(t); const record=endedRecord(); await store.save(record);
  store.unavailable=true;
  assert.equal((await request(`/api/experiments/${record.id}`,{method:'DELETE'})).status,503);
  assert.equal(store.records.has(record.id),true);
  store.unavailable=false;
  assert.equal((await request(`/api/experiments/${record.id}`)).status,200);
});


import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../public/simulation.js';
import { createWorkerController } from '../public/worker-runtime.js';
import { SimulationClient } from '../public/simulation-client.js';
import { validateExperiment } from '../server/validation.js';

function clock() {
  let time = 0, nextId = 1;
  const timers = new Map();
  return {
    timers, now: () => time,
    setTimer(callback, delay) { const id = nextId++; timers.set(id, { callback, delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    advance(ms) { time += ms; },
    fireNext(ms = 25) { time += ms; const [id, item] = timers.entries().next().value ?? []; assert.ok(item, 'Expected a scheduled timer'); timers.delete(id); item.callback(); },
    fireAllOnce(ms = 0) { time += ms; const pending = [...timers.entries()]; for (const [id, item] of pending) if (timers.delete(id)) item.callback(); },
  };
}
function runtime(t, injectedEngine = engine) {
  const scheduler = clock(); const published = [];
  const controller = createWorkerController({ ...scheduler, postMessage: message => published.push(structuredClone(message)), engine: injectedEngine });
  t.after(() => controller.dispose());
  let commandId = 0;
  const send = (command, payload = {}, overrides = {}) => controller.handle({ runId: 1, commandId: ++commandId, command, payload, ...overrides });
  return { controller, scheduler, published, send };
}
class WorkerDouble {
  sent = []; terminated = 0;
  postMessage(message) { this.sent.push(structuredClone(message)); }
  terminate() { this.terminated++; }
  answer(state, request = this.sent.at(-1)) { this.onmessage?.({ data: { runId: request.runId, commandId: request.commandId, type: 'state', state: structuredClone(state) } }); }
  reject(message = 'Rejected input', request = this.sent.at(-1)) { this.onmessage?.({ data: { runId: request.runId, commandId: request.commandId, type: 'rejected', message } }); }
}
function clientFixture(t) {
  const scheduler = clock(); const workers = [], states = [], errors = [], busy = [];
  const client = new SimulationClient({ ...scheduler, timeoutMs: 5000,
    workerFactory: () => { const worker = new WorkerDouble(); workers.push(worker); return worker; },
    onState: state => states.push(structuredClone(state)), onError: (error, details) => errors.push({ error, ...details }), onBusy: value => busy.push(value),
  });
  t.after(() => client.terminate());
  return { client, scheduler, workers, states, errors, busy };
}
async function initialize(h, settings = {}) {
  const initializing = h.client.initialize(settings); const state = engine.createSimulation(settings);
  h.workers.at(-1).answer(state); await initializing; return state;
}
async function startClient(h, state) {
  const pending = h.client.command('start'); engine.start(state); h.workers.at(-1).answer(state); await pending;
}

test('worker initializes once and repeated start actions retain one scheduled loop', t => {
  const h = runtime(t); h.send('init', { seed: 42 }); h.send('start'); h.send('start');
  assert.equal(h.scheduler.timers.size, 1); assert.equal(h.controller.getState().status, 'running');
  const before = h.controller.getState(); h.send('init', { seed: 7 });
  assert.equal(h.published.at(-1).type, 'rejected'); assert.deepEqual(h.controller.getState(), before);
});
test('worker bounds catch-up to eight fixed steps and publishes slow performance without skipped biology', t => {
  const h = runtime(t); h.send('init', { seed: 42 }); h.send('start');
  h.scheduler.fireNext(10000);
  const state = h.controller.getState(); assert.equal(state.tick, 8); assert.equal(state.performanceSlow, true);
  const expected = engine.createSimulation({ seed: 42 }); engine.start(expected); for (let i = 0; i < 8; i++) engine.step(expected);
  delete state.performanceSlow; assert.deepEqual(state, engine.snapshot(expected));
  assert.equal(h.scheduler.timers.size, 1);
});
test('worker pauses without backlog and resume advances only new elapsed time', t => {
  const h = runtime(t); h.send('init'); h.send('start'); h.scheduler.fireNext(100); assert.equal(h.controller.getState().tick, 2);
  h.send('pause'); const tick = h.controller.getState().tick; assert.equal(h.scheduler.timers.size, 0);
  h.scheduler.advance(10000); h.send('resume'); h.scheduler.fireNext(50);
  assert.equal(h.controller.getState().tick, tick + 1);
});
test('worker speed executes more complete ticks without changing dt or rules', t => {
  const h = runtime(t); h.send('init'); h.send('start'); h.send('speed', { value: 4 }); h.scheduler.fireNext(100);
  assert.equal(h.controller.getState().tick, 8); assert.equal(h.controller.getState().settings.dt, 0.05);
  h.send('end'); assert.equal(h.scheduler.timers.size, 0); assert.equal(h.controller.getState().status, 'ended');
});
test('worker periodic state publications are bounded rather than posted after every tick', t => {
  const h = runtime(t); h.send('init'); h.send('start'); const acknowledged = h.published.length;
  for (let i = 0; i < 20; i++) h.scheduler.fireNext(25);
  assert.equal(h.controller.getState().tick, 10);
  assert.ok(h.published.length - acknowledged <= 3, 'Periodic publishing must be bounded to about 200ms');
});
test('worker rejects duplicate IDs, old runs and invalid commands without state mutation', t => {
  const h = runtime(t); h.send('init'); h.send('start'); const before = h.controller.getState();
  h.send('rainfall', { value: 'dry' }, { commandId: 2 });
  assert.equal(h.published.at(-1).type, 'rejected');
  h.send('rainfall', { value: 'dry' }, { runId: 99 }); assert.equal(h.published.at(-1).type, 'rejected');
  h.send('rainfall', { value: 'storm' }); assert.equal(h.published.at(-1).type, 'rejected');
  h.send('speed', { value: 8 }); assert.equal(h.published.at(-1).type, 'rejected');
  assert.deepEqual(h.controller.getState(), before);
});
test('worker accepted rainfall acknowledgements preserve next-tick event order and queue bounds', t => {
  const h = runtime(t); h.send('init'); h.send('start'); h.send('pause');
  for (let i = 0; i < 20; i++) h.send('rainfall', { value: i % 2 ? 'wet' : 'dry' });
  assert.equal(h.controller.getState().pendingEvents.length, 20);
  const before = h.controller.getState(); h.send('rainfall', { value: 'normal' }); assert.equal(h.published.at(-1).type, 'rejected');
  assert.deepEqual(h.controller.getState(), before);
  h.send('resume'); h.scheduler.fireNext(50);
  assert.equal(h.controller.getState().interventions.length, 20);
  assert.equal(h.controller.getState().interventions[0].rainfall, 'dry');
  assert.equal(h.controller.getState().interventions[19].rainfall, 'wet');
});
test('worker fatal injected engine failure stops scheduling and preserves safe partial state', t => {
  const h = runtime(t, { ...engine, step() { throw new Error('Injected engine failure'); } });
  h.send('init'); h.send('start'); h.scheduler.fireNext(50);
  assert.equal(h.scheduler.timers.size, 0); assert.equal(h.published.at(-1).type, 'failure');
  const state = h.controller.getState(); assert.equal(state.partial, true); assert.equal(state.outcome, 'error');
  assert.equal(state.measurements.at(-1).tick, 0); assert.match(state.error, /Injected/);
});
test('disposing a worker cancels scheduled work and rejects further execution by silence', t => {
  const h = runtime(t); h.send('init'); h.send('start'); h.controller.dispose();
  assert.equal(h.scheduler.timers.size, 0); const count = h.published.length; h.send('resume');
  assert.equal(h.published.length, count); assert.equal(h.controller.getState(), null);
});
test('client lifecycle is acknowledgement based and rapid duplicate Start is rejected', async t => {
  const h = clientFixture(t); const sim = await initialize(h);
  const first = h.client.command('start'); assert.equal(h.client.busy, true);
  await assert.rejects(h.client.command('start'), /Wait/);
  assert.equal(h.workers.length, 1); assert.equal(h.workers[0].sent.filter(m => m.command === 'start').length, 1);
  engine.start(sim); h.workers[0].answer(sim); await first; assert.equal(h.client.busy, false);
});
test('client reset terminates the old worker and ignores stale messages from prior run', async t => {
  const h = clientFixture(t); await initialize(h);
  const oldWorker = h.workers[0]; const oldListener = oldWorker.onmessage; const oldRequest = oldWorker.sent.at(-1);
  const resetting = h.client.reset({ seed: 77 }); const fresh = engine.createSimulation({ seed: 77 }); h.workers[1].answer(fresh); await resetting;
  assert.equal(oldWorker.terminated, 1); assert.equal(h.workers.length, 2);
  oldListener({ data: { runId: oldRequest.runId, type: 'state', state: engine.createSimulation({ seed: 1 }) } });
  assert.equal(h.client.state.seed, 77);
});
test('client resetting during initialization rejects prior promise and creates only one live worker', async t => {
  const h = clientFixture(t); const first = h.client.initialize({ seed: 1 }); const rejected = assert.rejects(first, /replaced|closed/);
  const second = h.client.reset({ seed: 2 }); h.workers[1].answer(engine.createSimulation({ seed: 2 }));
  await rejected; await second; assert.equal(h.workers[0].terminated, 1); assert.equal(h.client.state.seed, 2);
});
test('client startup timeout has no fabricated measured run and reset is available', async t => {
  const h = clientFixture(t); const initial = h.client.initialize(); const rejected = assert.rejects(initial, /respond/);
  h.scheduler.fireNext(5000); await rejected;
  assert.equal(h.client.state, null); assert.equal(h.errors.at(-1).recoverable, false); assert.equal(h.workers[0].terminated, 1);
  assert.throws(() => h.client.exportExperiment({ id: '00000000-0000-4000-8000-000000000001', name: 'No run', notes: '' }), /confirmed/);
  const next = h.client.reset({ seed: 3 }); h.workers[1].answer(engine.createSimulation({ seed: 3 })); await next;
  assert.equal(h.client.state.seed, 3);
});
test('client rejects a worker command without replacing confirmed state', async t => {
  const h = clientFixture(t); await initialize(h); const before = structuredClone(h.client.state);
  const pending = h.client.command('rainfall', { value: 'storm' }); h.workers[0].reject('Rainfall must be dry, normal or wet');
  await assert.rejects(pending, /Rainfall/); assert.deepEqual(h.client.state, before); assert.equal(h.workers[0].terminated, 0);
});
test('client bounds unacknowledged rainfall commands to twenty', async t => {
  const h = clientFixture(t); await initialize(h); const pending = [];
  for (let i = 0; i < 20; i++) pending.push(h.client.command('rainfall', { value: 'dry' }));
  await assert.rejects(h.client.command('rainfall', { value: 'wet' }), /Too many rainfall/);
  assert.equal(h.workers[0].sent.filter(m => m.command === 'rainfall').length, 20);
  const rejected = pending.map(promise => assert.rejects(promise, /replaced|closed/)); h.client.terminate(); await Promise.all(rejected);
});
test('client worker error recovers last published sample and trims later interventions', async t => {
  const h = clientFixture(t); const sim = await initialize(h); await startClient(h, sim);
  for (let i = 0; i < 20; i++) engine.step(sim);
  engine.setRainfall(sim, 'dry'); engine.step(sim);
  h.workers[0].answer(sim, { runId: h.client.runId });
  h.workers[0].onerror({ message: 'Injected worker crash', preventDefault() {} });
  assert.equal(h.client.state.status, 'ended'); assert.equal(h.client.state.partial, true); assert.equal(h.client.state.tick, 20);
  assert.deepEqual(h.client.state.interventions, []); assert.equal(h.client.state.recoveryOnly, true);
  const record = h.client.exportExperiment({ id: '00000000-0000-4000-8000-000000000001', name: 'Recovered', notes: '' });
  assert.equal(record.duration, 1); assert.equal(record.partial, true); assert.equal(record.outcome, 'error');
  assert.equal(validateExperiment(record), null);
});
test('client unreadable worker message and missing running heartbeat recover safely', async t => {
  for (const trigger of ['messageerror', 'watchdog']) {
    const h = clientFixture(t); const sim = await initialize(h); await startClient(h, sim);
    if (trigger === 'messageerror') h.workers[0].onmessageerror(); else h.scheduler.fireNext(5000);
    assert.equal(h.client.state.partial, true); assert.equal(h.client.state.tick, 0); assert.equal(h.workers[0].terminated, 1);
  }
});
test('client Worker construction failure exposes no fabricated experiment', async t => {
  const h = new SimulationClient({ workerFactory() { throw new Error('Worker unavailable'); } });
  t.after(() => h.terminate());
  await assert.rejects(h.initialize(), /Worker unavailable/); assert.equal(h.state, null); assert.equal(h.busy, false);
});

test('production worker accepts only four starting controls and cannot override biological safety constants', t => {
  for (const payload of [{ width: 1e308 }, { maxTicks: 1 }, { maxOffspring: 100 }, { initialFood: 0 }]) {
    const h = runtime(t); h.send('init', { seed: 42, ...payload });
    assert.equal(h.published.at(-1).type, 'rejected'); assert.equal(h.controller.getState(), null);
  }
});

test('client rejects invalid reset settings before replacing an active worker or state', async t => {
  const h = clientFixture(t); const sim = await initialize(h); await startClient(h, sim);
  const before = structuredClone(h.client.state); const runId = h.client.runId; const worker = h.workers[0];
  for (const settings of [{ seed: 42, initialHerbivores: 301, initialCarnivores: 0, rainfall: 'normal' }, { width: 1e308 }]) {
    await assert.rejects(() => h.client.reset(settings));
    assert.equal(h.client.runId, runId); assert.equal(h.client.worker, worker); assert.equal(worker.terminated, 0);
    assert.deepEqual(h.client.state, before); assert.equal(h.workers.length, 1);
  }
});


// BUG-007: exercise constructor defaults against native-like global timer receiver checks.
test('BUG-007: default global timers keep their required host receiver through lifecycle and heartbeat', async () => {
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  const scheduled = new Map(); let next = 1; let client; const workers = [];
  globalThis.setTimeout = function (callback, delay) { if (this !== globalThis) throw new TypeError('Illegal invocation: setTimeout receiver'); const id = next++; scheduled.set(id, { callback, delay }); return id; };
  globalThis.clearTimeout = function (id) { if (this !== globalThis) throw new TypeError('Illegal invocation: clearTimeout receiver'); scheduled.delete(id); };
  try {
    client = new SimulationClient({ workerFactory: () => { const w = new WorkerDouble(); workers.push(w); return w; } });
    const initial = client.initialize(); const sim = engine.createSimulation(); workers[0].answer(sim); await initial;
    assert.equal(scheduled.size, 0);
    const running = client.command('start'); engine.start(sim); workers[0].answer(sim); await running;
    assert.equal(scheduled.size, 1, 'Running state has one bounded heartbeat watchdog');
    const paused = client.command('pause'); engine.pause(sim); workers[0].answer(sim); await paused;
    assert.equal(scheduled.size, 0);
    const resumed = client.command('resume'); engine.resume(sim); workers[0].answer(sim); await resumed;
    assert.equal(scheduled.size, 1);
    const resetting = client.reset({ seed: 77 }); workers[1].answer(engine.createSimulation({ seed: 77 })); await resetting;
    assert.equal(workers[0].terminated, 1); assert.equal(scheduled.size, 0); assert.equal(client.state.seed, 77);
  } finally {
    try { client?.terminate(); } catch { /* Preserve the primary pre-fix receiver failure. */ }
    globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear;
  }
});
test('BUG-007: initialization cleanup failure reports once, leaks no resources, and permits retry', async t => {
  const timers = clock(); const workers = [], errors = []; let throwOnce = true;
  const client = new SimulationClient({ ...timers,
    clearTimer(id) { if (throwOnce) { throwOnce = false; throw new Error('Injected cleanup timer failure'); } timers.clearTimer(id); },
    workerFactory: () => { const w = new WorkerDouble(); workers.push(w); return w; },
    onError: (error, details) => errors.push({ error, ...details }),
  });
  t.after(() => client.terminate());
  await assert.rejects(() => client.initialize(), /cleanup timer failure/);
  assert.equal(errors.length, 1); assert.equal(errors[0].recoverable, false);
  assert.equal(client.state, null); assert.equal(client.worker, null); assert.equal(client.busy, false); assert.equal(client.pending.size, 0);
  const retry = client.reset(); workers[0].answer(engine.createSimulation()); await retry;
  assert.equal(client.state.status, 'ready');
});
test('BUG-007: command timer creation failure cleans worker and pending lifecycle before retry', async t => {
  const timers = clock(); const workers = [], errors = []; let throwOnce = true;
  const client = new SimulationClient({ ...timers,
    setTimer(callback, delay) { if (throwOnce) { throwOnce = false; throw new Error('Injected timer scheduling failure'); } return timers.setTimer(callback, delay); },
    workerFactory: () => { const w = new WorkerDouble(); workers.push(w); return w; },
    onError: (error, details) => errors.push({ error, ...details }),
  });
  t.after(() => client.terminate());
  await assert.rejects(() => client.initialize(), /timer scheduling failure/);
  assert.equal(errors.length, 1); assert.equal(errors[0].recoverable, false);
  assert.equal(workers[0].terminated, 1); assert.equal(client.worker, null); assert.equal(client.pending.size, 0); assert.equal(client.busy, false);
  const retry = client.reset(); workers[1].answer(engine.createSimulation()); await retry;
  assert.equal(client.state.status, 'ready');
});

test('BUG-007: watchdog timer creation failure rejects the command once and recovers a measured partial result', async t => {
  const timers = clock(); const workers = [], errors = []; let failScheduling = false;
  const client = new SimulationClient({ ...timers,
    setTimer(callback, delay) { if (failScheduling) { failScheduling = false; throw new Error('Injected watchdog scheduling failure'); } return timers.setTimer(callback, delay); },
    workerFactory: () => { const w = new WorkerDouble(); workers.push(w); return w; },
    onError: (error, details) => errors.push({ error, ...details }),
  });
  t.after(() => client.terminate());
  const initializing = client.initialize(); const sim = engine.createSimulation(); workers[0].answer(sim); await initializing;
  const starting = client.command('start').catch(error => error); engine.start(sim); failScheduling = true;
  let escaped;
  try { workers[0].answer(sim); } catch (error) { escaped = error; client.terminate(); }
  const result = await starting;
  assert.equal(escaped, undefined, 'Timer failure must not escape the worker message handler');
  assert.match(result.message, /watchdog scheduling failure/); assert.equal(errors.length, 1); assert.equal(errors[0].recoverable, true);
  assert.equal(client.worker, null); assert.equal(client.busy, false); assert.equal(client.pending.size, 0); assert.equal(workers[0].terminated, 1);
  assert.equal(client.state.status, 'ended'); assert.equal(client.state.partial, true); assert.equal(client.state.tick, 0);
});

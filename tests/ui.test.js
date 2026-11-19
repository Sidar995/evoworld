import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { snapshot, createSimulation, start, end, toExperiment } from '../public/simulation.js';
import { createWorkerController } from '../public/worker-runtime.js';

// Controlled DOM and Worker transport execute real app/client/runtime modules.
// They establish event integration, not real browser rendering or accessibility QA.
class Element {
  constructor(tag = 'div', id = '') {
    this.tagName = tag.toUpperCase(); this.id = id; this.children = []; this.listeners = new Map(); this.attributes = new Map();
    this.value = ''; this.textContent = ''; this.hidden = false; this.disabled = false; this.checked = false;
    this.dataset = {}; this.className = ''; this.clears = 0;
    const classes = new Set();
    this.classList = { add: (...items) => items.forEach(x => classes.add(x)), remove: (...items) => items.forEach(x => classes.delete(x)), toggle: (x, force) => { const add = force ?? !classes.has(x); add ? classes.add(x) : classes.delete(x); return add; }, contains: x => classes.has(x) };
    this.context = new Proxy({ clearRect: () => { this.clears++; }, measureText: text => ({ width: String(text).length * 6 }) }, { get: (target, key) => target[key] ?? (() => {}) });
  }
  addEventListener(type, fn) { const listeners = this.listeners.get(type) || []; listeners.push(fn); this.listeners.set(type, listeners); }
  async fire(type, event = {}) { const e = { type, target: this, preventDefault() { this.defaultPrevented = true; }, ...event }; for (const fn of this.listeners.get(type) || []) await fn(e); return e; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  append(...items) { this.children.push(...items); }
  appendChild(item) { this.append(item); return item; }
  replaceChildren(...items) { this.children = [...items]; }
  getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, width: this.id === 'world' ? 1000 : 400, height: this.id === 'world' ? 600 : 180 }; }
  getContext() { return this.context; }
  click() { return this.fire('click'); }
  focus() {}
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const text = element => `${element.textContent} ${element.children.map(child => typeof child === 'object' ? text(child) : child).join(' ')}`;
let run = 0;
async function browser(t, fetchHandler = async () => ({ ok: true, json: async () => ({ experiments: [], nextCursor: null }) }), options = {}) {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, new Element(id.endsWith('Chart') || id === 'world' ? 'canvas' : 'div', id)]));
  for (const [id, value] of Object.entries({ seed: '42', initialHerbivores: '40', initialCarnivores: '6', rainfall: 'normal' })) elements.get(id).value = value;
  const document = new Element('document'); document.hidden = false;
  document.getElementById = id => { if (!elements.has(id)) throw new Error(`Missing HTML id: ${id}`); return elements.get(id); };
  document.createElement = tag => new Element(tag);
  const speeds = [1, 2, 4].map(speed => { const button = new Element('button'); button.dataset.speed = String(speed); return button; });
  document.querySelectorAll = selector => selector === '[data-speed]' ? speeds : [];
  const window = new Element('window'); window.devicePixelRatio = 1; window.matchMedia = () => ({ matches: false }); window.confirm = () => false;
  let raf;
  const posts = [], downloads = [], workers = [];
  class WorkerAdapter {
    constructor() {
      this.sent = []; this.terminated = false; this.clock = 0; this.nextTimer = 1; this.timers = new Map(); workers.push(this);
      this.controller = createWorkerController({
        now: () => this.clock,
        setTimer: callback => { const id = this.nextTimer++; this.timers.set(id, callback); return id; },
        clearTimer: id => this.timers.delete(id),
        postMessage: message => queueMicrotask(() => this.onmessage?.({ data: structuredClone(message) })),
      });
    }
    postMessage(message) { this.sent.push(structuredClone(message)); this.runId = message.runId; queueMicrotask(() => this.controller.handle(message)); }
    terminate() { this.terminated = true; this.controller.dispose(); }
    advance(ms = 50) { this.clock += ms; const [id, callback] = this.timers.entries().next().value ?? []; if (callback) { this.timers.delete(id); callback(); } }
    publish(state = this.controller.getState()) { this.onmessage?.({ data: { runId: this.runId, type: 'state', state: structuredClone(state) } }); }
  }
  const globals = { document, window, Worker: WorkerAdapter, requestAnimationFrame: callback => { raf = callback; }, fetch: async (url, requestOptions) => {
    if (url.startsWith('/api/auth/')) return options.authHandler
      ? options.authHandler(url, requestOptions)
      : { ok: true, status: 200, json: async () => ({ mode: 'local', authenticated: true, csrfToken: null, configured: true }) };
    if (requestOptions?.method === 'POST') posts.push(requestOptions.body);
    return fetchHandler(url, requestOptions);
  } };
  if (options.renderClock) globals.performance = { now: () => options.renderClock.time };
  if (options.startupCleanupFailure) {
    const hostClearTimeout = globalThis.clearTimeout;
    let failOnce = true;
    globals.clearTimeout = function (timer) {
      if (failOnce) { failOnce = false; throw new TypeError('Injected initial timer cleanup failure'); }
      return hostClearTimeout(timer);
    };
  }
  const prior = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  const originalCreate = URL.createObjectURL; URL.createObjectURL = blob => { downloads.push(blob); return `blob:ui-test-${downloads.length}`; };
  let module;
  t.after(() => {
    module?.disposeAuth(); module?.client.terminate(); for (const worker of workers) worker.terminate(); URL.createObjectURL = originalCreate;
    for (const [key, descriptor] of prior) descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
  });
  let source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  source = source.replace(/from '(\.\/[^']+)'/g, (_all, path) => `from '${new URL(`../public/${path.slice(2)}`, import.meta.url).href}'`);
  source += '\nexport { sim, updateUi, client, disposeAuth };\n';
  module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${++run}`);
  await flush(); await flush();
  return { module, elements, document, window, speeds, posts, downloads, workers, frame: timestamp => raf(timestamp), el: id => elements.get(id),
    async ticks(count) { const worker = workers.at(-1); for (let i = 0; i < count; i++) worker.advance(50); await flush(); worker.publish(); await flush(); } };
}

test('keyboard inspection cycles both animal categories without changing confirmed biology/RNG', async t => {
  const h = await browser(t); const before = snapshot(h.module.sim);
  await h.el('world').fire('keydown', { key: 'Enter' }); assert.match(h.el('organismTitle').textContent, /Herbivore 1$/);
  await h.el('world').fire('keydown', { key: 'ArrowLeft' }); assert.match(h.el('organismTitle').textContent, /Carnivore 46$/);
  assert.match(text(h.el('organismDetails')), /Offspring|offspring/);
  await h.el('world').fire('keydown', { key: 'Escape' }); assert.match(h.el('organismTitle').textContent, /Look a little closer/);
  assert.deepEqual(snapshot(h.module.sim), before);
});
test('starting counts reject invalid combined totals before replacing a worker or starting', async t => {
  const h = await browser(t); const before = snapshot(h.module.sim); const count = h.workers.length;
  h.el('initialHerbivores').value = '300'; h.el('initialCarnivores').value = '1'; await h.el('runButton').fire('click');
  assert.equal(h.workers.length, count); assert.deepEqual(snapshot(h.module.sim), before);
  assert.match(h.el('runMessage').textContent, /combined|300/);
});
test('rapid Start clicks yield one lifecycle transition and one running worker', async t => {
  const h = await browser(t); await Promise.all([h.el('runButton').fire('click'), h.el('runButton').fire('click')]);
  assert.equal(h.workers.length, 1); assert.equal(h.workers[0].sent.filter(message => message.command === 'start').length, 1);
  assert.equal(h.module.sim.status, 'running');
});
test('pending rainfall is shown and End discards it without adding a biological tick', async t => {
  const h = await browser(t); await h.el('runButton').fire('click'); await h.ticks(2);
  h.el('rainfall').value = 'dry'; await h.el('rainfall').fire('change');
  assert.match(h.el('rainfallStatus').textContent, /Applied.*Normal|Applied.*normal/);
  assert.match(h.el('rainfallStatus').textContent, /Pending.*Dry|Pending.*dry/);
  const tick = h.module.sim.tick; await h.el('endButton').fire('click');
  assert.equal(h.module.sim.tick, tick); assert.deepEqual(h.module.sim.interventions, []);
  assert.equal(h.el('rainfall').value, 'normal');
  assert.match(h.el('rainfallValue').textContent, /normal.*8/i, 'Discarded rainfall must restore the applied growth-rate label');
  assert.match(h.el('rainfallStatus').textContent, /discarded/);
});
test('rainfall queue preserves accepted input order and reset restores original starting conditions', async t => {
  const h = await browser(t); await h.el('runButton').fire('click'); await h.el('runButton').fire('click');
  h.el('rainfall').value = 'dry'; await h.el('rainfall').fire('change'); h.el('rainfall').value = 'wet'; await h.el('rainfall').fire('change');
  await h.el('runButton').fire('click'); await h.ticks(1);
  assert.deepEqual(h.module.sim.interventions, [{ tick: 1, rainfall: 'dry' }, { tick: 1, rainfall: 'wet' }]);
  h.window.confirm = () => true; await h.el('resetButton').fire('click');
  assert.equal(h.module.sim.status, 'ready'); assert.equal(h.module.sim.rainfall, 'normal');
  assert.equal(h.workers.length, 2); assert.equal(h.workers[0].terminated, true);
});
test('cancelled Reset pauses during dialog and creates no worker or wall-clock catchup', async t => {
  const h = await browser(t); await h.el('runButton').fire('click'); await h.ticks(2); const before = snapshot(h.module.sim);
  h.window.confirm = () => { h.workers[0].advance(10000); return false; };
  await h.el('resetButton').fire('click'); assert.deepEqual(snapshot(h.module.sim), before); assert.equal(h.workers.length, 1);
  await h.ticks(1); assert.equal(h.module.sim.tick, before.tick + 1);
});
test('hidden tabs pause the worker and require explicit Resume', async t => {
  const h = await browser(t); await h.el('runButton').fire('click'); await h.ticks(2);
  h.document.hidden = true; await h.document.fire('visibilitychange'); await flush(); await flush();
  const tick = h.module.sim.tick; assert.equal(h.module.sim.status, 'paused');
  h.workers[0].advance(10000); h.document.hidden = false; await h.document.fire('visibilitychange'); await flush();
  assert.equal(h.module.sim.status, 'paused'); assert.equal(h.module.sim.tick, tick);
  await h.el('runButton').fire('click'); await h.ticks(1); assert.equal(h.module.sim.tick, tick + 1);
});
test('JSON remains editable before POST and retries reuse identical food-chain payload', async t => {
  const h = await browser(t, async (_url, options) => options?.method === 'POST'
    ? { ok: false, status: 503, json: async () => ({ error: 'Database unavailable' }) }
    : { ok: true, json: async () => ({ experiments: [], nextCursor: null }) });
  await h.el('runButton').fire('click'); await h.el('endButton').fire('click');
  h.el('experimentName').value = 'First export'; await h.el('downloadButton').fire('click');
  const first = JSON.parse(await h.downloads[0].text()); assert.equal(first.modelType, 'food-chain');
  assert.equal(h.el('experimentName').disabled, false);
  h.el('experimentName').value = 'Edited export'; await h.el('downloadButton').fire('click');
  const second = JSON.parse(await h.downloads[1].text()); assert.notEqual(first.id, second.id); assert.equal(second.name, 'Edited export');
  await h.el('saveForm').fire('submit'); assert.equal(h.el('experimentName').disabled, true);
  await h.el('saveForm').fire('submit'); assert.equal(h.posts[1], h.posts[0]); assert.deepEqual(JSON.parse(h.posts[0]), second);
});
test('worker crash exposes valid partial result and Reset creates an explicit fresh worker', async t => {
  const h = await browser(t); await h.el('runButton').fire('click'); await h.ticks(22);
  h.workers[0].onerror({ message: 'Injected transport crash', preventDefault() {} }); await flush();
  assert.equal(h.module.sim.status, 'ended'); assert.equal(h.module.sim.partial, true); assert.equal(h.module.sim.tick, 20);
  assert.equal(h.el('resultPanel').hidden, false); assert.match(text(h.el('resultFlags')), /partial|Partial|error|Error/);
  h.el('experimentName').value = 'Recovered run'; await h.el('downloadButton').fire('click');
  const exported = JSON.parse(await h.downloads.at(-1).text()); assert.equal(exported.partial, true); assert.equal(exported.duration, 1);
  h.window.confirm = () => true; await h.el('resetButton').fire('click'); assert.equal(h.workers.length, 2); assert.equal(h.module.sim.status, 'ready');
});
test('unchanged paused histories are not redrawn and category values are available as text', async t => {
  const h = await browser(t); await h.el('runButton').fire('click'); await h.el('runButton').fire('click');
  const before = h.el('populationChart').clears; h.module.updateUi(); h.module.updateUi();
  assert.equal(h.el('populationChart').clears, before); assert.match(text(h.el('measurementSummary')), /Herbivor|herbivor/); assert.match(text(h.el('measurementSummary')), /Carnivor|carnivor/);
});
function savedFoodChain(id, version = 'evoworld-food-chain-1') {
  const sim = createSimulation(); start(sim); end(sim);
  return { ...toExperiment(sim, { id, name: `Run ${id}`, notes: '' }), version, createdAt: '2026-11-04T00:00:00.000Z' };
}
const summaries = records => records.map(({ measurements, interventions, ...summary }) => summary);
const findElement = (element, predicate) => predicate(element) ? element : element.children.map(child => findElement(child, predicate)).find(Boolean);
const archiveBoxes = h => h.el('experimentList').children.map(row => findElement(row, child => child.tagName === 'INPUT' && child.type === 'checkbox'));
const deleteButton = (h, id) => {
  const button = findElement(h.el('experimentList'), element => element.tagName === 'BUTTON' && element.dataset.experimentId === id);
  assert.ok(button, `Expected a Delete button for experiment ${id}`);
  return button;
};
async function selectPair(h) {
  const boxes = archiveBoxes(h);
  boxes[0].checked = true; await boxes[0].fire('change'); boxes[1].checked = true; await boxes[1].fire('change'); await flush(); await flush();
  return boxes;
}
test('archive retrieves only the chosen compatible pair and warns for versions', async t => {
  const requests = []; const records = [savedFoodChain('00000000-0000-4000-8000-000000000001'), savedFoodChain('00000000-0000-4000-8000-000000000002', 'future-food-chain-version')];
  const h = await browser(t, async url => { requests.push(url); return { ok: true, json: async () => url.includes('?') ? { experiments: summaries(records), nextCursor: null } : records.find(r => url.endsWith(`/${r.id}`)) }; });
  assert.equal(requests.length, 1); await selectPair(h);
  assert.equal(requests.length, 3); assert.equal(h.el('comparisonCharts').hidden, false);
  assert.match(text(h.el('comparisonDetails')), /Different simulation versions/);
});
test('archive rejects mixed Baseline/Food chain comparison without fetching histories', async t => {
  const legacy = JSON.parse(await readFile(new URL('./baseline-fixture.json', import.meta.url), 'utf8'));
  const records = [legacy, savedFoodChain('00000000-0000-4000-8000-000000000002')]; const requests = [];
  const h = await browser(t, async url => { requests.push(url); return { ok: true, json: async () => ({ experiments: summaries(records), nextCursor: null }) }; });
  await selectPair(h); assert.equal(requests.length, 1); assert.equal(h.el('comparisonCharts').hidden, true);
  assert.match(text(h.el('databaseStatus')), /within one model|Baseline.*Food chain/i);
});


test('inspection survives a selected animal dying and an empty published population', async t => {
  const h = await browser(t); await h.el('world').fire('keydown', { key: 'Enter' });
  const state = structuredClone(h.module.sim); state.organisms = state.organisms.filter(a => a.id !== 1);
  h.workers[0].publish(state); await flush(); await h.el('world').fire('keydown', { key: 'ArrowRight' });
  assert.match(h.el('organismTitle').textContent, /Herbivore 2$/);
  state.organisms = []; h.workers[0].publish(state); await flush(); await h.el('world').fire('keydown', { key: 'Enter' });
  assert.match(h.el('organismTitle').textContent, /Look a little closer/);
});
test('late comparison histories cannot restore a pair that was deselected', async t => {
  const records = [savedFoodChain('00000000-0000-4000-8000-000000000001'), savedFoodChain('00000000-0000-4000-8000-000000000002')];
  const resolve = new Map(); const pending = new Map(records.map(record => [record.id, new Promise(done => resolve.set(record.id, done))]));
  const h = await browser(t, async url => url.includes('?')
    ? { ok: true, json: async () => ({ experiments: summaries(records), nextCursor: null }) }
    : { ok: true, json: async () => pending.get(url.split('/').at(-1)) });
  const boxes = archiveBoxes(h);
  boxes[0].checked = true; await boxes[0].fire('change'); boxes[1].checked = true; await boxes[1].fire('change'); await flush();
  boxes[1].checked = false; await boxes[1].fire('change');
  for (const record of records) resolve.get(record.id)(record);
  await flush(); await flush();
  assert.equal(h.el('comparison').hidden, true); assert.equal(h.el('comparisonCharts').hidden, true);
});
test('rapid duplicate Save during an in-flight request produces only one POST', async t => {
  let finishPost;
  const response = new Promise(resolve => { finishPost = resolve; });
  const h = await browser(t, async (_url, options) => options?.method === 'POST'
    ? response
    : { ok: true, json: async () => ({ experiments: [], nextCursor: null }) });
  await h.el('runButton').fire('click'); await h.el('endButton').fire('click'); h.el('experimentName').value = 'One request';
  const first = h.el('saveForm').fire('submit'); await flush(); await h.el('saveForm').fire('submit');
  assert.equal(h.posts.length, 1);
  finishPost({ ok: false, status: 503, json: async () => ({ error: 'Unavailable' }) }); await first;
  assert.match(h.el('saveStatus').textContent, /Not saved/);
});



test('BUG-007: pre-worker startup failure shows failed overlay and Reset retries without a fabricated run', async t => {
  const h = await browser(t, undefined, { startupCleanupFailure: true });
  assert.equal(h.workers.length, 0); assert.equal(h.module.sim, null);
  assert.match(h.el('overlayTitle').textContent, /failed|could not start|unavailable/i);
  assert.doesNotMatch(h.el('overlayTitle').textContent, /preparing/i);
  assert.equal(h.el('runButton').disabled, true); assert.equal(h.el('resetButton').disabled, false);
  await h.el('resetButton').fire('click');
  assert.equal(h.workers.length, 1); assert.equal(h.module.sim.status, 'ready'); assert.equal(h.module.sim.measurements.length, 0);
});

test('motion cadence: 60 animation frames must not repeat only five worker poses', async t => {
  const renderClock = { time: 0 };
  const h = await browser(t, undefined, { renderClock });
  h.el('initialHerbivores').value = '1'; h.el('initialCarnivores').value = '0';
  await h.el('runButton').fire('click');
  h.el('showTrails').checked = false;
  const worker = h.workers.at(-1);
  const poses = [];
  let framePose = null;
  h.el('world').context.arc = (x, y, radius) => { if (radius === 4 && framePose === null) framePose = [x, y]; };
  for (let frame = 0; frame < 60; frame++) {
    const time = frame * 1000 / 60;
    renderClock.time = time;
    while (worker.clock + 25 <= time) worker.advance(25);
    await flush();
    framePose = null;
    h.frame(time);
    if (framePose) poses.push(framePose.map(value => value.toFixed(5)).join(','));
  }
  const distinct = new Set(poses).size;
  const biologicalTick = worker.controller.getState().tick;
  const confirmedBeforePaint = structuredClone(h.module.sim);
  h.frame(995);
  assert.deepEqual(h.module.sim, confirmedBeforePaint, 'Additional animation must never change confirmed biology or RNG.');
  t.diagnostic(JSON.stringify({animationFrames:poses.length,distinctVisiblePoses:distinct,biologicalTick}));
  assert.ok(distinct >= 30, `Only ${distinct} distinct poses across ${poses.length} frames: visible motion is gated by worker publications.`);
});

test('interpolated pointer selection follows the visible pose, while Pause snaps to confirmed geometry', async t => {
  const renderClock = { time: 0 };
  const h = await browser(t, undefined, { renderClock });
  h.el('initialHerbivores').value = '1'; h.el('initialCarnivores').value = '0';
  await h.el('runButton').fire('click');
  const worker = h.workers.at(-1);
  const first = structuredClone(h.module.sim);
  first.organisms[0].x = 100; first.organisms[0].y = 100;
  first.tick = 4; renderClock.time = 200; worker.publish(first);
  const next = structuredClone(first);
  next.tick = 8; next.organisms[0].x = 200;
  renderClock.time = 400; worker.publish(next);
  let visible = null;
  h.el('world').context.arc = (x, y, radius) => { if (radius === 4 && visible === null) visible = [x, y]; };
  h.frame(450);
  assert.deepEqual(visible, [125, 100]);
  await h.el('world').fire('click', { clientX: visible[0], clientY: visible[1] });
  assert.match(h.el('organismTitle').textContent, /Herbivore 1/);
  const stopped = { ...next, status: 'paused' };
  worker.publish(stopped);
  visible = null; h.frame(500);
  assert.deepEqual(visible, [200, 100]);
  assert.equal(h.module.sim.organisms[0].x, 200);
});

test('saved deletion confirms permanently, accepts empty 204, refreshes archive and preserves the live run', async t => {
  const records=[savedFoodChain('00000000-0000-4000-8000-000000000001'),savedFoodChain('00000000-0000-4000-8000-000000000002')];
  let remaining=[...records]; const deleted=[]; const requests=[];
  const h=await browser(t,async(url,options)=>{
    requests.push([url,options?.method||'GET']);
    if(options?.method==='DELETE'){deleted.push(url.split('/').at(-1));remaining=remaining.filter(record=>record.id!==deleted.at(-1));return{ok:true,status:204,json:async()=>{throw new Error('204 has no JSON body');}};}
    return{ok:true,json:async()=>({experiments:summaries(remaining),nextCursor:null})};
  });
  await h.el('runButton').fire('click');const before=snapshot(h.module.sim);
  let confirmation='';h.window.confirm=question=>{confirmation=question;return true;};
  const button=deleteButton(h,records[0].id);
  const containingLabel=findElement(h.el('experimentList'),element=>element.tagName==='LABEL'&&findElement(element,child=>child===button));
  assert.equal(containingLabel,undefined,'Delete must not be nested inside the comparison label.');
  await button.fire('click');
  assert.match(confirmation,/permanent|cannot be undone/i);assert.ok(confirmation.includes(records[0].name));
  assert.deepEqual(deleted,[records[0].id]);assert.equal(h.el('experimentList').children.length,1);
  assert.equal(h.el('archiveCount').textContent,'1');assert.equal(h.el('loadMoreExperiments').hidden,true);
  assert.deepEqual(snapshot(h.module.sim),before);assert.equal(h.workers.length,1);
  assert.equal(requests.filter(([,method])=>method==='GET').length,2);
});

test('saved deletion cancellation sends no request and retains selection', async t => {
  const records=[savedFoodChain('00000000-0000-4000-8000-000000000001')];let deletes=0;
  const h=await browser(t,async(_url,options)=>{if(options?.method==='DELETE')deletes++;return{ok:true,json:async()=>({experiments:summaries(records),nextCursor:null})};});
  const checkbox=archiveBoxes(h)[0];checkbox.checked=true;await checkbox.fire('change');
  h.window.confirm=()=>false;await deleteButton(h,records[0].id).fire('click');
  assert.equal(deletes,0);assert.equal(h.el('experimentList').children.length,1);assert.equal(archiveBoxes(h)[0].checked,true);
});

test('failed saved deletion retains its row and completed comparison', async t => {
  const records=[savedFoodChain('00000000-0000-4000-8000-000000000001'),savedFoodChain('00000000-0000-4000-8000-000000000002')];
  const h=await browser(t,async(url,options)=>options?.method==='DELETE'?{ok:false,status:503,json:async()=>({error:'Storage unavailable'})}:{ok:true,json:async()=>url.includes('?')?{experiments:summaries(records),nextCursor:null}:records.find(record=>url.endsWith(record.id))});
  await selectPair(h);const comparison=text(h.el('comparisonDetails'));
  h.window.confirm=()=>true;await deleteButton(h,records[0].id).fire('click');
  assert.equal(h.el('experimentList').children.length,2);assert.equal(h.el('comparisonCharts').hidden,false);
  assert.equal(text(h.el('comparisonDetails')),comparison);assert.match(h.el('databaseStatus').textContent,/could not confirm deletion/i);
  assert.equal(deleteButton(h,records[0].id).disabled,false);
});

test('rapid duplicate saved deletion sends one request while its button is disabled', async t => {
  const record=savedFoodChain('00000000-0000-4000-8000-000000000001');let done;let deletes=0;let removed=false;
  const pending=new Promise(resolve=>{done=resolve;});
  const h=await browser(t,async(_url,options)=>{if(options?.method==='DELETE'){deletes++;return pending;}return{ok:true,json:async()=>({experiments:removed?[]:summaries([record]),nextCursor:null})};});
  h.window.confirm=()=>true;const button=deleteButton(h,record.id);const first=button.fire('click');await flush();
  assert.equal(button.disabled,true);await button.fire('click');assert.equal(deletes,1);
  removed=true;done({ok:true,status:204,json:async()=>({})});await first;
  assert.equal(h.el('experimentList').children.length,0);
});

test('saved deletion treats 404 as absent and stale list/detail responses cannot resurrect it', async t => {
  const records=[savedFoodChain('00000000-0000-4000-8000-000000000001'),savedFoodChain('00000000-0000-4000-8000-000000000002')];
  let listCalls=0,resolveList;const resolvers=new Map();const detailPromises=new Map(records.map(record=>[record.id,new Promise(resolve=>resolvers.set(record.id,resolve))]));
  const oldList=new Promise(resolve=>{resolveList=resolve;});
  const h=await browser(t,async(url,options)=>{
    if(options?.method==='DELETE')return{ok:false,status:404,json:async()=>({error:'Not found'})};
    if(url.includes('?')){listCalls++;if(listCalls===2)return oldList;return{ok:true,json:async()=>({experiments:summaries(listCalls>2?records.slice(1):records),nextCursor:null})};}
    return{ok:true,json:async()=>detailPromises.get(url.split('/').at(-1))};
  });
  await selectPair(h);const refreshing=h.el('refreshExperiments').fire('click');await flush();
  h.window.confirm=()=>true;await deleteButton(h,records[0].id).fire('click');
  resolveList({ok:true,json:async()=>({experiments:summaries(records),nextCursor:'stale'})});
  for(const record of records)resolvers.get(record.id)(record);
  await refreshing;await flush();await flush();
  assert.equal(h.el('experimentList').children.length,1);assert.equal(h.el('comparison').hidden,true);
  assert.equal(h.el('comparisonCharts').hidden,true);assert.equal(h.el('loadMoreExperiments').hidden,true);
  assert.equal(h.el('archiveCount').textContent,'1');
});

test('deleting the current saved result preserves JSON and cannot silently recreate its record', async t => {
  let record=null,removed=false,posts=0;
  const h=await browser(t,async(_url,options)=>{
    if(options?.method==='POST'){posts++;record=JSON.parse(options.body);return{ok:true,json:async()=>({experiment:record})};}
    if(options?.method==='DELETE'){removed=true;return{ok:true,status:204,json:async()=>({})};}
    return{ok:true,json:async()=>({experiments:record&&!removed?summaries([record]):[],nextCursor:null})};
  });
  await h.el('runButton').fire('click');await h.el('endButton').fire('click');h.el('experimentName').value='Keep a local copy';await h.el('saveForm').fire('submit');
  const before=snapshot(h.module.sim);h.window.confirm=()=>true;await deleteButton(h,record.id).fire('click');
  assert.equal(h.el('saveButton').disabled,true);assert.match(h.el('saveStatus').textContent,/deleted/i);
  await h.el('saveForm').fire('submit');assert.equal(posts,1);
  assert.equal(h.el('downloadButton').disabled,false);await h.el('downloadButton').fire('click');
  assert.deepEqual(JSON.parse(await h.downloads.at(-1).text()),record);assert.deepEqual(snapshot(h.module.sim),before);
});

test('same-page Save and Delete cannot overlap for the same frozen record ID', async t => {
  let record=null,postCount=0,deleteCount=0,confirmCount=0,finishPost,finishDelete;
  const posting=new Promise(resolve=>{finishPost=resolve;});
  const deleting=new Promise(resolve=>{finishDelete=resolve;});
  const h=await browser(t,async(_url,options)=>{
    if(options?.method==='POST'){
      postCount++;record=JSON.parse(options.body);
      return postCount===1?{ok:false,status:503,json:async()=>({error:'Lost response'})}:posting;
    }
    if(options?.method==='DELETE'){deleteCount++;return deleting;}
    return{ok:true,json:async()=>({experiments:record?summaries([record]):[],nextCursor:null})};
  });
  await h.el('runButton').fire('click');await h.el('endButton').fire('click');h.el('experimentName').value='Guard shared ID';
  await h.el('saveForm').fire('submit');await h.el('refreshExperiments').fire('click');
  h.window.confirm=()=>{confirmCount++;return true;};
  const saving=h.el('saveForm').fire('submit');await flush();
  const button=deleteButton(h,record.id);assert.equal(button.disabled,true);await button.fire('click');
  assert.equal(deleteCount,0);assert.equal(confirmCount,0);
  finishPost({ok:false,status:503,json:async()=>({error:'Still unavailable'})});await saving;
  const removing=button.fire('click');await flush();
  assert.equal(deleteCount,1);assert.equal(confirmCount,1);
  await h.el('saveForm').fire('submit');assert.equal(postCount,2);
  record=null;finishDelete({ok:true,status:204,json:async()=>({})});await removing;
  assert.equal(h.el('experimentList').children.length,0);assert.equal(h.el('saveButton').disabled,true);
});

const ownerState=(authenticated=false,configured=true)=>({mode:'owner',authenticated,configured,csrfToken:authenticated?'test-csrf-token':null});
const authResponse=state=>({ok:true,status:200,json:async()=>state});

test('owner guest runs and downloads JSON without fetching private archives or freezing a save record',async t=>{
  const storage=[];
  const h=await browser(t,async(url,options)=>{storage.push([url,options]);return authResponse({experiments:[],nextCursor:null});},{authHandler:async()=>authResponse(ownerState())});
  assert.equal(storage.length,0);assert.equal(h.el('ownerLoginForm').hidden,false);
  await h.el('runButton').fire('click');await h.el('endButton').fire('click');
  h.el('experimentName').value='Public run';await h.el('saveForm').fire('submit');
  assert.equal(storage.length,0);assert.equal(h.el('experimentName').disabled,false);assert.match(h.el('saveStatus').textContent,/sign in/i);
  await h.el('downloadButton').fire('click');const record=JSON.parse(await h.downloads[0].text());
  assert.equal(record.name,'Public run');assert.equal(h.el('experimentName').disabled,false);
  await h.el('refreshExperiments').fire('click');assert.equal(storage.length,0);
});

test('owner login clears its password and uses same-origin credentials and CSRF for private writes and logout',async t=>{
  let authenticated=false;let record=null;const authCalls=[],storage=[];
  const h=await browser(t,async(url,options)=>{
    storage.push([url,options]);
    if(options?.method==='POST'){record=JSON.parse(options.body);return authResponse({experiment:record});}
    return authResponse({experiments:record?summaries([record]):[],nextCursor:null});
  },{authHandler:async(url,options)=>{
    authCalls.push([url,options]);if(url.endsWith('/login'))authenticated=true;if(url.endsWith('/logout'))authenticated=false;
    return authResponse(ownerState(authenticated));
  }});
  h.el('ownerPassword').value='example-test-password';await h.el('ownerLoginForm').fire('submit');
  assert.equal(h.el('ownerPassword').value,'');assert.equal(h.el('ownerLogoutButton').hidden,false);
  const login=authCalls.find(([url])=>url.endsWith('/login'))[1];assert.equal(login.credentials,'same-origin');assert.deepEqual(JSON.parse(login.body),{password:'example-test-password'});
  await h.el('runButton').fire('click');await h.el('endButton').fire('click');h.el('experimentName').value='Owner result';await h.el('saveForm').fire('submit');
  const post=storage.find(([,options])=>options?.method==='POST')[1];assert.equal(post.credentials,'same-origin');assert.equal(post.headers['X-CSRF-Token'],'test-csrf-token');
  const before=snapshot(h.module.sim);await h.el('ownerLogoutButton').fire('click');
  const logout=authCalls.find(([url])=>url.endsWith('/logout'))[1];assert.equal(logout.headers['X-CSRF-Token'],'test-csrf-token');assert.equal(logout.credentials,'same-origin');
  assert.equal(h.el('experimentList').children.length,0);assert.equal(h.el('archiveCount').textContent,'0');assert.equal(h.el('comparison').hidden,true);
  assert.deepEqual(snapshot(h.module.sim),before);await h.el('downloadButton').fire('click');assert.deepEqual(JSON.parse(await h.downloads.at(-1).text()),record);
});

test('invalid password, rate limit and unconfigured owner login stay private and clear the password',async t=>{
  let status=401,loginCalls=0;const storage=[];
  const h=await browser(t,async url=>{storage.push(url);return authResponse({experiments:[]});},{authHandler:async(url)=>{
    if(url.endsWith('/session'))return authResponse(ownerState());loginCalls++;return{ok:false,status,json:async()=>({error:'Rejected'})};
  }});
  for(const [code,pattern]of [[401,/not accepted/i],[429,/too many/i],[503,/not configured/i]]){
    status=code;h.el('ownerPassword').value='wrong-test-password';await h.el('ownerLoginForm').fire('submit');
    assert.equal(h.el('ownerPassword').value,'');assert.match(h.el('authStatus').textContent,pattern);
  }
  assert.equal(storage.length,0);assert.equal(h.el('ownerLoginButton').disabled,true);
  h.el('ownerPassword').value='unused';await h.el('ownerLoginForm').fire('submit');assert.equal(loginCalls,3);assert.equal(h.el('ownerPassword').value,'');
});

test('missing preview session endpoints and access-fetch failure never fall back to private local access',async t=>{
  for(const status of [404,503,'network'])await t.test(String(status),async t=>{
    const storage=[];
    const h=await browser(t,async url=>{storage.push(url);return authResponse({experiments:[]});},{authHandler:async()=>{
      if(status==='network')throw new Error('Offline');return{ok:false,status,json:async()=>({error:'Unavailable'})};
    }});
    assert.equal(storage.length,0);assert.equal(h.el('ownerLoginButton').disabled,true);assert.equal(h.el('refreshExperiments').disabled,true);
    assert.match(h.el('databaseStatus').textContent,status==='network'?/could not be verified/i:/public preview/i);
    await h.el('runButton').fire('click');await h.el('endButton').fire('click');h.el('experimentName').value='Preview';await h.el('downloadButton').fire('click');assert.equal(h.downloads.length,1);
  });
});

test('session expiry clears private histories and canvases while preserving the current simulation',async t=>{
  const records=[savedFoodChain('00000000-0000-4000-8000-000000000001'),savedFoodChain('00000000-0000-4000-8000-000000000002')];let expired=false;
  const h=await browser(t,async url=>expired?{ok:false,status:401,json:async()=>({error:'Expired'})}:authResponse(url.includes('?')?{experiments:summaries(records),nextCursor:null}:records.find(record=>url.endsWith(record.id))),{authHandler:async()=>authResponse(ownerState(true))});
  await selectPair(h);assert.equal(h.el('comparisonCharts').hidden,false);const clears=h.el('comparePopulation').clears;
  await h.el('runButton').fire('click');const before=snapshot(h.module.sim);expired=true;await h.el('refreshExperiments').fire('click');
  assert.equal(h.el('experimentList').children.length,0);assert.equal(h.el('comparison').hidden,true);assert.equal(text(h.el('comparisonDetails')).trim(),'');
  assert.ok(h.el('comparePopulation').clears>clears);assert.match(h.el('authStatus').textContent,/session ended/i);assert.deepEqual(snapshot(h.module.sim),before);
});

test('logout fences late archive and comparison responses so private records cannot reappear',async t=>{
  const records=[savedFoodChain('00000000-0000-4000-8000-000000000001'),savedFoodChain('00000000-0000-4000-8000-000000000002')];let listCalls=0,finishList;
  const listPending=new Promise(resolve=>{finishList=resolve;});const finishDetails=new Map();
  const details=new Map(records.map(record=>[record.id,new Promise(resolve=>finishDetails.set(record.id,resolve))]));
  const h=await browser(t,async url=>{
    if(url.includes('?')){listCalls++;return listCalls===1?authResponse({experiments:summaries(records),nextCursor:null}):listPending;}
    return{ok:true,json:async()=>details.get(url.split('/').at(-1))};
  },{authHandler:async url=>authResponse(ownerState(!url.endsWith('/logout')))});
  await selectPair(h);const refresh=h.el('refreshExperiments').fire('click');await flush();
  await h.el('ownerLogoutButton').fire('click');finishList(authResponse({experiments:summaries(records),nextCursor:'old'}));
  for(const record of records)finishDetails.get(record.id)(record);
  await refresh;await flush();await flush();
  assert.equal(h.el('experimentList').children.length,0);assert.equal(h.el('archiveCount').textContent,'0');assert.equal(h.el('comparison').hidden,true);assert.equal(h.el('loadMoreExperiments').hidden,true);
  assert.equal(text(h.el('comparisonDetails')).trim(),'');
});

test('logout fences a late save acknowledgement but retains the exact frozen JSON for retry',async t=>{
  let finishSave;const pending=new Promise(resolve=>{finishSave=resolve;});let posted;
  const h=await browser(t,async(_url,options)=>{if(options?.method==='POST'){posted=JSON.parse(options.body);return pending;}return authResponse({experiments:[],nextCursor:null});},{authHandler:async url=>authResponse(ownerState(!url.endsWith('/logout')))});
  await h.el('runButton').fire('click');await h.el('endButton').fire('click');h.el('experimentName').value='Keep this public result';
  const saving=h.el('saveForm').fire('submit');await flush();await h.el('ownerLogoutButton').fire('click');
  finishSave(authResponse({experiment:posted}));await saving;
  assert.equal(h.el('experimentList').children.length,0);assert.match(h.el('saveButton').textContent,/sign-in required/i);assert.doesNotMatch(h.el('saveStatus').textContent,/saving to/i);
  await h.el('downloadButton').fire('click');assert.deepEqual(JSON.parse(await h.downloads.at(-1).text()),posted);
});

test('unconfirmed server logout remains guest until an explicit successful retry',async t=>{
  let logoutCalls=0;const storage=[];
  const h=await browser(t,async url=>{storage.push(url);return authResponse({experiments:[],nextCursor:null});},{authHandler:async url=>{
    if(url.endsWith('/logout')){logoutCalls++;return logoutCalls===1?{ok:false,status:503,json:async()=>({})}:authResponse(ownerState());}
    return authResponse(ownerState(true));
  }});
  await h.el('ownerLogoutButton').fire('click');const count=storage.length;assert.match(h.el('authStatus').textContent,/could not be confirmed/i);
  await h.el('authRefreshButton').fire('click');assert.equal(storage.length,count);assert.match(h.el('ownerLogoutButton').textContent,/retry/i);
  await h.el('ownerLogoutButton').fire('click');assert.equal(logoutCalls,2);assert.equal(h.el('ownerLogoutButton').hidden,true);assert.match(h.el('authStatus').textContent,/signed out/i);
});

test('owner DELETE sends CSRF and a late response after logout cannot restore archive state',async t=>{
  const record=savedFoodChain('00000000-0000-4000-8000-000000000001');let finishDelete,deleteOptions;
  const pending=new Promise(resolve=>{finishDelete=resolve;});
  const h=await browser(t,async(_url,options)=>{
    if(options?.method==='DELETE'){deleteOptions=options;return pending;}
    return authResponse({experiments:summaries([record]),nextCursor:null});
  },{authHandler:async url=>authResponse(ownerState(!url.endsWith('/logout')))});
  await h.el('runButton').fire('click');const before=snapshot(h.module.sim);h.window.confirm=()=>true;
  const deleting=deleteButton(h,record.id).fire('click');await flush();
  assert.equal(deleteOptions.credentials,'same-origin');assert.equal(deleteOptions.headers['X-CSRF-Token'],'test-csrf-token');
  await h.el('ownerLogoutButton').fire('click');finishDelete({ok:true,status:204,json:async()=>({})});await deleting;
  assert.equal(h.el('experimentList').children.length,0);assert.equal(h.el('archiveCount').textContent,'0');
  assert.match(h.el('databaseStatus').textContent,/sign in/i);assert.deepEqual(snapshot(h.module.sim),before);
});

test('403 expires access and a focus session check detects expiry without mutating the run',async t=>{
  const record=savedFoodChain('00000000-0000-4000-8000-000000000001');let forbidden=false,authenticated=true;
  const h=await browser(t,async()=>forbidden?{ok:false,status:403,json:async()=>({error:'CSRF expired'})}:authResponse({experiments:summaries([record]),nextCursor:null}),{authHandler:async()=>authResponse(ownerState(authenticated))});
  const before=snapshot(h.module.sim);forbidden=true;await h.el('refreshExperiments').fire('click');
  assert.equal(h.el('experimentList').children.length,0);assert.match(h.el('authStatus').textContent,/session ended/i);
  forbidden=false;authenticated=true;await h.el('authRefreshButton').fire('click');await flush();await flush();assert.equal(h.el('experimentList').children.length,1);
  authenticated=false;await h.window.fire('focus');await flush();await flush();
  assert.equal(h.el('experimentList').children.length,0);assert.equal(h.el('ownerLogoutButton').hidden,true);assert.deepEqual(snapshot(h.module.sim),before);
});

test('slow private archive loading never prevents an authenticated owner from signing out',async t=>{
  let finishArchive;const archive=new Promise(resolve=>{finishArchive=resolve;});
  const h=await browser(t,async()=>archive,{authHandler:async url=>authResponse(ownerState(!url.endsWith('/logout')))});
  assert.equal(h.el('ownerLogoutButton').disabled,false);await h.el('ownerLogoutButton').fire('click');
  finishArchive(authResponse({experiments:summaries([savedFoodChain('00000000-0000-4000-8000-000000000001')]),nextCursor:null}));await flush();await flush();
  assert.equal(h.el('experimentList').children.length,0);assert.equal(h.el('ownerLogoutButton').hidden,true);
});

test('contradictory local and guest session payloads fail closed without archive requests',async t=>{
  for(const session of [
    {mode:'local',authenticated:false,configured:false,csrfToken:null},
    {mode:'local',authenticated:true,configured:false,csrfToken:null},
    {mode:'local',authenticated:true,configured:true,csrfToken:'unexpected'},
    {mode:'owner',authenticated:false,configured:true,csrfToken:'unexpected'},
  ])await t.test(JSON.stringify(session),async t=>{
    const storage=[];const h=await browser(t,async url=>{storage.push(url);return authResponse({experiments:[]});},{authHandler:async()=>authResponse(session)});
    assert.equal(storage.length,0);assert.equal(h.el('refreshExperiments').disabled,true);assert.match(h.el('authStatus').textContent,/could not be verified/i);
  });
});

test('returning from the browser back-forward cache rechecks access before private data can return',async t=>{
  const record=savedFoodChain('00000000-0000-4000-8000-000000000001');let authenticated=true,archiveCalls=0,sessionCalls=0;
  const h=await browser(t,async()=>{archiveCalls++;return authResponse({experiments:summaries([record]),nextCursor:null});},{authHandler:async()=>{sessionCalls++;return authResponse(ownerState(authenticated));}});
  assert.equal(h.el('experimentList').children.length,1);const before=snapshot(h.module.sim);
  await h.window.fire('pagehide');assert.equal(h.el('experimentList').children.length,0);
  authenticated=false;await h.window.fire('pageshow',{persisted:true});await flush();await flush();
  assert.equal(sessionCalls,2);assert.equal(archiveCalls,1);assert.equal(h.el('experimentList').children.length,0);
  assert.equal(h.el('ownerLoginForm').hidden,false);assert.deepEqual(snapshot(h.module.sim),before);
});

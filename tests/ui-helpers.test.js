import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { nextOrganismId, downsampleMeasurements, recordModelType, canCompareRecords, SnapshotInterpolator } from '../public/ui-helpers.js';

test('display downsampling bounds a long history while retaining spikes, gaps, endpoints, and raw records', () => {
  const samples=Array.from({length:100000},(_,i)=>({tick:i,time:i/20,population:10,sd:1}));
  samples[50003].population=1000; samples[60003].population=null;
  const before=structuredClone(samples);
  const display=downsampleMeasurements(samples,'population','sd',600);
  assert.ok(display.length<=600); assert.equal(display[0],samples[0]); assert.equal(display.at(-1),samples.at(-1));
  assert.ok(display.includes(samples[50003])); assert.ok(display.some(s=>s.population===null));
  assert.deepEqual(samples,before);
});

test('keyboard selection uses sorted IDs and handles wrap, stale ID and empty worlds', () => {
  const organisms=[{id:8},{id:2},{id:5}];
  assert.equal(nextOrganismId(organisms,null,'Enter'),2);
  assert.equal(nextOrganismId(organisms,8,'ArrowRight'),2);
  assert.equal(nextOrganismId(organisms,2,'ArrowLeft'),8);
  assert.equal(nextOrganismId(organisms,4,'ArrowRight'),5);
  assert.equal(nextOrganismId([],8,'Enter'),null);
});

test('world aspect ratio remains 5/3 at every declared CSS breakpoint', async () => {
  const css=await readFile(new URL('../public/styles.css',import.meta.url),'utf8');
  const blocks=[...css.matchAll(/\.world-frame\s*\{([^}]+)\}/g)].map(m=>m[1]);
  assert.ok(blocks.length>0);
  for (const block of blocks) {
    const ratio=block.match(/aspect-ratio:\s*([^;}]+)/)?.[1]?.trim();
    if (ratio) assert.equal(ratio,'5/3');
  }
});


test('legacy records infer Baseline without inventing food-chain history', () => {
  const legacy = { id: 'old', measurements: [{ food: 120, population: 40 }] };
  const before = structuredClone(legacy);
  assert.equal(recordModelType(legacy), 'baseline');
  assert.deepEqual(legacy, before); assert.equal(Object.hasOwn(legacy.measurements[0], 'carnivores'), false);
});
test('comparison permits same models and warns about versions separately', () => {
  assert.equal(canCompareRecords({ version: 'old' }, { modelType: 'baseline', version: 'new' }), true);
  assert.equal(canCompareRecords({ modelType: 'food-chain', version: '1' }, { modelType: 'food-chain', version: '2' }), true);
  assert.equal(canCompareRecords({ modelType: 'food-chain' }, {}), false);
});

const motionState = (tick, organisms, status = 'running') => ({ tick, status, settings: { width: 1000, height: 600 }, organisms });
test('confirmed snapshot interpolation takes the short wrapped path, clamps, and leaves biology untouched', () => {
  const motion = new SnapshotInterpolator();
  const first = motionState(0, [{ id: 1, x: 998, y: 598 }]);
  const second = motionState(4, [{ id: 1, x: 6, y: 6 }]);
  const originals = structuredClone([first, second]);
  motion.accept(first, 0); motion.accept(second, 200);
  assert.deepEqual(motion.positions(second, 300).get(1), { x: 2, y: 2 });
  assert.deepEqual(motion.positions(second, 100).get(1), { x: 998, y: 598 });
  assert.deepEqual(motion.positions(second, 2000).get(1), { x: 6, y: 6 });
  assert.deepEqual([first, second], originals);
});
test('same-tick acknowledgements do not reset interpolation and current identities prevent birth/death ghosts', () => {
  const motion = new SnapshotInterpolator();
  motion.accept(motionState(0, [{ id: 1, x: 0, y: 0 }, { id: 9, x: 500, y: 500 }]), 0);
  const state = motionState(4, [{ id: 1, x: 20, y: 20 }, { id: 2, x: 50, y: 50 }]);
  motion.accept(state, 200);
  motion.accept(structuredClone(state), 250);
  const positions = motion.positions(state, 300);
  assert.deepEqual(positions.get(1), { x: 10, y: 10 });
  assert.deepEqual(positions.get(2), { x: 50, y: 50 });
  assert.equal(positions.has(9), false);
});
test('pause, end, failure, reset and reduced motion display confirmed positions immediately', () => {
  const motion = new SnapshotInterpolator();
  const first = motionState(0, [{ id: 1, x: 0, y: 0 }]);
  const current = motionState(4, [{ id: 1, x: 20, y: 20 }]);
  motion.accept(first, 0); motion.accept(current, 200);
  assert.deepEqual(motion.positions(current, 300, true).get(1), { x: 20, y: 20 });
  for (const status of ['paused', 'ended', 'error', 'ready']) {
    const stopped = { ...current, status };
    motion.accept(stopped, 300);
    assert.deepEqual(motion.positions(stopped, 300).get(1), { x: 20, y: 20 });
  }
  motion.reset(); motion.accept(first, 400);
  assert.deepEqual(motion.positions(first, 450).get(1), { x: 0, y: 0 });
  assert.equal(motion.positions({ ...current, recoveryOnly: true, organisms: [] }, 450).size, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULTS, MODEL_TYPE, VERSION, RAINFALL, createSimulation, start, pause, resume, step, end, reset,
  setRainfall, snapshot, toExperiment, decideMovement, applyMovement, processMovement,
  chargeAndCull, resolveCaptures, feedHerbivores, reproduce, spawnFood, measure,
  toroidalDelta, distance,
} from '../public/simulation.js';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) <= 1e-9, `${actual} should equal ${expected}`);
const animal = (values = {}) => ({ id: 1, category: 'herbivore', x: 100, y: 100, heading: 0, ageTicks: 0,
  energy: 60, speed: 40, sensingRadius: 70, lineageDepth: 0, lastReproductionTick: null,
  offspringCount: 0, fleeing: false, ...values });
const plant = (id, x, y) => ({ id, x, y });
function fixture(animals = [animal()], plants = [], overrides = {}) {
  const sim = createSimulation({ seed: 42,
    initialHerbivores: animals.filter(a => a.category === 'herbivore').length,
    initialCarnivores: animals.filter(a => a.category === 'carnivore').length,
    initialFood: plants.length, ...overrides });
  sim.organisms = animals; sim.food = plants;
  sim.nextOrganismId = Math.max(0, ...animals.map(a => a.id)) + 1;
  sim.nextFoodId = Math.max(0, ...plants.map(p => p.id)) + 1;
  return sim;
}
function draws(values) { let i = 0; return () => { assert.ok(i < values.length, 'Unexpected random draw'); return values[i++]; }; }
const runTicks = (sim, count) => { for (let i = 0; i < count; i++) step(sim); };
function move(sim, random) { const intents = decideMovement(sim, random); applyMovement(sim, intents); return intents; }

// These fixtures exercise actual food-chain phases; they are not legacy sequential-movement claims.
test('default initialization has inherited categories, approved traits and unique IDs', () => {
  const sim = createSimulation({ seed: 0 });
  assert.equal(MODEL_TYPE, 'food-chain'); assert.equal(VERSION, 'evoworld-food-chain-1');
  assert.equal(sim.organisms.filter(a => a.category === 'herbivore').length, 40);
  assert.equal(sim.organisms.filter(a => a.category === 'carnivore').length, 6);
  assert.equal(sim.food.length, 120);
  assert.deepEqual(sim.organisms.map(a => a.id), Array.from({ length: 46 }, (_, i) => i + 1));
  for (const a of sim.organisms) {
    assert.equal(a.offspringCount, 0);
    const herb = a.category === 'herbivore';
    assert.ok(a.speed >= (herb ? 35 : 40) && a.speed <= (herb ? 45 : 50));
    assert.ok(a.sensingRadius >= (herb ? 60 : 100) && a.sensingRadius <= (herb ? 80 : 120));
    assert.equal(a.energy, herb ? 60 : 80);
  }
});
test('herbivore detects nearest plant, ties by ID, and moves two units', () => {
  const sim = fixture([animal()], [plant(2, 120, 100), plant(1, 100, 120)]);
  move(sim); near(sim.organisms[0].x, 100); near(sim.organisms[0].y, 102);
});
test('inclusive sensing boundary and wrapped corner geometry are honored', () => {
  const sim = fixture([animal({ x: 999, y: 599 })], [plant(1, 1, 1)]);
  near(distance(sim.organisms[0], sim.food[0], DEFAULTS), Math.sqrt(8));
  near(toroidalDelta(0, 500, 1000), -500);
  const inside = fixture([animal()], [plant(1, 100, 170)]); move(inside);
  near(inside.organisms[0].y, 102);
  const outside = fixture([animal()], [plant(1, 100, 170.01)]); move(outside);
  near(outside.organisms[0].x, 102); near(outside.organisms[0].y, 100);
});
test('prey flees from nearest sensed predator even if predator is already fed', () => {
  const sim = fixture([animal(), animal({ id: 2, category: 'carnivore', x: 110, energy: 100 })], [plant(1, 100, 100)]);
  processMovement(sim); const prey = sim.organisms.find(a => a.id === 1);
  near(prey.x, 98); assert.equal(prey.fleeing, true);
  feedHerbivores(sim, [prey]); assert.equal(prey.energy, 60); assert.equal(sim.food.length, 1);
});
test('equal-distance threats use lower predator ID rather than array order', () => {
  const sim = fixture([animal(), animal({ id: 3, category: 'carnivore', x: 110 }), animal({ id: 2, category: 'carnivore', x: 90 })]);
  move(sim); near(sim.organisms[0].x, 102);
});
test('exact prey/predator overlap consumes a controlled seeded escape angle', () => {
  const sim = fixture([animal(), animal({ id: 2, category: 'carnivore', energy: 100 })]);
  move(sim, draws([0.25])); near(sim.organisms[0].x, 100); near(sim.organisms[0].y, 102);
});
test('all movement intents come from one immutable snapshot', () => {
  const sim = fixture([animal({ x: 110 }), animal({ id: 2, category: 'carnivore', energy: 80 })]);
  const before = snapshot(sim); const intents = decideMovement(sim);
  assert.deepEqual(sim.organisms, before.organisms, 'Intent calculation must not move live animals');
  applyMovement(sim, intents);
  near(sim.organisms.find(a => a.id === 1).x, 112);
  near(sim.organisms.find(a => a.id === 2).x, 102);
});
test('hungry predators pursue prey; energy at reproductive threshold wanders', () => {
  const hungry = fixture([animal({ x: 100, y: 130 }), animal({ id: 2, category: 'carnivore', energy: 89 })]);
  move(hungry); near(hungry.organisms[1].y, 102);
  const fed = fixture([animal({ x: 100, y: 130 }), animal({ id: 2, category: 'carnivore', energy: 90 })]);
  move(fed); near(fed.organisms[1].x, 102); near(fed.organisms[1].y, 100);
});
test('category maintenance multipliers are exact and precede feeding', () => {
  const sim = fixture([animal(), animal({ id: 2, category: 'carnivore', energy: 80 })]);
  chargeAndCull(sim); near(sim.organisms[0].energy, 59.925); near(sim.organisms[1].energy, 79.90625);
});
test('zero energy dies before food/capture; age wins a simultaneous death', () => {
  const sim = fixture([animal({ energy: 0.075 }), animal({ id: 2, category: 'carnivore', ageTicks: 3599, energy: 0.01 })], [plant(1, 100, 100)]);
  chargeAndCull(sim); assert.equal(sim.organisms.length, 0);
  assert.deepEqual(sim.deaths, { energy: 1, age: 1, predation: 0 }); assert.equal(sim.food.length, 1);
});
test('capture transfers 80 percent of prey remaining energy, with energy cap', () => {
  const prey = animal({ energy: 25 }); const predator = animal({ id: 2, category: 'carnivore', energy: 10 });
  const sim = fixture([prey, predator]); resolveCaptures(sim, [predator]);
  assert.equal(sim.organisms.length, 1); near(predator.energy, 30);
  assert.equal(sim.deaths.predation, 1); assert.equal(sim.categoryCounts.herbivore.deathsPredation, 1);
  assert.equal(sim.categoryCounts.carnivore.deathsPredation, 0);
  const cappedPrey = animal({ energy: 100 }); const cappedPredator = animal({ id: 2, category: 'carnivore', energy: 89 });
  const capped = fixture([cappedPrey, cappedPredator]); resolveCaptures(capped, [cappedPredator]); assert.equal(cappedPredator.energy, 120);
});
test('full tick capture energy uses post-maintenance prey energy', () => {
  const sim = fixture([animal({ energy: 25 }), animal({ id: 2, category: 'carnivore', energy: 10 })]);
  start(sim); step(sim);
  const predator = sim.organisms.find(a => a.category === 'carnivore');
  near(predator.energy, 10 - 0.09375 + 0.8 * (25 - 0.075));
  assert.equal(sim.organisms.length, 1);
});
test('contested prey is captured once; predator consumes no more than one prey', () => {
  const prey = animal(); const first = animal({ id: 2, category: 'carnivore', energy: 10 }); const second = animal({ id: 3, category: 'carnivore', energy: 10 });
  const sim = fixture([prey, first, second]); resolveCaptures(sim, [second, first]);
  assert.equal(sim.deaths.predation, 1); near(second.energy, 58); near(first.energy, 10);
  const a = animal({ id: 1 }); const b = animal({ id: 2 }); const hunter = animal({ id: 3, category: 'carnivore', energy: 10 });
  const one = fixture([a, b, hunter]); resolveCaptures(one, [hunter]); assert.equal(one.deaths.predation, 1);
});
test('capture chooses nearest endpoint prey with lowest-ID ties, including wrapped contact', () => {
  const predator = animal({ id: 4, category: 'carnivore', x: 999, energy: 10 });
  const sim = fixture([animal({ id: 2, x: 1 }), animal({ id: 1, x: 997 }), predator]);
  resolveCaptures(sim, [predator]); assert.equal(sim.organisms.some(a => a.id === 1), false); assert.equal(sim.organisms.some(a => a.id === 2), true);
});
test('predator at threshold cannot capture and carnivores never eat plants', () => {
  const predator = animal({ id: 2, category: 'carnivore', energy: 90 });
  const sim = fixture([animal(), predator], [plant(1, 100, 100)]);
  resolveCaptures(sim, [predator]); assert.equal(sim.organisms.length, 2);
  feedHerbivores(sim, [predator]); assert.equal(sim.food.length, 1); assert.equal(predator.energy, 90);
});
test('captured herbivores cannot feed or reproduce through stale phase arrays', () => {
  const prey = animal({ energy: 100, ageTicks: 200 }); const predator = animal({ id: 2, category: 'carnivore', energy: 10 });
  const sim = fixture([prey, predator], [plant(1, 100, 100)]);
  resolveCaptures(sim, [predator]); feedHerbivores(sim, [prey]); reproduce(sim, [prey], draws([]), 200);
  assert.equal(sim.food.length, 1); assert.equal(sim.births, 0);
});
test('plant contact feeds once, caps energy and honors seeded competition', () => {
  const first = animal({ energy: 110 }); const second = animal({ id: 2 });
  const sim = fixture([first, second], [plant(1, 106, 100), plant(2, 100, 106)]);
  feedHerbivores(sim, [second]); assert.equal(second.energy, 85); assert.equal(sim.food.length, 1);
  feedHerbivores(sim, [first]); assert.equal(first.energy, 120); assert.equal(sim.food.length, 0);
});
test('reproduction transfers energy, inherits category, clamps mutations and counts offspring', () => {
  const parent = animal({ category: 'carnivore', x: 998, speed: 79, sensingRadius: 22, energy: 90, ageTicks: 200, lineageDepth: 2 });
  const sim = fixture([parent]); reproduce(sim, [parent], draws([0, 1, 0]), 200);
  const child = sim.organisms[1]; assert.equal(parent.energy, 50); assert.equal(child.energy, 35);
  assert.equal(parent.offspringCount, 1); assert.equal(child.offspringCount, 0);
  assert.equal(child.category, 'carnivore'); assert.equal(child.lineageDepth, 3); assert.equal(child.ageTicks, 0);
  assert.equal(child.speed, 80); assert.equal(child.sensingRadius, 20); near(child.x, 6);
});
test('minimum age, threshold and cooldown boundaries prevent premature reproduction', () => {
  for (const values of [{ energy: 89.999, ageTicks: 200 }, { energy: 90, ageTicks: 199 }, { energy: 90, ageTicks: 400, lastReproductionTick: 201 }]) {
    const parent = animal(values); const sim = fixture([parent]); reproduce(sim, [parent], draws([]), 400); assert.equal(sim.births, 0);
  }
  const parent = animal({ energy: 90, ageTicks: 400, lastReproductionTick: 200 }); const sim = fixture([parent]);
  reproduce(sim, [parent], draws([0, 0.5, 0.5]), 400); assert.equal(sim.births, 1);
});
test('six lifetime offspring is a strict boundary independent of cooldown/energy', () => {
  const parent = animal({ energy: 90, ageTicks: 200, offspringCount: 5 }); const sim = fixture([parent]);
  reproduce(sim, [parent], draws([0, 0.5, 0.5]), 200); assert.equal(parent.offspringCount, 6);
  parent.energy = 100; parent.ageTicks = 400;
  reproduce(sim, [parent], draws([]), 400); assert.equal(sim.births, 1); assert.equal(parent.energy, 100);
});
test('shared cap does not reserve category slots or charge blocked births', () => {
  const parents = [animal({ id: 1, energy: 90, ageTicks: 200 }), animal({ id: 2, category: 'carnivore', energy: 90, ageTicks: 200 })];
  const others = Array.from({ length: 297 }, (_, i) => animal({ id: i + 3 })); const sim = fixture([...parents, ...others]);
  reproduce(sim, [parents[1], parents[0], ...others], draws([0, 0.5, 0.5]), 200);
  assert.equal(sim.organisms.length, 300); assert.equal(parents[1].energy, 50); assert.equal(parents[0].energy, 90);
  assert.equal(parents[0].offspringCount, 0); assert.equal(sim.organisms.at(-1).category, 'carnivore');
});
test('newborn remains inactive with 35 energy and age zero in its birth tick', () => {
  const sim = fixture([animal({ energy: 100, ageTicks: 199 })]); start(sim); step(sim);
  const child = sim.organisms.find(a => a.ageTicks === 0); assert.ok(child); assert.equal(child.energy, 35); assert.equal(child.offspringCount, 0);
});
test('rainfall rates are exact and capped food never banks whole spawn opportunities', () => {
  assert.deepEqual(RAINFALL, { dry: 2, normal: 8, wet: 16 });
  for (const [rainfall, expected] of [['dry', 2], ['normal', 8], ['wet', 16]]) {
    const sim = fixture([], [], { rainfall });
    for (let i = 0; i < 20; i++) spawnFood(sim, () => 0.5);
    assert.equal(sim.food.length, expected); near(sim.foodAccumulator, 0);
  }
  const sim = fixture([], Array.from({ length: 300 }, (_, i) => plant(i + 1, 0, 0)), { rainfall: 'wet' }); sim.foodAccumulator = 0.9;
  spawnFood(sim, draws([])); assert.equal(sim.food.length, 300); near(sim.foodAccumulator, 0.7);
});
test('rainfall queues next tick in accepted order without altering existing plants', () => {
  const sim = createSimulation(); start(sim); pause(sim); const count = sim.food.length;
  setRainfall(sim, 'dry'); setRainfall(sim, 'wet'); assert.equal(sim.food.length, count); assert.equal(sim.rainfall, 'normal');
  resume(sim); step(sim); assert.deepEqual(sim.interventions, [{ tick: 1, rainfall: 'dry' }, { tick: 1, rainfall: 'wet' }]);
  assert.equal(sim.rainfall, 'wet'); assert.equal(sim.foodRate, 16);
});
test('invalid rain/start input is rejected without changing active experiment', () => {
  for (const settings of [{ seed: -1 }, { seed: 2 ** 32 }, { initialHerbivores: -1 }, { initialCarnivores: 0.5 }, { initialHerbivores: 300, initialCarnivores: 1 }, { rainfall: 'storm' }]) assert.throws(() => createSimulation(settings));
  const sim = createSimulation(); start(sim); const before = snapshot(sim);
  assert.throws(() => setRainfall(sim, 'storm')); assert.deepEqual(snapshot(sim), before);
});
test('pending rainfall cap rejects the twenty-first event without mutation', () => {
  const sim = createSimulation(); start(sim); pause(sim);
  for (let i = 0; i < 20; i++) setRainfall(sim, i % 2 ? 'wet' : 'dry');
  const before = snapshot(sim); assert.throws(() => setRainfall(sim, 'normal')); assert.deepEqual(snapshot(sim), before);
});
test('total intervention allowance reserves pending work and never accepts change 2001', () => {
  const sim = createSimulation(); start(sim); pause(sim);
  sim.interventions = Array.from({ length: 1999 }, () => ({ tick: 1, rainfall: 'dry' }));
  setRainfall(sim, 'wet'); const before = snapshot(sim);
  assert.throws(() => setRainfall(sim, 'normal')); assert.deepEqual(snapshot(sim), before);
});
test('zero animals ends immediately; single-category extinction does not end the world', () => {
  const empty = createSimulation({ initialHerbivores: 0, initialCarnivores: 0 }); start(empty);
  assert.equal(empty.status, 'ended'); assert.equal(empty.outcome, 'extinct'); assert.equal(empty.tick, 0);
  for (const settings of [{ initialHerbivores: 0, initialCarnivores: 1 }, { initialHerbivores: 1, initialCarnivores: 0 }]) {
    const sim = createSimulation(settings); start(sim); step(sim); assert.equal(sim.status, 'running');
  }
});
test('initial combined cap pauses and cannot resume', () => {
  const sim = createSimulation({ initialHerbivores: 299, initialCarnivores: 1 }); start(sim);
  assert.equal(sim.status, 'limited'); const before = snapshot(sim); resume(sim); step(sim); assert.deepEqual(snapshot(sim), before);
});
test('time limit ends at exactly 36000 completed ticks', () => {
  const sim = fixture([animal()]); start(sim); sim.tick = 35999; step(sim);
  assert.equal(sim.tick, 36000); assert.equal(sim.outcome, 'time_limit'); assert.equal(sim.status, 'ended');
  assert.ok(sim.flags.includes('time_limit'));
});
test('coincident extinction beats time limit and retains both flags', () => {
  const sim = fixture([animal({ energy: 0.01 })]); start(sim); sim.tick = 35999; step(sim);
  assert.equal(sim.outcome, 'extinct'); assert.ok(sim.flags.includes('extinct')); assert.ok(sim.flags.includes('time_limit'));
});
test('coincident time and population cap ends by time with both flags', () => {
  const sim = fixture(Array.from({ length: 299 }, (_, i) => animal({ id: i + 1, ageTicks: 199, energy: i === 0 ? 100 : 60 })));
  start(sim); sim.tick = 35999; step(sim);
  assert.equal(sim.organisms.length, 300); assert.equal(sim.outcome, 'time_limit'); assert.equal(sim.status, 'ended');
  assert.ok(sim.flags.includes('time_limit')); assert.ok(sim.flags.includes('limited'));
});
test('runtime error restores last confirmed valid result for partial export', () => {
  const sim = createSimulation(); start(sim); runTicks(sim, 25); const last = structuredClone(measure(sim));
  sim.organisms[0].x = NaN; step(sim);
  assert.equal(sim.status, 'error'); assert.equal(sim.outcome, 'error'); assert.equal(sim.partial, true);
  assert.equal(sim.tick, last.tick); assert.deepEqual(sim.measurements.at(-1), last);
  end(sim); const exported = toExperiment(sim, { id: '00000000-0000-4000-8000-000000000001', name: 'Partial', notes: '' });
  assert.equal(exported.partial, true); assert.equal(exported.duration, last.time); assert.ok(exported.finalSummary.error);
});
test('per-category measurement conservation, null empty stats and predation totals', () => {
  const sim = fixture([animal({ speed: 30 }), animal({ id: 2, speed: 50 })]);
  const sample = measure(sim); assert.equal(sample.herbivores.population, 2); near(sample.herbivores.meanSpeed, 40); near(sample.herbivores.sdSpeed, 10);
  assert.equal(sample.carnivores.population, 0); assert.equal(sample.carnivores.meanSpeed, null); assert.equal(sample.carnivores.sdSpeed, null);
  assert.equal(sample.population, sample.herbivores.population + sample.carnivores.population);
});
test('same seed and timed rainfall history reproduce full state across tick batch sizes', () => {
  const first = createSimulation({ seed: 913 }); const second = createSimulation({ seed: 913 });
  for (const sim of [first, second]) { start(sim); runTicks(sim, 100); setRainfall(sim, 'dry'); setRainfall(sim, 'wet'); }
  runTicks(first, 400); for (let i = 0; i < 100; i++) runTicks(second, 4);
  assert.deepEqual(snapshot(first), snapshot(second));
});
test('reset restores seed/category starts and initial rainfall and clears all histories/counters', () => {
  const sim = createSimulation({ seed: 123, rainfall: 'wet', initialHerbivores: 5, initialCarnivores: 2 }); const initial = snapshot(sim);
  start(sim); runTicks(sim, 40); setRainfall(sim, 'dry'); step(sim); end(sim); reset(sim);
  assert.deepEqual(snapshot(sim), initial); assert.equal(sim.status, 'ready');
});
test('pause and end freeze biology; final sample is deduplicated', () => {
  const sim = createSimulation(); start(sim); runTicks(sim, 20); pause(sim); const before = snapshot(sim);
  runTicks(sim, 100); assert.deepEqual(snapshot(sim), before);
  end(sim); assert.deepEqual(sim.measurements.map(m => m.tick), [0, 20]);
});
test('ended food-chain export has detached complete categories, flags and history', () => {
  const sim = createSimulation(); start(sim); runTicks(sim, 23); end(sim);
  const result = toExperiment(sim, { id: '00000000-0000-4000-8000-000000000042', name: 'Food chain', notes: '' });
  assert.equal(result.modelType, MODEL_TYPE); assert.equal(result.version, VERSION); assert.equal(result.partial, false);
  assert.deepEqual(result.measurements.map(m => m.tick), [0, 20, 23]);
  result.measurements[0].herbivores.population = 999; assert.equal(sim.measurements[0].herbivores.population, 40);
});


test('nonfinite global or category death counters cannot poison a recovered partial record', () => {
  for (const corrupt of [sim => { sim.deaths.energy = NaN; }, sim => { sim.categoryCounts.herbivore.deathsPredation = NaN; }]) {
    const sim = createSimulation(); start(sim); runTicks(sim, 3); const valid = measure(sim); corrupt(sim); step(sim);
    assert.equal(sim.outcome, 'error'); assert.equal(sim.partial, true); assert.deepEqual(sim.measurements.at(-1), valid);
    end(sim); const record = toExperiment(sim, { id: '00000000-0000-4000-8000-000000000001', name: 'Safe counter recovery', notes: '' });
    assert.equal(Number.isFinite(record.finalSummary.deathsEnergy), true); assert.equal(Number.isFinite(record.finalSummary.herbivores.deathsPredation), true);
  }
});

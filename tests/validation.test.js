import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { validateExperiment } from '../server/validation.js';
import { createSimulation, start, step, end, setRainfall, toExperiment } from '../public/simulation.js';

const baseline = JSON.parse(readFileSync(new URL('./baseline-fixture.json', import.meta.url), 'utf8'));
const legacy = () => structuredClone(baseline);
function record(settings = {}, ticks = 22) {
  const sim = createSimulation({ seed: 42, ...settings }); start(sim);
  for (let i = 0; i < ticks; i++) step(sim);
  end(sim);
  return toExperiment(sim, { id: randomUUID(), name: 'Food-chain validator fixture', notes: 'Actual engine output' });
}
const syncFinal = fixture => { fixture.finalSummary = { ...structuredClone(fixture.measurements.at(-1)), error: null }; };
function reject(mutate, source = record) {
  const fixture = source(); mutate(fixture); syncFinal(fixture);
  assert.equal(typeof validateExperiment(fixture), 'string', `Malformed fixture accepted: ${mutate.toString()}`);
}

test('legacy baseline fixture remains valid and validation never annotates/mutates it', () => {
  const fixture = legacy(); const before = structuredClone(fixture);
  assert.equal(validateExperiment(fixture), null); assert.deepEqual(fixture, before);
  assert.equal(Object.hasOwn(fixture, 'modelType'), false);
});
test('legacy malformed bounds, initial counts, counters and final summary still reject', () => {
  for (const mutate of [
    r => { r.measurements[0].food = 0; },
    r => { for (const m of r.measurements) { m.births++; m.population++; } },
    r => { for (const m of r.measurements) { m.deathsEnergy++; m.population--; } },
    r => { for (const m of r.measurements) { m.deathsAge++; m.population--; } },
    r => { r.measurements.at(-1).sdSpeed = 32.501; },
    r => { r.measurements.at(-1).sdSensing = 70.001; },
    r => { r.settings = {}; },
  ]) reject(mutate, legacy);
  const fixture = legacy(); fixture.finalSummary.population++;
  assert.equal(typeof validateExperiment(fixture), 'string');
});
test('actual expanded engine record contains model/version, full category statistics and rainfall', () => {
  const fixture = record();
  assert.equal(validateExperiment(fixture), null);
  assert.equal(fixture.modelType, 'food-chain'); assert.equal(fixture.version, 'evoworld-food-chain-1');
  assert.equal(fixture.partial, false); assert.ok(Array.isArray(fixture.flags));
  assert.ok(fixture.measurements[0].herbivores); assert.ok(fixture.measurements[0].carnivores);
});
test('metadata and unknown model types reject without changing submitted records', () => {
  for (const mutate of [
    r => { r.id = 'invalid'; }, r => { r.name = ''; }, r => { r.name = 'n'.repeat(101); },
    r => { r.notes = 'n'.repeat(2001); }, r => { r.version = ''; },
    r => { r.seed = -1; }, r => { r.seed = 2 ** 32; }, r => { r.seed = 0.5; },
    r => { r.modelType = 'unknown'; }, r => { r.outcome = 'running'; },
  ]) reject(mutate);
});
test('all expanded settings are required, with correct category and safety bounds', () => {
  for (const mutate of [
    r => { r.settings = {}; }, r => { delete r.settings.initialCarnivores; },
    r => { r.settings.initialHerbivores = -1; }, r => { r.settings.initialCarnivores = 0.5; },
    r => { r.settings.initialHerbivores = 300; r.settings.initialCarnivores = 1; },
    r => { r.settings.rainfall = 'storm'; }, r => { r.settings.dt = 0.1; },
    r => { r.settings.width = Infinity; }, r => { r.settings.maxOffspring = 7; },
    r => { r.settings.maxTicks = 36001; }, r => { r.settings.maxPendingEvents = 21; },
  ]) reject(mutate);
});
for (const category of ['herbivores', 'carnivores']) {
  for (const counter of ['births', 'deathsEnergy', 'deathsAge', 'deathsPredation']) {
    test(`time-zero ${category}.${counter} cannot be nonzero`, () => {
      reject(r => {
        for (const m of r.measurements) {
          m[category][counter]++;
          m[counter]++;
          if (counter === 'births') { m[category].population++; m.population++; }
          else { m[category].population--; m.population--; }
        }
      });
    });
  }
  test(`time-zero ${category} population must equal its configured initial count`, () => {
    reject(r => { r.measurements[0][category].population++; r.measurements[0].population++; });
  });
  test(`${category} population and totals must conserve births and deaths`, () => {
    reject(r => { r.measurements.at(-1)[category].population++; r.measurements.at(-1).population++; });
  });
  test(`${category} spread obeys bounds and empty-category null rules`, () => {
    for (const [key, value] of [['sdSpeed', 32.501], ['sdSensing', 70.001], ['meanSpeed', 81], ['meanSensing', 19]]) {
      reject(r => { r.measurements.at(-1)[category][key] = value; });
    }
    const fixture = record(category === 'herbivores' ? { initialHerbivores: 0 } : { initialCarnivores: 0 });
    assert.equal(validateExperiment(fixture), null);
    assert.equal(fixture.measurements.at(-1)[category].population, 0);
    assert.equal(fixture.measurements.at(-1)[category].meanSpeed, null);
    fixture.measurements.at(-1)[category].sdSpeed = 0; syncFinal(fixture);
    assert.equal(typeof validateExperiment(fixture), 'string');
  });
}
test('singleton category standard deviations are zero', () => {
  const fixture = record({ initialHerbivores: 1, initialCarnivores: 0 }, 0);
  assert.equal(validateExperiment(fixture), null);
  for (const key of ['sdSpeed', 'sdSensing']) {
    const invalid = structuredClone(fixture); invalid.measurements[0].herbivores[key] = 0.01; syncFinal(invalid);
    assert.equal(typeof validateExperiment(invalid), 'string');
  }
});
test('initial plants match settings and total counters are the sum of categories', () => {
  reject(r => { r.measurements[0].food--; });
  for (const counter of ['births', 'deathsEnergy', 'deathsAge', 'deathsPredation']) reject(r => { r.measurements.at(-1)[counter]++; });
});
test('carnivore predation deaths are impossible in the approved food chain', () => {
  reject(r => {
    const last = r.measurements.at(-1);
    last.carnivores.deathsPredation++; last.carnivores.population--;
    last.deathsPredation++; last.population--;
  });
});
test('expanded intervention history accepts next-tick rainfall in input order', () => {
  const sim = createSimulation(); start(sim); setRainfall(sim, 'dry'); setRainfall(sim, 'wet'); step(sim); end(sim);
  const fixture = toExperiment(sim, { id: randomUUID(), name: 'Ordered rain', notes: '' });
  assert.equal(validateExperiment(fixture), null);
  assert.deepEqual(fixture.interventions, [{ tick: 1, rainfall: 'dry' }, { tick: 1, rainfall: 'wet' }]);
});
test('rainfall records reject unknown weather, out-of-run events and more than 2000 changes', () => {
  for (const mutate of [
    r => { r.interventions = [{ tick: 1, rainfall: 'storm' }]; },
    r => { r.interventions = [{ tick: 0, rainfall: 'dry' }]; },
    r => { r.interventions = [{ tick: 23, rainfall: 'dry' }]; },
    r => { r.interventions = [{ tick: 2, rainfall: 'dry' }, { tick: 1, rainfall: 'wet' }]; },
    r => { r.interventions = Array.from({ length: 2001 }, () => ({ tick: 1, rainfall: 'dry' })); },
  ]) reject(mutate);
});
test('time and history require tick alignment, initial/final samples, and thirty-minute bound', () => {
  for (const mutate of [
    r => { r.duration = 1800.05; }, r => { r.duration = 1.101; },
    r => { r.measurements.shift(); }, r => { r.measurements.pop(); },
    r => { r.measurements[1].time = 99; }, r => { r.measurements[1].tick = 0; },
  ]) reject(mutate);
});
test('outcome flags and partial marker agree with primary precedence and end state', () => {
  for (const mutate of [
    r => { r.flags = ['unknown']; }, r => { r.flags = ['extinct']; },
    r => { r.outcome = 'time_limit'; r.flags = ['time_limit']; },
    r => { r.outcome = 'limited'; r.flags = ['limited']; },
    r => { r.partial = true; }, r => { r.partial = 'false'; },
  ]) reject(mutate);
});
test('zero-animal starts export valid immediate extinction with both category null statistics', () => {
  const fixture = record({ initialHerbivores: 0, initialCarnivores: 0 }, 0);
  assert.equal(validateExperiment(fixture), null); assert.equal(fixture.duration, 0);
  assert.equal(fixture.outcome, 'extinct'); assert.ok(fixture.flags.includes('extinct'));
});
test('contradictory final summary rejects independently of metric validity', () => {
  const fixture = record(); fixture.finalSummary.herbivores.population++;
  assert.equal(typeof validateExperiment(fixture), 'string');
});

for (const category of ['herbivores', 'carnivores']) {
  for (const [field, maximum] of [['sdSpeed', 5], ['sdSensing', 10]]) {
    test(`initial ${category}.${field} respects starting distribution bound ${maximum}`, () => {
      reject(r => { r.measurements[0][category][field] = maximum + 0.01; });
    });
  }
}
test('rainfall history cannot claim more than twenty accepted changes at one tick', () => {
  const fixture = record(); fixture.interventions = Array.from({ length: 21 }, () => ({ tick: 1, rainfall: 'dry' })); syncFinal(fixture);
  assert.equal(typeof validateExperiment(fixture), 'string');
  fixture.interventions.pop(); assert.equal(validateExperiment(fixture), null, 'Twenty changes at a boundary are permitted');
});

function sumCategories(sample) {
  sample.population = sample.herbivores.population + sample.carnivores.population;
  for (const key of ['births', 'deathsEnergy', 'deathsAge', 'deathsPredation']) sample[key] = sample.herbivores[key] + sample.carnivores[key];
}
function emptyCategoryAfter(fixture, name, tick) {
  const initial = fixture.settings[name === 'herbivores' ? 'initialHerbivores' : 'initialCarnivores'];
  const first = fixture.measurements.find(m => m.tick >= tick);
  const extinct = { ...first[name], population: 0, meanSpeed: null, sdSpeed: null, meanSensing: null, sdSensing: null };
  extinct.deathsEnergy = initial + extinct.births - extinct.deathsAge - extinct.deathsPredation;
  for (const sample of fixture.measurements.filter(m => m.tick >= tick)) { sample[name] = { ...extinct }; sumCategories(sample); }
  syncFinal(fixture);
}
function resurrectFinal(fixture, name) {
  const last = fixture.measurements.at(-1), category = last[name];
  category.population = 1; category.births++;
  Object.assign(category, { meanSpeed: 40, sdSpeed: 0, meanSensing: name === 'herbivores' ? 70 : 110, sdSensing: 0 });
  sumCategories(last); syncFinal(fixture);
}
for (const name of ['herbivores', 'carnivores']) {
  const settings = name === 'herbivores' ? { initialHerbivores: 0, initialCarnivores: 6 } : { initialHerbivores: 6, initialCarnivores: 0 };
  test(`BUG-008: initially absent ${name} cannot produce a member after 250 ticks`, () => {
    const fixture = record(settings, 250);
    assert.equal(validateExperiment(fixture), null, 'Actual single-category engine record must remain valid');
    assert.equal(fixture.measurements.at(-2)[name].population, 0);
    resurrectFinal(fixture, name);
    assert.equal(typeof validateExperiment(fixture), 'string', 'Category resurrection accepted');
  });
  test(`BUG-008: observed extinction of ${name} is irreversible after a legitimate positive-to-zero transition`, () => {
    const fixture = record({}, 250); emptyCategoryAfter(fixture, name, 220);
    assert.ok(fixture.measurements.find(m => m.tick === 200)[name].population > 0);
    assert.equal(validateExperiment(fixture), null, 'Positive-to-zero followed by stable zero is allowed');
    resurrectFinal(fixture, name);
    assert.equal(typeof validateExperiment(fixture), 'string', 'Measured extinct category reappeared');
  });
  for (const death of (name === 'herbivores' ? ['deathsEnergy', 'deathsAge', 'deathsPredation'] : ['deathsEnergy', 'deathsAge'])) {
    test(`BUG-008: zero-population ${name} cannot add a birth and ${death} while remaining zero`, () => {
      const fixture = record(settings, 250); const last = fixture.measurements.at(-1);
      last[name].births++; last[name][death]++; sumCategories(last); syncFinal(fixture);
      assert.equal(last[name].population, 0);
      assert.equal(typeof validateExperiment(fixture), 'string', 'Counters changed after extinction');
    });
  }
  test(`BUG-008: stable post-extinction ${name} counters remain valid in a partial error export`, () => {
    const fixture = record({}, 250); emptyCategoryAfter(fixture, name, 220);
    fixture.outcome = 'error'; fixture.flags = ['error']; fixture.partial = true; fixture.finalSummary.error = 'Controlled partial result';
    assert.equal(validateExperiment(fixture), null);
  });
}


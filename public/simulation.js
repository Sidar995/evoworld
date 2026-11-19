/** Fixed-step food-chain biology. Canvas, wall-clock time and DOM never consume this RNG. */
export const MODEL_TYPE = 'food-chain';
export const VERSION = 'evoworld-food-chain-1';
export const RAINFALL = Object.freeze({ dry: 2, normal: 8, wet: 16 });
export const DEFAULTS = Object.freeze({
  width: 1000, height: 600, dt: 0.05,
  initialHerbivores: 40, initialCarnivores: 6, rainfall: 'normal', initialFood: 120,
  initialHerbivoreEnergy: 60, initialCarnivoreEnergy: 80,
  initialHerbivoreSpeedMin: 35, initialHerbivoreSpeedMax: 45,
  initialCarnivoreSpeedMin: 40, initialCarnivoreSpeedMax: 50,
  initialHerbivoreSensingMin: 60, initialHerbivoreSensingMax: 80,
  initialCarnivoreSensingMin: 100, initialCarnivoreSensingMax: 120,
  herbivoreMaintenanceMultiplier: 1, carnivoreMaintenanceMultiplier: 1.25,
  maxEnergy: 120, foodEnergy: 25, captureEfficiency: 0.8, contactDistance: 6,
  maxFood: 300, populationLimit: 300, maxAgeTicks: 3600,
  minReproductionAgeTicks: 200, reproductionCooldownTicks: 200,
  reproductionThreshold: 90, childEnergy: 35, reproductionCost: 5, offspringDistance: 8,
  speedMin: 15, speedMax: 80, sensingMin: 20, sensingMax: 160,
  mutationSpeed: 3, mutationSensing: 6, wanderPeriodTicks: 20, wanderAngle: Math.PI / 4,
  measurementIntervalTicks: 20, maxOffspring: 6, maxTicks: 36000,
  maxPendingEvents: 20, maxInterventions: 2000,
});

const TWO_PI = Math.PI * 2;
const CATEGORIES = ['herbivore', 'carnivore'];
const clone = value => structuredClone(value);
const checkpoints = new WeakMap();
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
export const wrap = (value, length) => ((value % length) + length) % length;
export const toroidalDelta = (from, to, length) => wrap(to - from + length / 2, length) - length / 2;
export function distance(a, b, settings = DEFAULTS) {
  return Math.hypot(toroidalDelta(a.x, b.x, settings.width), toroidalDelta(a.y, b.y, settings.height));
}
export const energyCost = (speed, sensingRadius, multiplier = 1) => multiplier * (0.5 + 0.6 * (speed / 40) ** 2 + 0.4 * (sensingRadius / 70) ** 2);
const emptyCategoryCounters = () => ({ births: 0, deathsEnergy: 0, deathsAge: 0, deathsPredation: 0 });

function validateSettings(input) {
  for (const key of Object.keys(input)) if (!Object.hasOwn(DEFAULTS, key)) throw new RangeError(`Unknown simulation setting: ${key}`);
  const settings = { ...DEFAULTS, ...input };
  if (!Object.hasOwn(RAINFALL, settings.rainfall) || typeof settings.rainfall !== 'string') throw new RangeError('Rainfall must be dry, normal or wet.');
  for (const [key, value] of Object.entries(settings)) {
    if (key === 'rainfall') continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new RangeError(`${key} must be a finite nonnegative number.`);
  }
  for (const key of ['width', 'height', 'dt', 'maxEnergy', 'populationLimit', 'maxAgeTicks', 'wanderPeriodTicks', 'measurementIntervalTicks', 'maxTicks', 'maxPendingEvents', 'maxInterventions']) {
    if (settings[key] <= 0) throw new RangeError(`${key} must be positive.`);
  }
  for (const key of ['initialHerbivores', 'initialCarnivores', 'initialFood', 'maxFood', 'populationLimit', 'maxAgeTicks', 'minReproductionAgeTicks', 'reproductionCooldownTicks', 'wanderPeriodTicks', 'measurementIntervalTicks', 'maxOffspring', 'maxTicks', 'maxPendingEvents', 'maxInterventions']) {
    if (!Number.isSafeInteger(settings[key])) throw new RangeError(`${key} must be an integer.`);
  }
  if (settings.initialHerbivores + settings.initialCarnivores > settings.populationLimit || settings.populationLimit > 300 || settings.initialFood > settings.maxFood || settings.maxFood > 300) throw new RangeError('Initial counts or safety caps are out of range.');
  if (settings.maxTicks > 36000 || settings.maxPendingEvents > 20 || settings.maxInterventions > 2000 || settings.maxOffspring > 6) throw new RangeError('Simulation safeguards exceed their approved limits.');
  if (settings.childEnergy + settings.reproductionCost > settings.reproductionThreshold || settings.reproductionThreshold > settings.maxEnergy || settings.captureEfficiency > 1) throw new RangeError('Energy settings are inconsistent.');
  for (const label of ['Herbivore', 'Carnivore']) {
    if (settings[`initial${label}Energy`] > settings.maxEnergy) throw new RangeError('Initial energy exceeds its cap.');
    if (settings.speedMin > settings[`initial${label}SpeedMin`] || settings[`initial${label}SpeedMin`] > settings[`initial${label}SpeedMax`] || settings[`initial${label}SpeedMax`] > settings.speedMax || settings.speedMax <= 0) throw new RangeError('Initial speed range must fit inside trait bounds.');
    if (settings.sensingMin > settings[`initial${label}SensingMin`] || settings[`initial${label}SensingMin`] > settings[`initial${label}SensingMax`] || settings[`initial${label}SensingMax`] > settings.sensingMax || settings.sensingMax <= 0) throw new RangeError('Initial sensing range must fit inside trait bounds.');
  }
  return settings;
}

/** Explicit-state Mulberry32 permits deterministic initialization/reset and replay. */
export function nextRandom(sim) {
  sim.rngState = (sim.rngState + 0x6D2B79F5) >>> 0;
  let value = sim.rngState;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}

function checkpoint(sim) {
  // Samples/events are immutable entries; copy their bounded arrays without deep-copying history every tick.
  checkpoints.set(sim, {
    ...sim, settings: { ...sim.settings }, organisms: clone(sim.organisms), food: clone(sim.food),
    measurements: [...sim.measurements], interventions: [...sim.interventions], pendingEvents: clone(sim.pendingEvents),
    flags: [...sim.flags], deaths: { ...sim.deaths }, categoryCounts: clone(sim.categoryCounts),
  });
}

export function createSimulation({ seed = 42, ...input } = {}) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) throw new RangeError('Seed must be an integer from 0 to 4294967295.');
  const settings = validateSettings(input);
  const sim = {
    modelType: MODEL_TYPE, version: VERSION, seed, settings, status: 'ready', tick: 0,
    organisms: [], food: [], measurements: [], interventions: [], pendingEvents: [],
    rainfall: settings.rainfall, foodRate: RAINFALL[settings.rainfall], foodAccumulator: 0,
    rngState: seed >>> 0, nextOrganismId: 1, nextFoodId: 1,
    outcome: null, flags: [], partial: false, error: null,
    deaths: { energy: 0, age: 0, predation: 0 }, births: 0,
    categoryCounts: { herbivore: emptyCategoryCounters(), carnivore: emptyCategoryCounters() },
  };
  for (const category of CATEGORIES) {
    const label = category === 'herbivore' ? 'Herbivore' : 'Carnivore';
    const count = settings[`initial${label}s`];
    for (let index = 0; index < count; index++) {
      sim.organisms.push({
        id: sim.nextOrganismId++, category,
        x: nextRandom(sim) * settings.width, y: nextRandom(sim) * settings.height,
        heading: nextRandom(sim) * TWO_PI, ageTicks: 0, energy: settings[`initial${label}Energy`],
        speed: settings[`initial${label}SpeedMin`] + nextRandom(sim) * (settings[`initial${label}SpeedMax`] - settings[`initial${label}SpeedMin`]),
        sensingRadius: settings[`initial${label}SensingMin`] + nextRandom(sim) * (settings[`initial${label}SensingMax`] - settings[`initial${label}SensingMin`]),
        lineageDepth: 0, lastReproductionTick: null, offspringCount: 0, fleeing: false,
      });
    }
  }
  for (let index = 0; index < settings.initialFood; index++) addFood(sim, () => nextRandom(sim));
  checkpoint(sim);
  return sim;
}

function addFood(sim, random) {
  sim.food.push({ id: sim.nextFoodId++, x: random() * sim.settings.width, y: random() * sim.settings.height });
}

export function spawnFood(sim, random = () => nextRandom(sim)) {
  let accumulated = sim.foodAccumulator + sim.foodRate * sim.settings.dt;
  const nearestInteger = Math.round(accumulated);
  if (Math.abs(accumulated - nearestInteger) <= 1e-12) accumulated = nearestInteger;
  const requested = Math.floor(accumulated);
  sim.foodAccumulator = accumulated - requested;
  const count = Math.min(requested, Math.max(0, sim.settings.maxFood - sim.food.length));
  for (let index = 0; index < count; index++) addFood(sim, random);
  return count;
}

function countDeath(sim, organism, cause) {
  sim.deaths[cause]++;
  sim.categoryCounts[organism.category][`deaths${cause[0].toUpperCase()}${cause.slice(1)}`]++;
}

export function chargeAndCull(sim) {
  const survivors = [];
  for (const organism of sim.organisms) {
    organism.ageTicks++;
    const multiplier = sim.settings[`${organism.category}MaintenanceMultiplier`];
    organism.energy -= energyCost(organism.speed, organism.sensingRadius, multiplier) * sim.settings.dt;
    if (organism.ageTicks >= sim.settings.maxAgeTicks) countDeath(sim, organism, 'age');
    else if (organism.energy <= 0) countDeath(sim, organism, 'energy');
    else survivors.push(organism);
  }
  sim.organisms = survivors;
  return survivors;
}

function nearest(candidates, origin, radius, settings) {
  let best = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const d = distance(origin, candidate, settings);
    if (d <= radius && (d < bestDistance || (d === bestDistance && candidate.id < best.id))) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best ? { target: best, distance: bestDistance } : null;
}

/** Intent decisions read one immutable biological snapshot, never earlier movers' positions. */
export function decideMovement(sim, random = () => nextRandom(sim)) {
  const settings = sim.settings;
  const animals = sim.organisms.map(organism => ({ ...organism })).sort((a, b) => a.id - b.id);
  const herbivores = animals.filter(organism => organism.category === 'herbivore');
  const carnivores = animals.filter(organism => organism.category === 'carnivore');
  return animals.map(organism => {
    let heading = organism.heading;
    if (organism.ageTicks > 0 && organism.ageTicks % settings.wanderPeriodTicks === 0) {
      heading = wrap(heading + (2 * random() - 1) * settings.wanderAngle, TWO_PI);
    }
    let dx = Math.cos(heading);
    let dy = Math.sin(heading);
    let travel = organism.speed * settings.dt;
    let fleeing = false;
    if (organism.category === 'herbivore') {
      const threat = nearest(carnivores, organism, organism.sensingRadius, settings);
      if (threat) {
        fleeing = true;
        if (threat.distance === 0) {
          const angle = random() * TWO_PI;
          dx = Math.cos(angle);
          dy = Math.sin(angle);
        } else {
          dx = -toroidalDelta(organism.x, threat.target.x, settings.width) / threat.distance;
          dy = -toroidalDelta(organism.y, threat.target.y, settings.height) / threat.distance;
        }
      } else {
        const target = nearest(sim.food, organism, organism.sensingRadius, settings);
        if (target) {
          if (target.distance <= settings.contactDistance) travel = 0;
          else {
            dx = toroidalDelta(organism.x, target.target.x, settings.width) / target.distance;
            dy = toroidalDelta(organism.y, target.target.y, settings.height) / target.distance;
            travel = Math.min(travel, target.distance);
          }
        }
      }
    } else if (organism.energy < settings.reproductionThreshold) {
      const target = nearest(herbivores, organism, organism.sensingRadius, settings);
      if (target && target.distance > 0) {
        dx = toroidalDelta(organism.x, target.target.x, settings.width) / target.distance;
        dy = toroidalDelta(organism.y, target.target.y, settings.height) / target.distance;
        travel = Math.min(travel, target.distance);
      } else if (target) travel = 0;
    }
    return { id: organism.id, x: wrap(organism.x + dx * travel, settings.width), y: wrap(organism.y + dy * travel, settings.height), heading, fleeing };
  });
}

export function applyMovement(sim, intents) {
  const byId = new Map(intents.map(intent => [intent.id, intent]));
  for (const organism of sim.organisms) {
    const intent = byId.get(organism.id);
    if (!intent) throw new Error(`Missing movement intent for organism ${organism.id}.`);
    organism.x = intent.x;
    organism.y = intent.y;
    organism.heading = intent.heading;
    organism.fleeing = intent.fleeing;
  }
  return sim;
}

export function processMovement(sim, random = () => nextRandom(sim)) {
  return applyMovement(sim, decideMovement(sim, random));
}

export function shuffledOrder(animals, random) {
  const order = [...animals].sort((a, b) => a.id - b.id);
  for (let index = order.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [order[index], order[other]] = [order[other], order[index]];
  }
  return order;
}

export function resolveCaptures(sim, suppliedOrder, random = () => nextRandom(sim)) {
  const order = suppliedOrder ?? shuffledOrder(sim.organisms.filter(organism => organism.category === 'carnivore'), random);
  for (const predator of order) {
    if (predator.category !== 'carnivore' || predator.energy >= sim.settings.reproductionThreshold || !sim.organisms.includes(predator)) continue;
    const prey = nearest(sim.organisms.filter(organism => organism.category === 'herbivore'), predator, sim.settings.contactDistance, sim.settings);
    if (!prey) continue;
    predator.energy = Math.min(sim.settings.maxEnergy, predator.energy + sim.settings.captureEfficiency * prey.target.energy);
    countDeath(sim, prey.target, 'predation');
    sim.organisms = sim.organisms.filter(organism => organism.id !== prey.target.id);
  }
  return sim;
}

export function feedHerbivores(sim, suppliedOrder, random = () => nextRandom(sim)) {
  const order = suppliedOrder ?? shuffledOrder(sim.organisms.filter(organism => organism.category === 'herbivore' && !organism.fleeing), random);
  for (const organism of order) {
    if (organism.category !== 'herbivore' || organism.fleeing || !sim.organisms.includes(organism)) continue;
    const contact = nearest(sim.food, organism, sim.settings.contactDistance, sim.settings);
    if (!contact) continue;
    organism.energy = Math.min(sim.settings.maxEnergy, organism.energy + sim.settings.foodEnergy);
    sim.food = sim.food.filter(food => food.id !== contact.target.id);
  }
  return sim;
}

export function reproduce(sim, suppliedOrder, random = () => nextRandom(sim), currentTick = sim.tick + 1) {
  const settings = sim.settings;
  const order = suppliedOrder ?? shuffledOrder(sim.organisms, random);
  for (const parent of order) {
    if (sim.organisms.length >= settings.populationLimit) break;
    if (!sim.organisms.includes(parent) || parent.energy < settings.reproductionThreshold || parent.ageTicks < settings.minReproductionAgeTicks || parent.offspringCount >= settings.maxOffspring) continue;
    if (parent.lastReproductionTick !== null && currentTick - parent.lastReproductionTick < settings.reproductionCooldownTicks) continue;
    const angle = random() * TWO_PI;
    const speedDelta = (2 * random() - 1) * settings.mutationSpeed;
    const sensingDelta = (2 * random() - 1) * settings.mutationSensing;
    parent.energy -= settings.childEnergy + settings.reproductionCost;
    parent.lastReproductionTick = currentTick;
    parent.offspringCount++;
    sim.organisms.push({
      id: sim.nextOrganismId++, category: parent.category,
      x: wrap(parent.x + settings.offspringDistance * Math.cos(angle), settings.width),
      y: wrap(parent.y + settings.offspringDistance * Math.sin(angle), settings.height),
      heading: parent.heading, ageTicks: 0, energy: settings.childEnergy,
      speed: clamp(parent.speed + speedDelta, settings.speedMin, settings.speedMax),
      sensingRadius: clamp(parent.sensingRadius + sensingDelta, settings.sensingMin, settings.sensingMax),
      lineageDepth: parent.lineageDepth + 1, lastReproductionTick: null, offspringCount: 0, fleeing: false,
    });
    sim.births++;
    sim.categoryCounts[parent.category].births++;
  }
  return sim;
}

function statistics(values) {
  if (!values.length) return { mean: null, sd: null };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return { mean, sd: Math.sqrt(variance) };
}

export function measure(sim) {
  const sample = {
    tick: sim.tick, time: sim.tick * sim.settings.dt, population: sim.organisms.length, food: sim.food.length,
    births: sim.births, deathsEnergy: sim.deaths.energy, deathsAge: sim.deaths.age, deathsPredation: sim.deaths.predation,
  };
  for (const category of CATEGORIES) {
    const animals = sim.organisms.filter(organism => organism.category === category);
    const speed = statistics(animals.map(organism => organism.speed));
    const sensing = statistics(animals.map(organism => organism.sensingRadius));
    sample[`${category}s`] = { population: animals.length, meanSpeed: speed.mean, sdSpeed: speed.sd, meanSensing: sensing.mean, sdSensing: sensing.sd, ...sim.categoryCounts[category] };
  }
  return sample;
}

export function recordMeasurement(sim) {
  const sample = measure(sim);
  if (sim.measurements.at(-1)?.tick === sample.tick) sim.measurements[sim.measurements.length - 1] = sample;
  else sim.measurements.push(sample);
  return sample;
}

export function stateError(sim) {
  for (const [key, value] of Object.entries(sim.settings)) if (key !== 'rainfall' && !Number.isFinite(value)) return `Invalid simulation setting: ${key}.`;
  for (const key of ['tick', 'rngState', 'foodRate', 'foodAccumulator', 'births', 'nextOrganismId', 'nextFoodId']) if (!Number.isFinite(sim[key])) return `Non-finite simulation value: ${key}.`;
  if (!Object.hasOwn(RAINFALL, sim.rainfall) || sim.foodRate !== RAINFALL[sim.rainfall]) return 'Rainfall state is invalid.';
  for (const [cause, value] of Object.entries(sim.deaths)) if (!Number.isSafeInteger(value) || value < 0) return `Invalid death counter: ${cause}.`;
  for (const category of CATEGORIES) {
    if (!sim.categoryCounts[category]) return 'Category counters are missing.';
    for (const [counter, value] of Object.entries(sim.categoryCounts[category])) if (!Number.isSafeInteger(value) || value < 0) return `Invalid ${category} counter: ${counter}.`;
  }
  if (sim.organisms.length > sim.settings.populationLimit || sim.food.length > sim.settings.maxFood) return 'A simulation safety cap was exceeded.';
  if (sim.pendingEvents.length > sim.settings.maxPendingEvents || sim.pendingEvents.length + sim.interventions.length > sim.settings.maxInterventions) return 'Rainfall history limits were exceeded.';
  for (const organism of sim.organisms) {
    if (!CATEGORIES.includes(organism.category)) return 'An organism has an invalid dietary category.';
    for (const key of ['id', 'x', 'y', 'heading', 'ageTicks', 'energy', 'speed', 'sensingRadius', 'lineageDepth', 'offspringCount']) if (!Number.isFinite(organism[key])) return `Organism ${organism.id} has non-finite ${key}.`;
    if (organism.lastReproductionTick !== null && !Number.isFinite(organism.lastReproductionTick)) return `Organism ${organism.id} has invalid reproductive timing.`;
    if (organism.speed < sim.settings.speedMin || organism.speed > sim.settings.speedMax || organism.sensingRadius < sim.settings.sensingMin || organism.sensingRadius > sim.settings.sensingMax || organism.energy > sim.settings.maxEnergy || organism.offspringCount > sim.settings.maxOffspring) return `Organism ${organism.id} is outside approved bounds.`;
  }
  for (const food of sim.food) if (![food.id, food.x, food.y].every(Number.isFinite)) return 'Food has a non-finite state value.';
  for (const event of sim.pendingEvents) if (!Number.isSafeInteger(event.tick) || !Object.hasOwn(RAINFALL, event.rainfall)) return 'A queued rainfall change is invalid.';
  return null;
}

function stoppingFlags(sim) {
  const flags = [];
  if (!sim.organisms.length) flags.push('extinct');
  if (sim.tick >= sim.settings.maxTicks) flags.push('time_limit');
  if (sim.organisms.length >= sim.settings.populationLimit) flags.push('limited');
  return flags;
}

/** Restore the last complete valid tick. Never export a half-applied corrupt step. */
export function fail(sim, message) {
  const valid = checkpoints.get(sim);
  if (valid) {
    for (const key of Object.keys(sim)) delete sim[key];
    Object.assign(sim, { ...valid, settings: { ...valid.settings }, organisms: clone(valid.organisms), food: clone(valid.food),
      measurements: [...valid.measurements], interventions: [...valid.interventions], pendingEvents: clone(valid.pendingEvents),
      deaths: { ...valid.deaths }, categoryCounts: clone(valid.categoryCounts) });
  }
  sim.status = 'error';
  sim.outcome = 'error';
  sim.flags = ['error', ...stoppingFlags(sim)];
  sim.partial = true;
  sim.error = String(message || 'Simulation stopped unexpectedly.');
  recordMeasurement(sim);
  return sim;
}

function evaluate(sim) {
  sim.flags = stoppingFlags(sim);
  if (!sim.flags.length) return;
  sim.outcome = sim.flags[0];
  sim.status = sim.outcome === 'limited' ? 'limited' : 'ended';
  recordMeasurement(sim);
}

export function start(sim) {
  if (sim.status !== 'ready') return sim;
  const problem = stateError(sim);
  if (problem) return fail(sim, problem);
  sim.status = 'running';
  recordMeasurement(sim);
  evaluate(sim);
  checkpoint(sim);
  return sim;
}
export function pause(sim) { if (sim.status === 'running') { sim.status = 'paused'; checkpoint(sim); } return sim; }
export function resume(sim) { if (sim.status === 'paused') { sim.status = 'running'; checkpoint(sim); } return sim; }

export function step(sim) {
  if (sim.status !== 'running') return sim;
  const problem = stateError(sim);
  if (problem) return fail(sim, problem);
  try {
    const currentTick = sim.tick + 1;
    const remaining = [];
    for (const event of sim.pendingEvents) {
      if (event.tick <= currentTick) {
        sim.rainfall = event.rainfall;
        sim.foodRate = RAINFALL[event.rainfall];
        sim.interventions.push({ tick: currentTick, rainfall: event.rainfall });
      } else remaining.push(event);
    }
    sim.pendingEvents = remaining;
    spawnFood(sim);
    chargeAndCull(sim);
    processMovement(sim);
    resolveCaptures(sim);
    feedHerbivores(sim);
    reproduce(sim);
    sim.tick = currentTick;
    const finalProblem = stateError(sim);
    if (finalProblem) return fail(sim, finalProblem);
    if (sim.tick % sim.settings.measurementIntervalTicks === 0) recordMeasurement(sim);
    evaluate(sim);
    checkpoint(sim);
  } catch (error) { fail(sim, error instanceof Error ? error.message : error); }
  return sim;
}

export function end(sim) {
  if (sim.status === 'ready' || sim.status === 'ended') return sim;
  sim.outcome = sim.outcome ?? 'manual';
  sim.flags = [...new Set([...sim.flags, sim.outcome])];
  sim.status = 'ended';
  // Failed state already contains its recovered final valid sample.
  if (!sim.partial) recordMeasurement(sim);
  checkpoint(sim);
  return sim;
}
export function reset(sim) {
  const recreated = createSimulation({ seed: sim.seed, ...sim.settings });
  for (const key of Object.keys(sim)) delete sim[key];
  Object.assign(sim, recreated);
  checkpoint(sim);
  return sim;
}
export function setRainfall(sim, value) {
  if (typeof value !== 'string' || !Object.hasOwn(RAINFALL, value)) throw new RangeError('Rainfall must be dry, normal or wet.');
  if (sim.status === 'ready') { sim.rainfall = value; sim.foodRate = RAINFALL[value]; sim.settings.rainfall = value; }
  else if (sim.status === 'running' || sim.status === 'paused') {
    if (sim.pendingEvents.length >= sim.settings.maxPendingEvents) throw new RangeError('At most 20 rainfall changes may wait for the next tick.');
    if (sim.interventions.length + sim.pendingEvents.length >= sim.settings.maxInterventions) throw new RangeError('This experiment reached its rainfall-change allowance.');
    sim.pendingEvents.push({ tick: sim.tick + 1, rainfall: value });
  } else throw new Error('Rainfall cannot change in this run state. Reset to start a new experiment.');
  checkpoint(sim);
  return sim;
}
/** Compatibility alias for programmatic callers; UI uses named rainfall only. */
export function setFoodRate(sim, value) {
  const rainfall = Object.keys(RAINFALL).find(key => RAINFALL[key] === value);
  if (!rainfall) throw new RangeError('Use the approved dry, normal or wet rainfall growth rate.');
  return setRainfall(sim, rainfall);
}
export function snapshot(sim) { return clone(sim); }

function allFinite(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(allFinite);
  if (value && typeof value === 'object') return Object.values(value).every(allFinite);
  return true;
}
export function toExperiment(sim, { id, name, notes = '' }) {
  if (sim.status !== 'ended') throw new Error('End the experiment before saving or exporting it.');
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('Experiment ID must be a UUID.');
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) throw new Error('Enter an experiment name of 1 to 100 characters.');
  if (typeof notes !== 'string' || notes.length > 2000) throw new Error('Notes must be at most 2000 characters.');
  const finalSample = sim.measurements.at(-1);
  if (!finalSample || finalSample.tick !== sim.tick || !allFinite(finalSample)) throw new Error('No valid final measurement is available to export.');
  const record = {
    id, name: name.trim(), notes, modelType: sim.modelType, version: sim.version, seed: sim.seed,
    settings: clone(sim.settings), interventions: clone(sim.interventions), measurements: clone(sim.measurements),
    outcome: sim.outcome, flags: clone(sim.flags), partial: Boolean(sim.partial), duration: finalSample.time,
    finalSummary: { ...clone(finalSample), error: sim.error },
  };
  if (!allFinite(record)) throw new Error('This result contains invalid data and cannot be exported.');
  return record;
}



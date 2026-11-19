import { isDeepStrictEqual } from 'node:util';
import { BASELINE_DEFAULTS as DEFAULTS } from './baseline-defaults.js';

export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const integer = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function validateBaselineExperiment(record) {
  if (!object(record)) return 'An experiment object is required.';
  if (typeof record.id !== 'string' || !uuid.test(record.id)) return 'A valid experiment UUID is required.';
  if (typeof record.name !== 'string' || !record.name.trim() || record.name.length > 100) return 'Experiment name must contain 1–100 characters.';
  if (typeof record.notes !== 'string' || record.notes.length > 2000) return 'Notes must be a string of at most 2000 characters.';
  if (typeof record.version !== 'string' || !record.version || record.version.length > 80) return 'A simulation version is required.';
  if (!integer(record.seed, 0, 4294967295)) return 'Seed must be an unsigned 32-bit integer.';
  if (!object(record.settings) || !object(record.finalSummary)) return 'Settings and final summary are required.';
  if (Object.keys(DEFAULTS).some((key) => !Object.hasOwn(record.settings, key))) return 'Complete simulation settings are required.';
  try {
    // Validate parameters without allocating the submitted starting population.
    const settings = record.settings;
    if (Object.keys(settings).some(key => !(key in DEFAULTS))) throw new Error('Unknown setting');
    if (Object.values(settings).some(value => !finite(value) || value < 0)) throw new Error('Invalid setting');
    for (const key of ['width','height','dt','maxEnergy','populationLimit','maxAgeTicks','wanderPeriodTicks','measurementIntervalTicks']) if (settings[key] <= 0) throw new Error('Nonpositive setting');
    for (const key of ['initialPopulation','initialFood','maxFood','populationLimit','maxAgeTicks','minReproductionAgeTicks','reproductionCooldownTicks','wanderPeriodTicks','measurementIntervalTicks']) if (!Number.isSafeInteger(settings[key])) throw new Error('Fractional setting');
    if (settings.foodRate > 30 || settings.initialEnergy > settings.maxEnergy || settings.childEnergy + settings.reproductionCost > settings.reproductionThreshold || settings.reproductionThreshold > settings.maxEnergy) throw new Error('Energy/rate bounds');
    if (settings.speedMin > settings.initialSpeedMin || settings.initialSpeedMin > settings.initialSpeedMax || settings.initialSpeedMax > settings.speedMax || settings.sensingMin > settings.initialSensingMin || settings.initialSensingMin > settings.initialSensingMax || settings.initialSensingMax > settings.sensingMax) throw new Error('Trait bounds');
  } catch { return 'Simulation settings are invalid.'; }
  if (!integer(record.settings.initialPopulation, 0, 300) || !integer(record.settings.initialFood, 0, 300) || record.settings.initialPopulation > record.settings.populationLimit || record.settings.initialFood > record.settings.maxFood || record.settings.dt !== 0.05 || record.settings.populationLimit !== 300 || record.settings.maxFood !== 300 || record.settings.speedMin !== 15 || record.settings.speedMax !== 80 || record.settings.sensingMin !== 20 || record.settings.sensingMax !== 160) return 'Simulation settings violate the version safety limits.';
  if (!['manual', 'extinct', 'limited', 'error'].includes(record.outcome)) return 'An ended experiment outcome is required.';
  if (!finite(record.duration) || record.duration < 0) return 'Duration must be nonnegative.';
  if (!Array.isArray(record.interventions) || !Array.isArray(record.measurements) || record.measurements.length === 0) return 'Interventions and at least one measurement are required.';
  const finalTick = Math.round(record.duration * 20);
  if (Math.abs(finalTick / 20 - record.duration) > 1e-9) return 'Duration must match a simulation tick.';
  let lastEventTick = 0;
  for (const event of record.interventions) {
    if (!object(event) || !integer(event.tick, 1, finalTick) || event.tick < lastEventTick || !finite(event.value) || event.value < 0 || event.value > 30) return 'Food interventions must be ordered, in range, and within the run.';
    lastEventTick = event.tick;
  }
  let lastTick = -1;
  let previousCounters = { births: 0, deathsEnergy: 0, deathsAge: 0 };
  for (const m of record.measurements) {
    if (!object(m) || !integer(m.tick, 0, finalTick) || m.tick <= lastTick || !finite(m.time) || Math.abs(m.time - m.tick / 20) > 1e-9) return 'Measurements need strictly increasing ticks and matching times.';
    if (!integer(m.population, 0, 300) || !integer(m.food, 0, 300)) return 'Population and food counts must be within safety limits.';
    for (const key of ['deathsEnergy', 'deathsAge', 'births']) if (!integer(m[key], 0, Number.MAX_SAFE_INTEGER)) return `Invalid measurement ${key}.`;
    if (m.tick === 0 && (m.population !== record.settings.initialPopulation || m.food !== record.settings.initialFood || m.births !== 0 || m.deathsEnergy !== 0 || m.deathsAge !== 0)) return 'The initial measurement must match starting counts and have no births or deaths.';
    if (['births','deathsEnergy','deathsAge'].some((key) => m[key] < previousCounters[key])) return 'Cumulative birth and death counts must never decrease.';
    if (m.population !== record.settings.initialPopulation + m.births - m.deathsEnergy - m.deathsAge) return 'Population must match initial population plus births minus deaths.';
    previousCounters = m;
    if (m.population === 0) {
      if (['meanSpeed','sdSpeed','meanSensing','sdSensing'].some((key) => m[key] !== null)) return 'Extinct trait statistics must be null.';
    } else {
      if (!finite(m.meanSpeed) || m.meanSpeed < 15 || m.meanSpeed > 80 || !finite(m.meanSensing) || m.meanSensing < 20 || m.meanSensing > 160 || !finite(m.sdSpeed) || m.sdSpeed < 0 || !finite(m.sdSensing) || m.sdSensing < 0) return 'Trait measurements are outside their ranges.';
      const tolerance = 1e-9;
      const maxSpeedSD = (record.settings.speedMax - record.settings.speedMin) / 2;
      const maxSensingSD = (record.settings.sensingMax - record.settings.sensingMin) / 2;
      if (m.sdSpeed > maxSpeedSD + tolerance || m.sdSensing > maxSensingSD + tolerance) return 'Trait standard deviation exceeds the possible range.';
      if (m.population === 1 && (m.sdSpeed > tolerance || m.sdSensing > tolerance)) return 'A single organism must have zero trait spread.';
    }
    lastTick = m.tick;
  }
  if (record.measurements[0].tick !== 0 || lastTick !== finalTick) return 'Measurements must include the initial and final states.';
  const lastMeasurement = record.measurements.at(-1);
  for (const [key, value] of Object.entries(lastMeasurement)) if (!isDeepStrictEqual(record.finalSummary[key], value)) return 'Final summary must match the final measurement.';
  if (record.outcome === 'extinct' && lastMeasurement.population !== 0) return 'An extinct experiment must have no survivors.';
  if (record.outcome === 'limited' && lastMeasurement.population !== 300) return 'A limited experiment must reach the population cap.';
  // Reject invalid numbers anywhere in nested settings/summary before JSONB storage.
  function validTree(value, depth = 0) {
    if (depth > 15) return false;
    if (typeof value === 'number') return Number.isFinite(value);
    if (value === null || ['string','boolean'].includes(typeof value)) return true;
    if (Array.isArray(value)) return value.every((v) => validTree(v, depth + 1));
    if (object(value)) return Object.values(value).every((v) => validTree(v, depth + 1));
    return false;
  }
  if (!validTree(record.settings) || !validTree(record.finalSummary)) return 'Settings and summary must contain valid JSON values.';
  return null;
}







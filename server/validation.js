import { isDeepStrictEqual } from 'node:util';
import { DEFAULTS, VERSION, RAINFALL } from '../public/simulation.js';
import { validateBaselineExperiment, uuid } from './baseline-validation.js';
export { uuid } from './baseline-validation.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const integer = (value, lo, hi) => Number.isSafeInteger(value) && value >= lo && value <= hi;
const counters = ['births','deathsEnergy','deathsAge','deathsPredation'];
const traits = ['meanSpeed','sdSpeed','meanSensing','sdSensing'];
const outcomes = ['error','extinct','time_limit','limited','manual'];
const tolerance = 1e-9;

function categoryProblem(m, initial, previous, tick, settings, category) {
  if (!object(m) || !integer(m.population,0,300)) return 'Invalid category population.';
  for (const key of counters) {
    if (!integer(m[key],0,300*(tick+1)) || m[key] < (previous?.[key] ?? 0)) return 'Category counters must be nonnegative, bounded, and monotonic.';
  }
  if (previous?.population === 0 && (m.population !== 0 || counters.some(key => m[key] !== previous[key]))) return 'An extinct category cannot gain members or change cumulative birth/death counts.';
  if (m.population !== initial + m.births - m.deathsEnergy - m.deathsAge - m.deathsPredation) return 'Category population does not match births and deaths.';
  if (category === 'carnivores' && m.deathsPredation !== 0) return 'Carnivores cannot be eaten in this model.';
  if (m.population === 0) return traits.every(key=>m[key]===null) ? null : 'Empty category statistics must be null.';
  const ranges = [[m.meanSpeed,m.sdSpeed,settings.speedMin,settings.speedMax],[m.meanSensing,m.sdSensing,settings.sensingMin,settings.sensingMax]];
  for (const [mean,sd,min,max] of ranges) {
    if (!finite(mean) || mean < min-tolerance || mean > max+tolerance || !finite(sd) || sd < 0 || sd > (max-min)/2+tolerance || (m.population===1 && sd>tolerance)) return 'Category trait statistics are outside feasible bounds.';
  }
  return null;
}

export function validateExperiment(record) {
  if (!object(record)) return 'An experiment object is required.';
  if (record.modelType === undefined || record.modelType === 'baseline') return validateBaselineExperiment(record);
  if (record.modelType !== 'food-chain') return 'Unknown model type.';
  if (typeof record.id !== 'string' || !uuid.test(record.id)) return 'A valid experiment UUID is required.';
  if (typeof record.name!=='string' || !record.name.trim() || record.name.length>100 || typeof record.notes!=='string' || record.notes.length>2000) return 'Invalid experiment name or notes.';
  if (record.version!==VERSION) return 'Unsupported food-chain simulation version.';
  if (!integer(record.seed,0,4294967295)) return 'Seed must be an unsigned 32-bit integer.';
  const settings=record.settings;
  if (!object(settings) || Object.keys(settings).length!==Object.keys(DEFAULTS).length) return 'Complete versioned simulation settings are required.';
  for (const [key,value] of Object.entries(DEFAULTS)) {
    if (!Object.hasOwn(settings,key)) return 'A required simulation setting is missing.';
    if (!['initialHerbivores','initialCarnivores','rainfall'].includes(key) && !isDeepStrictEqual(settings[key],value)) return 'Simulation settings do not match this model version.';
  }
  if (!integer(settings.initialHerbivores,0,300) || !integer(settings.initialCarnivores,0,300) || settings.initialHerbivores+settings.initialCarnivores>300 || typeof settings.rainfall !== 'string' || !Object.hasOwn(RAINFALL,settings.rainfall)) return 'Invalid starting populations or rainfall.';
  if (!finite(record.duration) || record.duration<0 || record.duration>1800) return 'Duration must be within thirty simulated minutes.';
  const finalTick=Math.round(record.duration*20);
  if (Math.abs(finalTick/20-record.duration)>tolerance) return 'Duration must match an integer simulation tick.';
  if (!Array.isArray(record.measurements) || record.measurements.length<1 || record.measurements.length>1801 || !Array.isArray(record.interventions) || record.interventions.length>2000) return 'Measurement or intervention limits exceeded.';
  let lastEvent=0;
  let sameTickEvents=0;
  for (const event of record.interventions) {
    if (!object(event) || !integer(event.tick,1,finalTick) || event.tick<lastEvent || typeof event.rainfall !== 'string' || !Object.hasOwn(RAINFALL,event.rainfall)) return 'Rainfall changes must be ordered, within the run, and use a known condition.';
    sameTickEvents=event.tick===lastEvent?sameTickEvents+1:1;
    if (sameTickEvents>20) return 'A tick cannot apply more than twenty queued rainfall changes.';
    lastEvent=event.tick;
  }
  let previous=null;
  for (let i=0;i<record.measurements.length;i++) {
    const m=record.measurements[i];
    if (!object(m) || !integer(m.tick,0,finalTick) || (previous && m.tick<=previous.tick) || !finite(m.time) || Math.abs(m.time-m.tick/20)>tolerance) return 'Invalid or unordered measurement timing.';
    if (i===0 && m.tick!==0) return 'The initial measurement is required.';
    if (i>0 && i<record.measurements.length-1 && m.tick!==previous.tick+20) return 'Regular measurement ticks must be complete.';
    if (i===record.measurements.length-1 && m.tick!==finalTick) return 'The final measurement must match duration.';
    if (i===record.measurements.length-1 && previous && (m.tick>previous.tick+20 || (m.tick%20!==0 && previous.tick!==Math.floor(m.tick/20)*20))) return 'The final measurement cannot hide missing regular samples.';
    if (!integer(m.population,0,300) || !integer(m.food,0,300)) return 'Measurement counts exceed safety limits.';
    for (const [name,startKey] of [['herbivores','initialHerbivores'],['carnivores','initialCarnivores']]) {
      const problem=categoryProblem(m[name],settings[startKey],previous?.[name],m.tick,settings,name);
      if (problem) return problem;
      if (m.tick===0 && (m[name].population!==settings[startKey] || counters.some(key=>m[name][key]!==0))) return 'Initial category counts must match settings with no births or deaths.';
      if (m.tick===0 && m[name].population>0) {
        const prefix=name==='herbivores'?'initialHerbivore':'initialCarnivore';
        if (m[name].meanSpeed<settings[`${prefix}SpeedMin`]-tolerance || m[name].meanSpeed>settings[`${prefix}SpeedMax`]+tolerance || m[name].meanSensing<settings[`${prefix}SensingMin`]-tolerance || m[name].meanSensing>settings[`${prefix}SensingMax`]+tolerance) return 'Initial traits must match their initial ranges.';
        if (m[name].sdSpeed>(settings[`${prefix}SpeedMax`]-settings[`${prefix}SpeedMin`])/2+tolerance || m[name].sdSensing>(settings[`${prefix}SensingMax`]-settings[`${prefix}SensingMin`])/2+tolerance) return 'Initial trait spread exceeds the initial distribution range.';
      }
    }
    if (m.population!==m.herbivores.population+m.carnivores.population || counters.some(key=>m[key]!==m.herbivores[key]+m.carnivores[key])) return 'Total measurements must equal category sums.';
    if (m.tick===0 && m.food!==settings.initialFood) return 'Initial plant count must match settings.';
    previous=m;
  }
  if (!object(record.finalSummary) || Object.entries(previous).some(([key,value])=>!isDeepStrictEqual(record.finalSummary[key],value))) return 'Final summary must match the final measurement.';
  if (!outcomes.includes(record.outcome) || !Array.isArray(record.flags) || !record.flags.length || new Set(record.flags).size!==record.flags.length || record.flags.some(flag=>!outcomes.includes(flag)) || !record.flags.includes(record.outcome)) return 'Invalid outcome flags.';
  const primary=outcomes.find(flag=>record.flags.includes(flag));
  if (record.outcome!==primary) return 'Primary outcome does not follow precedence.';
  if (typeof record.partial!=='boolean' || record.partial!==(record.outcome==='error')) return 'Only error outcomes are partial results.';
  const final=previous;
  if (record.partial) {
    if (typeof record.finalSummary.error!=='string' || !record.finalSummary.error.trim() || record.finalSummary.error.length>2000) return 'Partial results need an error explanation.';
  } else if (record.finalSummary.error!==null) return 'Complete results cannot contain an error.';
  if (record.flags.includes('extinct')!==(final.population===0) || record.flags.includes('time_limit')!==(finalTick===36000) || record.flags.includes('limited')!==(final.population===300)) return 'Outcome flags contradict the final state.';
  if (record.flags.includes('manual') && record.flags.length!==1) return 'Manual ending cannot override a stopping condition.';
  return null;
}


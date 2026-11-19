// Presentation helpers never mutate simulation state or consume its random stream.
export function nextOrganismId(organisms, currentId, key) {
  if (key === 'Escape') return null;
  const ids = organisms.map((item) => item.id).sort((a, b) => a - b);
  if (!ids.length) return null;
  if (key === 'Enter') return ids[0];
  if (key === 'ArrowRight' || key === 'ArrowDown') {
    return ids.find((id) => currentId === null || id > currentId) ?? ids[0];
  }
  if (key === 'ArrowLeft' || key === 'ArrowUp') {
    for (let index = ids.length - 1; index >= 0; index--) {
      if (currentId === null || ids[index] < currentId) return ids[index];
    }
    return ids.at(-1);
  }
  return currentId;
}

// Keep endpoints, local extremes (including SD bands), and gap markers within a
// fixed point budget. Full precision histories remain untouched for export.
export function downsampleMeasurements(samples, field, spreadField = null, maxPoints = 600) {
  const budget = Math.max(7, Math.floor(maxPoints));
  if (samples.length <= budget) return samples;
  const buckets = Math.max(1, Math.floor((budget - 2) / 5));
  const selected = new Set([0, samples.length - 1]);
  const interior = samples.length - 2;
  for (let bucket = 0; bucket < buckets; bucket++) {
    const start = 1 + Math.floor(bucket * interior / buckets);
    const end = 1 + Math.floor((bucket + 1) * interior / buckets);
    selected.add(start);
    selected.add(end - 1);
    let minimum = Infinity;
    let maximum = -Infinity;
    let minimumIndex = start;
    let maximumIndex = start;
    let gapIndex = null;
    for (let index = start; index < end; index++) {
      const sample = samples[index];
      if (!Number.isFinite(sample[field])) {
        if (gapIndex === null) gapIndex = index;
        continue;
      }
      const spread = spreadField && Number.isFinite(sample[spreadField]) ? sample[spreadField] : 0;
      const lower = sample[field] - spread;
      const upper = sample[field] + spread;
      if (lower < minimum) { minimum = lower; minimumIndex = index; }
      if (upper > maximum) { maximum = upper; maximumIndex = index; }
    }
    selected.add(minimumIndex);
    selected.add(maximumIndex);
    if (gapIndex !== null) selected.add(gapIndex);
  }
  return [...selected].sort((a, b) => a - b).map((index) => samples[index]);
}

export function chartHistoryKey(series) {
  return series.map((item) => {
    const measurements = item.measurements || [];
    const interventions = item.interventions || [];
    const last = measurements.at(-1);
    return `${item.id || 'live'}:${measurements.length}:${last?.tick ?? ''}:${interventions.length}:${interventions.at(-1)?.tick ?? ''}`;
  }).join('|');
}

export const recordModelType = (record) => record.modelType ?? 'baseline';
export const canCompareRecords = (first, second) => recordModelType(first) === recordModelType(second);

// Presentation runs 200ms behind receipt so movement can interpolate between
// confirmed snapshots. It never predicts future biology or changes saved state.
export class SnapshotInterpolator {
  constructor(delayMs = 200) { this.delayMs = delayMs; this.frames = []; }
  reset() { this.frames = []; }
  accept(state, now) {
    if (!state || state.status !== 'running' || state.recoveryOnly) { this.reset(); return; }
    const last = this.frames.at(-1);
    if (last && state.tick === last.tick) return; // Same-tick control acknowledgements have no new motion.
    if (last && state.tick < last.tick) this.reset();
    this.frames.push({ time: now, tick: state.tick, positions: new Map(state.organisms.map(item => [item.id, { x: item.x, y: item.y }])) });
    while (this.frames.length > 2 && this.frames[1].time <= now - this.delayMs) this.frames.shift();
    if (this.frames.length > 64) this.frames.splice(0, this.frames.length - 64);
  }
  positions(state, now, reducedMotion = false) {
    const current = new Map((state?.organisms || []).map(item => [item.id, { x: item.x, y: item.y }]));
    if (!state || state.status !== 'running' || reducedMotion || state.recoveryOnly || !this.frames.length) return current;
    const time = now - this.delayMs;
    let from = this.frames[0], to = from;
    for (const frame of this.frames) {
      if (frame.time <= time) { from = frame; to = frame; }
      else { to = frame; break; }
    }
    const span = to.time - from.time;
    const alpha = span > 0 ? Math.max(0, Math.min(1, (time - from.time) / span)) : 1;
    const width = state.settings.width, height = state.settings.height;
    const wrap = (value, size) => ((value % size) + size) % size;
    const interpolate = (a, b, size) => wrap(a + (wrap(b - a + size / 2, size) - size / 2) * alpha, size);
    for (const [id, position] of current) {
      const a = from.positions.get(id), b = to.positions.get(id);
      // Current identities win: newly born animals appear at confirmed positions;
      // removed animals never become historical ghosts in a delayed frame.
      if (a && b) current.set(id, { x: interpolate(a.x, b.x, width), y: interpolate(a.y, b.y, height) });
      else current.set(id, position);
    }
    return current;
  }
}

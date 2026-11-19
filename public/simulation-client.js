// Transport and lifecycle ownership only. Biological rules run in the worker.
export function validateStartingSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Starting settings must be an object.');
  const defaults = { seed: 42, initialHerbivores: 40, initialCarnivores: 6, rainfall: 'normal' };
  for (const key of Object.keys(input)) if (!Object.hasOwn(defaults, key)) throw new Error(`Unsupported starting setting: ${key}.`);
  const settings = { ...defaults, ...input };
  if (!Number.isInteger(settings.seed) || settings.seed < 0 || settings.seed > 4294967295) throw new Error('Seed must be an unsigned 32-bit integer.');
  for (const key of ['initialHerbivores', 'initialCarnivores']) if (!Number.isInteger(settings[key]) || settings[key] < 0 || settings[key] > 300) throw new Error(`${key} must be an integer from 0 to 300.`);
  if (settings.initialHerbivores + settings.initialCarnivores > 300) throw new Error('Combined starting animal count must not exceed 300.');
  if (!['dry', 'normal', 'wet'].includes(settings.rainfall)) throw new Error('Rainfall must be dry, normal, or wet.');
  return settings;
}

export class SimulationClient {
  constructor({ workerFactory = () => new Worker(new URL('./simulation-worker.js', import.meta.url), { type: 'module' }), timeoutMs = 5000, onState = () => {}, onError = () => {}, onBusy = () => {}, setTimer = (callback, delay) => globalThis.setTimeout(callback, delay), clearTimer = timer => globalThis.clearTimeout(timer) } = {}) {
    this.workerFactory = workerFactory;
    this.timeoutMs = timeoutMs;
    this.onState = onState;
    this.onError = onError;
    this.onBusy = onBusy;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.state = null;
    this.worker = null;
    this.runId = 0;
    this.commandId = 0;
    this.pending = new Map();
    this.lifecycleId = null;
    this.watchdog = null;
    this.failed = false;
  }

  get busy() { return this.lifecycleId !== null; }

  initialize(settings = {}) { return this.reset(settings); }

  reset(settings = {}) {
    try { settings = validateStartingSettings(settings); }
    catch (error) { return Promise.reject(error); }
    this.runId++;
    this.state = null;
    this.failed = false;
    const runId = this.runId;
    try {
      const cleanupError = this.terminate();
      if (cleanupError) throw cleanupError;
      this.worker = this.workerFactory();
      this.worker.onmessage = (event) => this.receive(event.data, runId);
      this.worker.onerror = (event) => { event.preventDefault?.(); this.fail(event.message || 'The simulation worker stopped unexpectedly.', runId); };
      this.worker.onmessageerror = () => this.fail('The simulation worker sent an unreadable update.', runId);
    } catch (error) {
      this.fail(error.message || 'The simulation worker could not start.', runId);
      return Promise.reject(error);
    }
    return this.command('init', settings);
  }

  command(command, payload = {}) {
    if (!this.worker || this.failed) return Promise.reject(new Error('The simulation worker is unavailable. Reset to start a new run.'));
    const environmental = command === 'rainfall';
    const lifecycle = ['init', 'start', 'pause', 'resume', 'end'].includes(command);
    if (this.busy) return Promise.reject(new Error('Wait for the current simulation action to finish.'));
    if (environmental && [...this.pending.values()].filter((item) => item.command === 'rainfall').length >= 20) return Promise.reject(new Error('Too many rainfall changes are awaiting confirmation. Wait for an update.'));
    if (this.pending.size >= 24) return Promise.reject(new Error('Too many simulation commands are awaiting confirmation.'));
    const commandId = ++this.commandId;
    const runId = this.runId;
    return new Promise((resolve, reject) => {
      const request = { resolve, reject, timer: null, command };
      this.pending.set(commandId, request);
      try {
        if (lifecycle) { this.lifecycleId = commandId; this.onBusy(true); }
        request.timer = this.setTimer(() => this.fail('The simulation worker did not respond in time. Reset to try again.', runId), this.timeoutMs);
        this.worker.postMessage({ runId, commandId, command, payload });
      } catch (error) { this.fail(error.message || 'The simulation command could not be sent.', runId); }
    });
  }

  receive(message, sourceRunId) {
    if (sourceRunId !== this.runId || message?.runId !== this.runId || this.failed || !this.worker) return;
    try {
    const request = this.pending.get(message.commandId);
    if (message.type === 'rejected') {
      if (request) { this.finishRequest(message.commandId); request.reject(new Error(message.message || 'The simulation rejected this action.')); }
      return;
    }
    if (message.type === 'failure') { this.fail(message.message || 'The simulation worker failed.', sourceRunId); return; }
    if (message.type !== 'state' || !message.state || !Array.isArray(message.state.measurements)) {
      this.fail('The simulation worker sent an invalid state.', sourceRunId);
      return;
    }
    this.state = message.state;
    this.clearTimer(this.watchdog);
    this.watchdog = null;
    if (this.state.status === 'running') this.watchdog = this.setTimer(() => this.fail('The simulation worker stopped publishing updates.', sourceRunId), this.timeoutMs);
    if (request) { this.finishRequest(message.commandId); request.resolve(this.state); }
    this.onState(this.state);
    } catch (error) {
      this.fail(error.message || 'The simulation update could not be processed.', sourceRunId);
    }
  }

  finishRequest(commandId) {
    const request = this.pending.get(commandId);
    if (!request) return;
    this.clearTimer(request.timer);
    if (this.lifecycleId === commandId) { this.lifecycleId = null; this.onBusy(false); }
    this.pending.delete(commandId);
  }

  fail(message, sourceRunId) {
    if (sourceRunId !== this.runId || this.failed) return;
    this.failed = true;
    this.stopWorker(new Error(message));
    const sample = this.state?.measurements?.at(-1);
    if (sample) {
      const interventions = this.state.interventions.filter((event) => event.tick <= sample.tick);
      const rainfall = interventions.at(-1)?.rainfall ?? this.state.settings.rainfall;
      const flags = ['error'];
      if (sample.population === 0) flags.push('extinct');
      if (sample.tick >= this.state.settings.maxTicks) flags.push('time_limit');
      if (sample.population >= this.state.settings.populationLimit) flags.push('limited');
      this.state = {
        ...structuredClone(this.state), tick: sample.tick, status: 'ended', outcome: 'error',
        flags, partial: true, error: message, rainfall,
        organisms: [], food: [], pendingEvents: [], recoveryOnly: true,
        interventions,
        measurements: this.state.measurements.filter((item) => item.tick <= sample.tick),
        births: sample.births, deaths: { energy: sample.deathsEnergy, age: sample.deathsAge, predation: sample.deathsPredation },
      };
      this.onState(this.state);
    } else this.state = null;
    this.onError(new Error(message), { recoverable: Boolean(sample) });
  }

  stopWorker(error) {
    const watchdog = this.watchdog;
    const worker = this.worker;
    const requests = [...this.pending.values()];
    this.watchdog = null;
    this.worker = null;
    this.pending.clear();
    this.lifecycleId = null;
    let cleanupError = null;
    const attempt = operation => {
      try { operation(); }
      catch (cause) { cleanupError ??= cause; }
    };
    attempt(() => this.clearTimer(watchdog));
    if (worker) {
      attempt(() => { worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null; });
      attempt(() => worker.terminate());
    }
    for (const request of requests) {
      attempt(() => this.clearTimer(request.timer));
      request.reject(error);
    }
    attempt(() => this.onBusy(false));
    return cleanupError;
  }

  terminate() { return this.stopWorker(new Error('This simulation run was replaced or closed.')); }

  exportExperiment({ id, name, notes = '' }) {
    const state = this.state;
    if (!state || state.status !== 'ended' || !state.measurements.length) throw new Error('End a confirmed experiment before saving or downloading.');
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('A valid experiment UUID is required.');
    if (typeof name !== 'string' || !name.trim() || name.length > 100) throw new Error('Experiment name must contain 1–100 characters.');
    if (typeof notes !== 'string' || notes.length > 2000) throw new Error('Experiment notes must contain at most 2000 characters.');
    const final = state.measurements.at(-1);
    return structuredClone({ id, name, notes, modelType: state.modelType, version: state.version,
      seed: state.seed, settings: state.settings, interventions: state.interventions,
      measurements: state.measurements, outcome: state.outcome, flags: state.flags,
      partial: Boolean(state.partial), duration: final.time, finalSummary: { ...final, error: state.error || null } });
  }
}

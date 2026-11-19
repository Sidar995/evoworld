import * as defaultEngine from './simulation.js';

/** Testable worker adapter. Inject clocks/timers/engine to exercise failures without a crash command. */
export function createWorkerController({
  postMessage, setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = timer => clearTimeout(timer), now = () => performance.now(), engine = defaultEngine,
} = {}) {
  if (typeof postMessage !== 'function') throw new TypeError('Worker controller requires postMessage.');
  let sim = null;
  let runId = null;
  let timer = null;
  let disposed = false;
  let speed = 1;
  let lastCommandId = -1;
  let lastClock = 0;
  let accumulatedSeconds = 0;
  let lastPublish = -Infinity;

  function clearScheduled() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }
  function publish(commandId) {
    if (!sim || disposed) return;
    const message = { runId, type: 'state', state: engine.snapshot(sim) };
    if (commandId !== undefined) message.commandId = commandId;
    postMessage(message);
    lastPublish = now();
  }
  function reject(message, text) {
    if (!disposed) postMessage({ runId: message?.runId, commandId: message?.commandId, type: 'rejected', message: text });
  }
  function stopForFailure(error) {
    clearScheduled();
    accumulatedSeconds = 0;
    const message = error instanceof Error ? error.message : String(error);
    if (sim) {
      try {
        // Real engine restores its last valid complete tick before exposing the partial result.
        if (typeof engine.fail === 'function') engine.fail(sim, message);
        else {
          sim.status = 'error'; sim.outcome = 'error'; sim.flags = ['error']; sim.partial = true; sim.error = message;
        }
        publish();
      } catch { /* Client still retains the last confirmed published state. */ }
    }
    postMessage({ runId, type: 'failure', message });
  }
  function schedule() {
    if (!disposed && sim?.status === 'running' && timer === null) timer = setTimer(batch, 25);
  }
  function batch() {
    timer = null;
    if (disposed || sim?.status !== 'running') return;
    try {
      const currentClock = now();
      const elapsed = Math.max(0, currentClock - lastClock) / 1000;
      lastClock = currentClock;
      accumulatedSeconds += elapsed * speed;
      const dt = sim.settings.dt;
      let demand = Math.floor((accumulatedSeconds + 1e-12) / dt);
      const slow = demand > 8;
      // A slow device loses excess wall-clock demand, never simulation ticks or a biological phase.
      if (demand > 8) { demand = 8; accumulatedSeconds = demand * dt; }
      sim.performanceSlow = slow;
      for (let index = 0; index < demand && sim.status === 'running'; index++) {
        engine.step(sim);
        accumulatedSeconds = Math.max(0, accumulatedSeconds - dt);
      }
      if (sim.status !== 'running') {
        accumulatedSeconds = 0;
        publish();
        if (sim.status === 'error') postMessage({ runId, type: 'failure', message: sim.error || 'Simulation stopped unexpectedly.' });
      } else {
        if (currentClock - lastPublish >= 200) publish();
        schedule();
      }
    } catch (error) { stopForFailure(error); }
  }

  function handle(message) {
    if (disposed) return;
    if (!message || typeof message !== 'object' || !Number.isSafeInteger(message.commandId) || message.commandId < 0 || !['string', 'number'].includes(typeof message.runId)) {
      reject(message, 'Invalid worker command envelope.');
      return;
    }
    if (sim && message.runId !== runId) { reject(message, 'This worker belongs to a different run.'); return; }
    if (message.commandId <= lastCommandId) { reject(message, 'Stale or duplicate command ignored.'); return; }
    const { command, payload } = message;
    try {
      if (command === 'init') {
        if (sim) { reject(message, 'This worker is already initialized.'); return; }
        const settings = payload ?? {};
        const allowed = ['seed', 'initialHerbivores', 'initialCarnivores', 'rainfall'];
        if (typeof settings !== 'object' || Array.isArray(settings) || Object.keys(settings).some(key => !allowed.includes(key))) throw new RangeError('Only seed, starting category counts and rainfall can be configured.');
        const created = engine.createSimulation(settings);
        sim = created;
        runId = message.runId;
        lastClock = now();
      } else {
        if (!sim) { reject(message, 'Initialize this worker first.'); return; }
        switch (command) {
          case 'start': engine.start(sim); break;
          case 'pause': engine.pause(sim); break;
          case 'resume': engine.resume(sim); break;
          case 'end': engine.end(sim); break;
          case 'rainfall': engine.setRainfall(sim, payload?.value); break;
          case 'speed':
            if (![1, 2, 4].includes(payload?.value)) throw new RangeError('Playback speed must be 1, 2 or 4.');
            speed = payload.value;
            break;
          default: throw new RangeError('Unknown worker command.');
        }
      }
      lastCommandId = message.commandId;
      // Restart only the wall-clock accounting, not biology or RNG.
      if (command !== 'rainfall') {
        lastClock = now();
        accumulatedSeconds = 0;
      }
      clearScheduled();
      publish(message.commandId);
      schedule();
    } catch (error) {
      // Invalid user commands preserve engine state and are recoverable rejections.
      reject(message, error instanceof Error ? error.message : String(error));
    }
  }

  return {
    handle,
    fail: stopForFailure,
    dispose() { disposed = true; clearScheduled(); sim = null; },
    getState() { return sim ? engine.snapshot(sim) : null; },
  };
}



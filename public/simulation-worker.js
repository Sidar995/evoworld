import { createWorkerController } from './worker-runtime.js';

const controller = createWorkerController({ postMessage: message => self.postMessage(message) });
self.addEventListener('message', event => controller.handle(event.data));
self.addEventListener('messageerror', () => {
  controller.fail(new Error('The worker could not read a command. Reset to start a new run.'));
});


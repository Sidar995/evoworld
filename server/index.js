import { createApp, PgStore } from './app.js';
import { readRuntimeConfig } from './config.js';
let config;
try { config = readRuntimeConfig(); }
catch (error) { console.error(`Could not start EvoWorld: ${error.message}`); process.exit(1); }
const store = new PgStore(process.env.DATABASE_URL);
const server = createApp({ store, auth: config.auth }).listen(config.port, config.host, () => {
  console.log(`EvoWorld is listening on ${config.host}:${config.port} (${config.auth.mode} mode).`);
  console.log(process.env.DATABASE_URL ? 'PostgreSQL configured; check database status in the app.' : 'Database not configured. Simulation and JSON export work; see README.md for saving setup.');
});
server.on('error', (error) => { console.error(`Could not start EvoWorld: ${error.code || 'server error'}`); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(async () => { await store.close(); process.exit(0); }));

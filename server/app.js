import express from 'express';
import { createAuth } from './auth.js';
import { fileURLToPath } from 'node:url';
import { uuid, validateExperiment } from './validation.js';
import { parseArchiveQuery } from './archive.js';
import { PgStore } from './store.js';
import { withModelType } from './records.js';
export { PgStore } from './store.js';
export { validateExperiment } from './validation.js';

const publicPath = fileURLToPath(new URL('../public/', import.meta.url));
export function createApp({ store = new PgStore(process.env.DATABASE_URL), auth } = {}) {
  const app = express();
  app.disable('x-powered-by');
  const owner = createAuth(auth);
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    next();
  });
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use('/api/experiments', owner.protect);
  app.use('/api/auth', express.json({ limit: '8kb' }));
  app.get('/api/auth/session', (req, res) => res.json(owner.state(req)));
  app.post('/api/auth/login', owner.login);
  app.post('/api/auth/logout', owner.logout);
  app.use(express.json({ limit: '16mb' }));
  app.get('/api/health', async (_req, res) => {
    try { await store.ready(); res.json({ ok: true, database: true }); }
    catch { res.json({ ok: true, database: false, message: 'Database unavailable. Configure .env, run npm run db:setup, and restart. Simulation and JSON export still work.' }); }
  });
  app.get('/api/experiments', async (req, res) => { const page=await store.list(parseArchiveQuery(req.query)); res.json({...page,experiments:page.experiments.map(withModelType)}); });
  app.get('/api/experiments/:id', async (req, res) => {
    if (!uuid.test(req.params.id)) return res.status(400).json({ error: 'Invalid experiment ID.' });
    const experiment = await store.get(req.params.id);
    return experiment ? res.json(withModelType(experiment)) : res.status(404).json({ error: 'Experiment not found.' });
  });
  app.delete('/api/experiments/:id', async (req, res) => {
    if (!uuid.test(req.params.id)) return res.status(400).json({ error: 'Invalid experiment ID.' });
    const deleted = await store.delete(req.params.id);
    return deleted ? res.status(204).end() : res.status(404).json({ error: 'Experiment not found.' });
  });
  app.post('/api/experiments', async (req, res) => {
    if (!req.is('application/json')) return res.status(415).json({ error: 'Send experiments as application/json.' });
    const validationError = validateExperiment(req.body);
    if (validationError) return res.status(400).json({ error: validationError });
    // Keep the persisted contract independent of transport-only fields.
    const { id, name, notes, version, seed, settings, interventions, measurements, outcome, duration, finalSummary } = req.body;
    const record = { id, name, notes, version, seed, settings, interventions, measurements, outcome, duration, finalSummary };
    if (req.body.modelType !== undefined) record.modelType=req.body.modelType;
    if (req.body.modelType==='food-chain') { record.flags=req.body.flags; record.partial=req.body.partial; }
    const result = await store.save(record);
    res.status(result.duplicate ? 200 : 201).json(result);
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }));
  app.use(express.static(publicPath));
  app.use((error, req, res, _next) => {
    if (error.type === 'entity.too.large') return res.status(413).json({ error: req.path.startsWith('/api/auth/') ? 'Sign-in request is too large.' : 'Experiment is too large to save; download JSON instead.' });
    if (error instanceof SyntaxError && error.status === 400) return res.status(400).json({ error: 'Invalid JSON request.' });
    const status = [400,409,415].includes(error.status) ? error.status : 503;
    res.status(status).json({ error: status !== 503 ? error.message : 'Database unavailable. Check local PostgreSQL and .env; retry or download JSON.' });
  });
  return app;
}









import { uuid } from './validation.js';

const badQuery = () => Object.assign(new Error('Invalid archive page. Use limit 1–50 and a cursor returned by the server.'), { status: 400 });

export function encodeCursor({ createdAt, id }) {
  return Buffer.from(JSON.stringify({ createdAt, id }), 'utf8').toString('base64url');
}

export function parseArchiveQuery(query = {}) {
  const rawLimit = query.limit ?? '20';
  if (typeof rawLimit !== 'string' || !/^[1-9]\d?$/.test(rawLimit)) throw badQuery();
  const limit = Number(rawLimit);
  if (limit > 50) throw badQuery();
  let before = null;
  if (query.before !== undefined) {
    if (typeof query.before !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(query.before)) throw badQuery();
    try {
      before = JSON.parse(Buffer.from(query.before, 'base64url').toString('utf8'));
      // Preserve PostgreSQL microseconds in cursors; rounding to JS milliseconds can skip records.
      const stamp = before?.createdAt;
      if (typeof stamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/.test(stamp) || !Number.isFinite(Date.parse(stamp)) || new Date(stamp).toISOString().slice(0,19) !== stamp.slice(0,19) || typeof before?.id !== 'string' || !uuid.test(before.id)) throw badQuery();
      before = { createdAt: stamp, id: before.id };
    } catch { throw badQuery(); }
  }
  return { limit, before };
}

export function summarizeExperiment(record) {
  const { measurements, interventions, ...summary } = record;
  return summary;
}

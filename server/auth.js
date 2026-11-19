import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const derive = promisify(scrypt);
const COOKIE = 'evoworld_owner';
const LIFETIME = 4 * 60 * 60 * 1000;
export function createAuth({ mode = 'owner', password, publicOrigin = null, secure = false, now = Date.now } = {}) {
  const local = mode === 'local';
  const configured = local || (mode === 'owner' && typeof password === 'string' && password.length >= 16 && password.length <= 1024 && Boolean(publicOrigin));
  const sessions = new Map(), attempts = new Map();
  let globalAttempts = [], active = 0;
  const salt = randomBytes(32);
  const key = configured && !local ? derive(password, salt, 32) : null;
  // Derive once and keep only the key in this closure after construction.
  password = undefined;
  const prune = () => {
    const time = now();
    for (const [token, session] of sessions) if (session.expires <= time) sessions.delete(token);
    for (const [ip, values] of attempts) { const fresh = values.filter(at => at > time - 600000); if (fresh.length) attempts.set(ip, fresh); else attempts.delete(ip); }
    globalAttempts = globalAttempts.filter(at => at > time - 600000);
  };
  const tokenOf = req => {
    const cookies = (req.headers.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${COOKIE}=`));
    if (cookies.length !== 1) return null;
    const token = cookies[0].slice(COOKIE.length + 1);
    return /^[a-f0-9]{64}$/.test(token) ? token : null;
  };
  const sessionOf = req => { prune(); return sessions.get(tokenOf(req)); };
  const state = req => { const session = sessionOf(req); return { mode: local ? 'local' : 'owner', authenticated: local || Boolean(session), csrfToken: session?.csrfToken ?? null, configured }; };
  const cookie = (res, token, expires = false) => res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${expires ? 0 : LIFETIME / 1000}${secure ? '; Secure' : ''}`);
  const sameOrigin = req => Boolean(publicOrigin) && req.headers.origin === publicOrigin && !['cross-site'].includes(req.headers['sec-fetch-site']);
  const mutation = (req, res, next) => {
    if (local) return next();
    const session = sessionOf(req);
    if (!session) return res.status(401).json({ error: 'Owner sign-in required.' });
    if (!sameOrigin(req) || req.headers['x-csrf-token'] !== session.csrfToken) return res.status(403).json({ error: 'Invalid request origin or security token.' });
    next();
  };
  return {
    state,
    protect(req, res, next) {
      if (local) return next();
      if (!sessionOf(req)) return res.status(401).json({ error: 'Owner sign-in required.' });
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return mutation(req, res, next);
      next();
    },
    async login(req, res) {
      if (local) return res.json(state(req));
      if (!configured) return res.status(503).json({ error: 'Owner authentication is not configured.' });
      if (!sameOrigin(req)) return res.status(403).json({ error: 'Invalid request origin.' });
      if (!req.is('application/json')) return res.status(415).json({ error: 'Send sign-in details as application/json.' });
      prune();
      // Use the socket address only: forwarded headers cannot bypass rate limits.
      const ip = req.socket.remoteAddress || 'unknown';
      const values = attempts.get(ip) || [];
      if (values.length >= 5 || globalAttempts.length >= 40 || active >= 2 || (!attempts.has(ip) && attempts.size >= 256)) {
        res.setHeader('Retry-After', '600');
        return res.status(429).json({ error: 'Too many sign-in attempts. Try again later.' });
      }
      values.push(now()); attempts.set(ip, values); globalAttempts.push(now());
      const candidate = req.body?.password;
      if (typeof candidate !== 'string' || candidate.length > 1024) return res.status(401).json({ error: 'Incorrect owner password.' });
      active++;
      let valid = false;
      try { const supplied = await derive(candidate, salt, 32); valid = timingSafeEqual(supplied, await key); }
      finally { active--; }
      if (!valid) return res.status(401).json({ error: 'Incorrect owner password.' });
      sessions.delete(tokenOf(req));
      prune();
      while (sessions.size >= 64) sessions.delete(sessions.keys().next().value);
      const token = randomBytes(32).toString('hex');
      const session = { csrfToken: randomBytes(32).toString('hex'), expires: now() + LIFETIME };
      sessions.set(token, session); cookie(res, token);
      return res.json({ mode: 'owner', authenticated: true, csrfToken: session.csrfToken, configured: true });
    },
    logout(req, res) { mutation(req, res, () => { sessions.delete(tokenOf(req)); cookie(res, '', true); res.json(state(req)); }); },
  };
}



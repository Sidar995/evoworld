const loopback = host => ['127.0.0.1', 'localhost', '::1'].includes(host);
export function readRuntimeConfig(env = process.env) {
  const production = env.NODE_ENV === 'production' || Boolean(env.RENDER);
  const host = env.HOST || (production ? '0.0.0.0' : '127.0.0.1');
  if (!/^(?:localhost|[a-zA-Z0-9.-]+|::1)$/.test(host)) throw new Error('HOST must be a hostname or IP address.');
  const rawPort = env.PORT || '3000';
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
  const exposed = production || !loopback(host);
  const mode = env.AUTH_MODE || (exposed ? 'owner' : 'local');
  if (!['local', 'owner'].includes(mode)) throw new Error('AUTH_MODE must be local or owner.');
  if (exposed && mode !== 'owner') throw new Error('Owner authentication is required for exposed hosting.');
  let publicOrigin = null;
  if (env.PUBLIC_ORIGIN) {
    let url; try { url = new URL(env.PUBLIC_ORIGIN); } catch { throw new Error('PUBLIC_ORIGIN must be an absolute HTTP origin.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('PUBLIC_ORIGIN must contain only an HTTP origin.');
    publicOrigin = url.origin;
    if (production && url.protocol !== 'https:') throw new Error('Production PUBLIC_ORIGIN must use HTTPS.');
  }
  if (mode === 'owner' && (!publicOrigin || typeof env.OWNER_PASSWORD !== 'string' || env.OWNER_PASSWORD.length < 16 || env.OWNER_PASSWORD.length > 1024)) throw new Error('Owner mode requires PUBLIC_ORIGIN and an OWNER_PASSWORD of 16 to 1024 characters.');
  return { host, port: Number(rawPort), auth: { mode, password: mode === 'owner' ? env.OWNER_PASSWORD : undefined, publicOrigin, secure: production || publicOrigin?.startsWith('https:') === true } };
}


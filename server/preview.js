// Dependency-free preview for environments that cannot install packages.
// This is not the Express/PostgreSQL server and never pretends to save results.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const routes = { '/': ['index.html','text/html'], '/index.html': ['index.html','text/html'], '/styles.css': ['styles.css','text/css'], '/app.js': ['app.js','text/javascript'], '/simulation.js': ['simulation.js','text/javascript'], '/ui-helpers.js': ['ui-helpers.js','text/javascript'], '/simulation-client.js':['simulation-client.js','text/javascript'], '/simulation-worker.js':['simulation-worker.js','text/javascript'], '/worker-runtime.js':['worker-runtime.js','text/javascript'] };
const port = Number(process.env.PORT || 3000);
http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path.startsWith('/api/')) {
    const health = path === '/api/health';
    res.writeHead(health ? 200 : 503, { 'Content-Type':'application/json' });
    res.end(JSON.stringify(health ? {ok:true,database:false,message:'Preview mode. Run npm install and npm start for Express/PostgreSQL saving.'} : {error:'Preview mode cannot save or retrieve experiments. Download JSON, or install dependencies and start the full server.'}));
    return;
  }
  const route = routes[path];
  if (!route || req.method !== 'GET') { res.writeHead(404); res.end('Not found'); return; }
  try {
    const content = await readFile(fileURLToPath(new URL(`../public/${route[0]}`, import.meta.url)));
    res.writeHead(200, { 'Content-Type':`${route[1]}; charset=utf-8`, 'Cache-Control':'no-store' }); res.end(content);
  } catch { res.writeHead(503); res.end('The browser app files are still being prepared.'); }
}).listen(port, '127.0.0.1', () => console.log(`EvoWorld preview: http://localhost:${port} (simulation and export; no database saving)`));



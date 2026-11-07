import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { CodexClient, SessionMonitor } from './lib/codex.mjs';
import { ClaudeMonitor } from './lib/claude.mjs';
import { CompositeMonitor } from './lib/composite.mjs';
import { DemoMonitor } from './lib/demo.mjs';
import { TerminalLauncher } from './lib/terminal.mjs';
import { randomUUID } from 'node:crypto';

const publicDir = new URL('./public/', import.meta.url);
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/controls.css', ['controls.css', 'text/css; charset=utf-8']],
  ['/sources.css', ['sources.css', 'text/css; charset=utf-8']],
  ['/state.js', ['state.js', 'text/javascript; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
]);

export function isLocalRequest(req) {
  const host = req.headers.host || '';
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  if (req.headers.origin && ![`http://${host}`].includes(req.headers.origin)) return false;
  return true;
}

async function readJson(req) {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json') || req.headers['x-session-desk'] !== '1') {
    throw Object.assign(new Error('JSON and X-Session-Desk headers required'), { status: 415 });
  }
  let body = '';
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > 256 * 1024) throw Object.assign(new Error('Request body too large'), { status: 413 });
    body += chunk;
  }
  try {
    const value = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw Object.assign(new Error('Invalid JSON object'), { status: 400 }); }
}

export function createDashboard(monitor, { terminal = new TerminalLauncher() } = {}) {
  const clients = new Set();
  const broadcast = snapshot => {
    for (const client of clients) {
      // Don't accumulate unbounded output for a stalled browser tab.
      if (client.writableLength > 1024 * 1024) { client.destroy(); clients.delete(client); }
      else client.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    }
  };
  monitor.on('update', broadcast);
  const server = http.createServer(async (req, res) => {
    const json = (code, data) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if (!isLocalRequest(req)) return json(403, { error: 'Local, same-origin requests only' });
    if (!['GET', 'POST'].includes(req.method)) return json(405, { error: 'Method not allowed' });
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'POST') {
        const match = /^\/api\/session\/([^/]+)\/(attach|message|answer|terminal)$/.exec(url.pathname);
        if (!match) return json(405, { error: 'Unsupported action' });
        const body = await readJson(req);
        const id = decodeURIComponent(match[1]);
        const session = monitor.snapshot.sessions.find(s => s.id === id);
        if (!session) return json(404, { error: 'Session not found' });
        if (session.source === 'claude') return json(409, { error: 'Claude Code sessions are read-only here. Use the Claude Code terminal to continue them.' });
        if (monitor.snapshot.mode === 'demo') return json(409, { error: 'Actions are disabled for sample sessions. Start with npm start for live sessions.' });
        if (!monitor.snapshot.connected) return json(503, { error: 'Codex is disconnected. Reconnect before sending instructions.' });
        switch (match[2]) {
          case 'attach': return json(200, await monitor.attach(id));
          case 'message': {
            if (body.clientMessageId !== undefined && (typeof body.clientMessageId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(body.clientMessageId))) return json(400, { error: 'Invalid client message ID' });
            return json(200, await monitor.send(id, body.text, body.clientMessageId || randomUUID()));
          }
          case 'answer': return json(200, await monitor.answer(id, body.requestId, body.answers));
          case 'terminal': return json(200, await terminal.open(session));
        }
      }
      if (url.pathname === '/api/capabilities') {
        const config = await terminal.detect();
        return json(200, { terminal: { available: config.available, reason: config.reason || null, label: config.label || null } });
      }
      if (url.pathname === '/api/sessions') return json(200, monitor.snapshot);
      if (url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(`data: ${JSON.stringify(monitor.snapshot)}\n\n`);
        clients.add(res);
        const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
        req.on('close', () => { clearInterval(heartbeat); clients.delete(res); });
        return;
      }
      if (url.pathname.startsWith('/api/session/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/session/'.length));
        const session = monitor.snapshot.sessions.find(s => s.id === id);
        if (!session) return json(404, { error: 'Session not found' });
        if (session.source !== 'claude' && !monitor.snapshot.connected) return json(503, { error: 'Codex is disconnected. Reconnect before loading session history.' });
        return json(200, { turns: await monitor.details(id), requests: monitor.client?.requestsFor(id) || [] });
      }
      const asset = assets.get(url.pathname);
      if (!asset) return json(404, { error: 'Not found' });
      const content = await readFile(new URL(asset[0], publicDir));
      res.writeHead(200, { 'Content-Type': asset[1] });
      res.end(content);
    } catch (error) { json(error.status || (req.method === 'POST' ? 400 : 502), { error: error.message }); }
  });
  server.on('close', () => monitor.off('update', broadcast));
  server.on('error', () => monitor.stop());
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const demo = process.argv.includes('--demo');
  const port = Number(process.env.PORT || 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
  const monitor = demo ? new DemoMonitor() : new CompositeMonitor({ codex: new SessionMonitor(new CodexClient()), claude: new ClaudeMonitor() });
  const server = createDashboard(monitor);
  server.on('error', error => {
    console.error(`Cannot start Session Desk: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`\n  Session Desk → http://127.0.0.1:${port}\n  ${demo ? 'Demo mode · sample sessions' : 'Live mode · connected to your shared Codex daemon'}\n`);
    monitor.start();
  });
  const stop = () => { monitor.stop(); server.close(); server.closeAllConnections(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDashboard, isLocalRequest } from '../server.mjs';
import { DemoMonitor } from '../lib/demo.mjs';

// Invoke the real HTTP handler without binding a network socket, so these
// contract tests also run in sandboxes which forbid listen().
async function request(server, path, headers = {}, method = 'GET', body = {}) {
  const req = new EventEmitter();
  Object.assign(req, { method, url: path, headers: { host: '127.0.0.1:4317', ...headers } });
  req[Symbol.asyncIterator] = async function* () { yield typeof body === 'string' ? body : JSON.stringify(body); };
  const res = new EventEmitter();
  Object.assign(res, { headers: {}, chunks: [], status: 200, writableLength: 0 });
  res.setHeader = (key, value) => { res.headers[key.toLowerCase()] = value; };
  res.writeHead = (status, values) => { res.status = status; for (const [key, value] of Object.entries(values)) res.setHeader(key, value); };
  res.write = data => { res.chunks.push(data.toString()); if (path === '/api/events') res.emit('first'); return true; };
  res.end = data => { if (data) res.chunks.push(data.toString()); res.emit('done'); };
  const done = new Promise(resolve => { res.once(path === '/api/events' ? 'first' : 'done', resolve); });
  server.emit('request', req, res);
  await done;
  req.emit('close');
  return { status: res.status, headers: res.headers, body: res.chunks.join('') };
}

test('HTTP handler serves dashboard assets, snapshots, history and event stream', async t => {
  const monitor = new DemoMonitor();
  const server = createDashboard(monitor);
  t.after(() => { monitor.stop(); server.emit('close'); });
  for (const path of ['/', '/styles.css', '/controls.css', '/app.js', '/state.js', '/icon.svg']) {
    const response = await request(server, path);
    assert.equal(response.status, 200, path);
    assert.ok(response.body.length > 100);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
  }
  const snapshot = JSON.parse((await request(server, '/api/sessions')).body);
  assert.equal(snapshot.mode, 'demo');
  assert.equal(snapshot.sessions.length, 10);
  assert.equal(snapshot.sessions.filter(s => s.source === 'claude').length, 2);
  const history = await request(server, '/api/session/demo-session-1');
  assert.equal(JSON.parse(history.body).turns[0].items[0].type, 'userMessage');
  const events = await request(server, '/api/events');
  assert.equal(events.headers['content-type'], 'text/event-stream');
  assert.equal(JSON.parse(events.body.slice(6)).mode, 'demo');
});

test('interactive HTTP actions validate requests, route by session, and reject unsafe or demo writes', async t => {
  const monitor = new DemoMonitor();
  monitor.snapshot.mode = 'live';
  const calls = [];
  monitor.attach = async id => { calls.push(['attach', id]); return { requests: [] }; };
  monitor.send = async (...args) => { calls.push(['send', ...args]); return { status: 'sent' }; };
  monitor.answer = async (...args) => { calls.push(['answer', ...args]); return { status: 'submitted' }; };
  const terminal = { detect: async () => ({ available: true, command: ['private/path'], label: 'test' }), open: async session => { calls.push(['terminal', session.id]); return { status: 'launched' }; } };
  const server = createDashboard(monitor, { terminal });
  t.after(() => { monitor.stop(); server.emit('close'); });
  const path = '/api/session/demo-session-1';
  const headers = { 'content-type': 'application/json', 'x-session-desk': '1' };
  assert.equal((await request(server, path + '/message', {}, 'POST')).status, 415);
  assert.equal((await request(server, path + '/message', headers, 'POST', 'not json')).status, 400);
  assert.equal((await request(server, path + '/message', headers, 'POST', 'x'.repeat(270000))).status, 413);
  assert.equal((await request(server, path + '/message', { ...headers, origin: 'https://evil.example' }, 'POST')).status, 403);
  assert.equal(calls.length, 0);
  assert.equal((await request(server, path + '/attach', headers, 'POST')).status, 200);
  assert.equal((await request(server, path + '/message', headers, 'POST', { text: 'Continue', clientMessageId: 'msg-1' })).status, 200);
  assert.deepEqual(calls.at(-1), ['send', 'demo-session-1', 'Continue', 'msg-1']);
  assert.equal((await request(server, path + '/answer', headers, 'POST', { requestId: 5, answers: { choice: { answers: ['Yes'] } } })).status, 200);
  assert.deepEqual(calls.at(-1), ['answer', 'demo-session-1', 5, { choice: { answers: ['Yes'] } }]);
  assert.equal((await request(server, path + '/terminal', headers, 'POST')).status, 200);
  assert.deepEqual(calls.at(-1), ['terminal', 'demo-session-1']);
  const capabilities = JSON.parse((await request(server, '/api/capabilities')).body);
  assert.equal(capabilities.terminal.available, true);
  assert.equal(capabilities.terminal.command, undefined);
  assert.equal((await request(server, path + '/shell', headers, 'POST')).status, 405);
  monitor.snapshot.mode = 'demo';
  assert.equal((await request(server, path + '/message', headers, 'POST')).status, 409);
  monitor.snapshot.mode = 'live'; monitor.snapshot.connected = false;
  assert.equal((await request(server, path + '/message', headers, 'POST')).status, 503);
});

test('HTTP handler rejects cross-site access, mutations, unknown IDs and path traversal', async t => {
  const monitor = new DemoMonitor();
  const server = createDashboard(monitor);
  t.after(() => { monitor.stop(); server.emit('close'); });
  assert.equal((await request(server, '/api/sessions', { host: 'attacker.example' })).status, 403);
  assert.equal((await request(server, '/api/sessions', { origin: 'https://attacker.example' })).status, 403);
  assert.equal((await request(server, '/api/sessions', { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await request(server, '/api/sessions', {}, 'POST')).status, 405);
  assert.equal((await request(server, '/api/session/not-real')).status, 404);
  assert.equal((await request(server, '/..%2flib/codex.mjs')).status, 404);
  assert.equal(isLocalRequest({ headers: { host: 'localhost:4317', origin: 'http://localhost:4317' } }), true);
  monitor.snapshot.connected = false;
  assert.equal((await request(server, '/api/session/demo-session-1')).status, 503);
});

test('Claude Code sessions are read-only over HTTP, while their history loads without Codex', async t => {
  const monitor = new DemoMonitor();
  monitor.snapshot.mode = 'live';
  monitor.snapshot.connected = false;
  const server = createDashboard(monitor);
  t.after(() => { monitor.stop(); server.emit('close'); });
  const headers = { 'content-type': 'application/json', 'x-session-desk': '1' };
  const id = encodeURIComponent('claude:demo-claude-1');
  const post = await request(server, `/api/session/${id}/message`, headers, 'POST', { text: 'hi' });
  assert.equal(post.status, 409);
  assert.match(JSON.parse(post.body).error, /read-only/);
  assert.equal((await request(server, `/api/session/${id}/attach`, headers, 'POST')).status, 409);
  assert.equal((await request(server, `/api/session/${id}`)).status, 200);
});

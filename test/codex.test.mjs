import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CodexClient, SessionMonitor } from '../lib/codex.mjs';
import { transport, respond, serverFrame } from './wire-fixture.mjs';

test('proxy upgrades to WebSocket before initialization, multiplexes responses and forwards notifications', async t => {
  const calls = [];
  const child = transport((request, process) => {
    calls.push(request);
    if (request.method === 'initialize') respond(process, request, { userAgent: 'test' });
    if (request.method === 'thread/list') queueMicrotask(() => respond(process, request, { data: [] }));
    if (request.method === 'thread/loaded/list') respond(process, request, { data: ['thread-a'] });
  });
  let args;
  const client = new CodexClient({ socket: '/tmp/custom.sock', spawnProcess: (binary, argv) => { args = argv; return child; } });
  t.after(() => client.close());
  await client.connect();
  assert.deepEqual(args, ['app-server', 'proxy', '--sock', '/tmp/custom.sock']);
  assert.equal(calls[0].method, 'initialize');
  assert.equal(calls[1].method, 'initialized');
  const [a, b] = await Promise.all([client.request('thread/list'), client.request('thread/loaded/list')]);
  assert.deepEqual(a, { data: [] });
  assert.deepEqual(b, { data: ['thread-a'] });
  let event;
  client.on('notification', value => { event = value; });
  child.stdout.write(serverFrame({ method: 'thread/status/changed', params: { threadId: 'a', status: { type: 'idle' } } }));
  assert.equal(event.params.threadId, 'a');
});

test('RPC errors, process exits and timeouts settle pending requests', async t => {
  const child = transport((request, process) => {
    if (request.method === 'initialize') respond(process, request, {});
    if (request.method === 'bad') process.stdout.write(serverFrame({ id: request.id, error: { message: 'Unsupported method' } }));
  });
  const client = new CodexClient({ spawnProcess: () => child, timeout: 25 });
  t.after(() => client.close());
  await client.connect();
  await assert.rejects(client.request('bad'), /Unsupported method/);
  await assert.rejects(client.request('slow'), /timed out/);
  assert.equal(client.pending.size, 0);
  const pending = client.request('wait');
  child.stderr.write('control socket unavailable');
  child.emit('exit', 1);
  await assert.rejects(pending, /control socket unavailable/);
  assert.equal(client.ready, false);
  assert.equal(client.pending.size, 0);
});

test('failed initialization kills proxy and a later connection can recover', async t => {
  const first = transport(() => {});
  const second = transport((request, child) => { if (request.method === 'initialize') respond(child, request, {}); });
  let attempts = 0;
  const client = new CodexClient({ spawnProcess: () => ++attempts === 1 ? first : second, timeout: 20 });
  t.after(() => client.close());
  await assert.rejects(client.connect(), /timed out/);
  assert.equal(first.killed, true);
  await client.connect();
  assert.equal(client.ready, true);
});

class MockClient extends EventEmitter {
  constructor() { super(); this.calls = []; this.fail = false; }
  async connect() { if (this.fail) throw new Error('daemon offline'); }
  async request(method, params) {
    this.calls.push([method, params]);
    const base = { cwd: '/workspace/test', updatedAt: 100, createdAt: 50, source: 'cli', status: { type: 'notLoaded' } };
    if (method === 'thread/list') return { data: [{ ...base, id: 'recent' }, { ...base, id: 'no-history' }], nextCursor: 'more' };
    if (method === 'thread/loaded/list') return { data: ['old-but-active'] };
    if (method === 'thread/read') return { thread: { ...base, id: 'old-but-active', status: { type: 'active', activeFlags: ['waitingOnUserInput'] } } };
    if (method === 'thread/turns/list') {
      if (params.threadId === 'no-history') throw new Error('history unavailable');
      return { data: [{ id: 'turn-a', status: 'completed', items: [] }] };
    }
    throw new Error('Unexpected method: ' + method);
  }
  close() {}
}

test('monitor includes old loaded sessions, isolates history failures, and never resumes threads', async t => {
  const client = new MockClient();
  const monitor = new SessionMonitor(client);
  t.after(() => monitor.stop());
  await monitor.refresh();
  assert.equal(monitor.snapshot.connected, true);
  assert.equal(monitor.snapshot.hasMore, true);
  assert.equal(monitor.snapshot.sessions.length, 3);
  assert.equal(monitor.snapshot.sessions.find(s => s.id === 'old-but-active').state, 'input');
  assert.equal(monitor.snapshot.sessions.find(s => s.id === 'recent').state, 'ready');
  assert.equal(monitor.snapshot.sessions.find(s => s.id === 'no-history').state, 'offline');
  assert.equal(monitor.snapshot.sessions.find(s => s.id === 'no-history').historyError, 'history unavailable');
  assert.equal(client.calls.some(([method]) => method.includes('resume') || method.includes('start')), false);
  assert.equal((await monitor.details('recent')).length, 1);
  await assert.rejects(monitor.details('arbitrary-id'), /Unknown session/);
});

test('monitor preserves last snapshot on failure and recovers without duplicating polls', async t => {
  const client = new MockClient();
  const monitor = new SessionMonitor(client);
  t.after(() => monitor.stop());
  await Promise.all([monitor.refresh(), monitor.refresh(), monitor.refresh()]);
  assert.equal(client.calls.filter(([method]) => method === 'thread/list').length, 1);
  const sessions = monitor.snapshot.sessions;
  client.fail = true;
  await monitor.refresh();
  assert.equal(monitor.snapshot.connected, false);
  assert.equal(monitor.snapshot.sessions, sessions);
  assert.match(monitor.snapshot.error, /daemon offline/);
  client.fail = false;
  await monitor.refresh();
  assert.equal(monitor.snapshot.connected, true);
  assert.equal(monitor.snapshot.error, null);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CodexClient, SessionMonitor } from '../lib/codex.mjs';
import { transport, respond, serverFrame } from './wire-fixture.mjs';
import { TerminalLauncher } from '../lib/terminal.mjs';

const question = { method: 'item/tool/requestUserInput', id: 'server-question-1', params: {
  threadId: 'a', turnId: 'turn-a', isBlocking: true,
  questions: [{ id: 'billing', question: 'Which plan?', options: [{ label: 'Annual', description: 'Pay yearly' }] }],
} };

test('rejoined session receives a pending question and submits a structured response over WebSocket', async t => {
  let received;
  const calls = [];
  const child = transport((request, process) => {
    calls.push(request);
    if (request.method === 'initialize') respond(process, request, {});
    if (request.method === 'thread/resume') {
      respond(process, request, { thread: { id: 'a' } });
      process.stdout.write(serverFrame(question));
    }
  }, { onResponse: response => { received = response; } });
  const client = new CodexClient({ spawnProcess: () => child });
  const monitor = new SessionMonitor(client);
  t.after(() => monitor.stop());
  // No polling/model calls in this wire test.
  monitor.refresh = async () => {};
  await client.connect();
  monitor.snapshot = { connected: true, sessions: [{ id: 'a' }] };
  const attached = await monitor.attach('a');
  assert.equal(attached.requests[0].id, question.id);
  assert.deepEqual(calls.find(r => r.method === 'thread/resume').params, { threadId: 'a', excludeTurns: true });
  assert.equal(received, undefined, 'no approval or input is automatically answered');
  await assert.rejects(monitor.answer('a', question.id, {}), /every question/);
  await assert.rejects(monitor.answer('other', question.id, { billing: { answers: ['Annual'] } }), /Unknown session/);
  assert.deepEqual(await monitor.answer('a', question.id, { billing: { answers: ['Annual'] } }), { status: 'submitted' });
  assert.deepEqual(received, { id: question.id, result: { answers: { billing: { answers: ['Annual'] } } } });
  assert.equal(client.requestsFor('a').length, 1, 'wait for server resolution');
  await assert.rejects(monitor.answer('a', question.id, { billing: { answers: ['Annual'] } }), /already submitted/);
  child.stdout.write(serverFrame({ method: 'serverRequest/resolved', params: { threadId: 'a', requestId: question.id } }));
  assert.equal(client.requestsFor('a').length, 0);
  await assert.rejects(monitor.answer('a', question.id, { billing: { answers: ['Annual'] } }), /resolved/);
});

class ActionClient extends EventEmitter {
  constructor(status = { type: 'idle' }) { super(); this.status = status; this.calls = []; this.serverRequests = new Map(); }
  requestsFor() { return []; }
  async request(method, params) {
    this.calls.push([method, params]);
    if (method === 'thread/read') return { thread: { id: 'a', status: this.status } };
    if (method === 'thread/turns/list') return { data: [{ id: 'turn-a', status: 'inProgress' }] };
    return {};
  }
  close() {}
}

test('idle instructions start a turn; active instructions steer with a turn ID precondition', async t => {
  for (const type of ['idle', 'active']) {
    const client = new ActionClient({ type, activeFlags: [] });
    const monitor = new SessionMonitor(client);
    t.after(() => monitor.stop());
    monitor.refresh = async () => {};
    monitor.snapshot = { connected: true, sessions: [{ id: 'a' }] };
    assert.equal((await monitor.send('a', '  Continue the task  ', 'message-1')).status, 'sent');
    const [method, params] = client.calls.at(-1);
    assert.equal(method, type === 'idle' ? 'turn/start' : 'turn/steer');
    assert.deepEqual(params.input, [{ type: 'text', text: 'Continue the task', text_elements: [] }]);
    assert.equal(params.clientUserMessageId, 'message-1');
    assert.equal(params.expectedTurnId, type === 'active' ? 'turn-a' : undefined);
    assert.equal(params.approvalPolicy, undefined);
    assert.equal(params.sandboxPolicy, undefined);
  }
});

test('regular instructions cannot accidentally bypass a blocking question or approval', async t => {
  for (const flag of ['waitingOnApproval', 'waitingOnUserInput']) {
    const client = new ActionClient({ type: 'active', activeFlags: [flag] });
    const monitor = new SessionMonitor(client);
    t.after(() => monitor.stop());
    monitor.snapshot = { connected: true, sessions: [{ id: 'a' }] };
    await assert.rejects(monitor.send('a', 'Continue'), /approval|question/);
    assert.equal(client.calls.some(([method]) => method === 'turn/start' || method === 'turn/steer'), false);
    await assert.rejects(monitor.send('a', '   '), /instruction/);
  }
});

test('terminal launcher passes session arguments without invoking a shell', async () => {
  let invocation;
  const launcher = new TerminalLauncher({
    platform: 'linux', env: { DISPLAY: ':1', PATH: '/bin', CODEX_BIN: '/opt/codex', CODEX_SOCKET: '/tmp/daemon.sock' },
    executable: async name => name === 'kitty' ? '/bin/kitty' : null,
    spawnProcess: (program, args, options) => {
      invocation = { program, args, options };
      const child = new EventEmitter(); child.unref = () => {};
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });
  const session = { id: 'a', cwd: '/tmp/project with spaces/$(touch nope)' };
  await launcher.open(session);
  assert.equal(invocation.program, '/bin/kitty');
  assert.deepEqual(invocation.args, ['/opt/codex', 'resume', 'a', '--cd', session.cwd, '--remote', 'unix:///tmp/daemon.sock']);
  assert.equal(invocation.options.shell, false);
});

test('terminal launcher offers a clear fallback on headless hosts and validates custom configuration', async () => {
  assert.equal((await new TerminalLauncher({ platform: 'linux', env: {} }).detect()).available, false);
  assert.equal((await new TerminalLauncher({ env: { SESSION_DESK_TERMINAL: 'bad json' } }).detect()).available, false);
  const custom = await new TerminalLauncher({ env: { SESSION_DESK_TERMINAL: '["wezterm","start","--"]' } }).detect();
  assert.deepEqual(custom.command, ['wezterm', 'start', '--']);
});

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { ProxyWebSocket } from './websocket.mjs';

// Connect to the existing daemon. Starting an isolated app-server would give
// misleading notLoaded statuses for sessions owned by the real daemon.
export class CodexClient extends EventEmitter {
  constructor({ binary = process.env.CODEX_BIN || 'codex', socket = process.env.CODEX_SOCKET, spawnProcess = spawn, timeout = 12000 } = {}) {
    super();
    Object.assign(this, { binary, socket, spawnProcess, timeout });
    this.pending = new Map();
    this.serverRequests = new Map();
    this.submittedAnswers = new Set();
    this.sequence = 0;
    this.ready = false;
  }

  async connect() {
    if (this.ready) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.open().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async open() {
    const args = ['app-server', 'proxy'];
    if (this.socket) args.push('--sock', this.socket);
    const child = this.spawnProcess(this.binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    const wire = new ProxyWebSocket(child.stdout, child.stdin, this.timeout);
    this.wire = wire;
    let diagnostic = '';
    child.stderr.on('data', data => { diagnostic = (diagnostic + data).slice(-3000); });
    let failed = false;
    const fail = error => {
      if (failed) return;
      failed = true;
      wire.abort(error);
      if (this.child === child) { this.ready = false; this.child = null; }
      this.serverRequests.clear();
      this.submittedAnswers.clear();
      for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
      this.pending.clear();
      child.kill();
      this.emit('disconnected', error.message);
    };
    child.on('error', error => fail(new Error(`Cannot launch Codex: ${error.message}`)));
    wire.on('error', fail);
    child.stdin.on('error', error => fail(error));
    child.on('exit', () => fail(new Error(diagnostic.trim() || 'Codex daemon connection closed. Start it with: codex app-server daemon start')));
    wire.on('message', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.method) {
        if (message.id !== undefined) {
          // Keep human requests pending. In particular, never automatically
          // decline an approval merely because this UI doesn't implement it.
          this.serverRequests.set(message.id, message);
          this.emit('serverRequest', message);
        } else {
          if (message.method === 'serverRequest/resolved') {
            this.serverRequests.delete(message.params.requestId);
            this.submittedAnswers.delete(message.params.requestId);
          }
          if (['turn/completed', 'thread/closed'].includes(message.method)) {
            for (const [id, request] of this.serverRequests) {
              if (request.params.threadId === message.params.threadId) this.serverRequests.delete(id);
            }
          }
          this.emit('notification', message);
        }
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    try {
      await wire.start();
      await this.request('initialize', {
        clientInfo: { name: 'session_desk', title: 'Session Desk', version: '1.0.0' },
        capabilities: { experimentalApi: false, requestAttestation: false },
      });
      wire.send(JSON.stringify({ method: 'initialized' }));
      this.ready = true;
    } catch (error) { fail(error); throw error; }
  }

  request(method, params = {}) {
    if (!this.child) return Promise.reject(new Error('Codex is disconnected'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex timed out: ${method}`));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.wire.send(JSON.stringify({ id, method, params })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  close() {
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new Error('Connection closed')); }
    this.pending.clear();
    this.serverRequests.clear();
    this.submittedAnswers.clear();
    this.wire?.abort();
    this.child?.kill();
    this.child = null;
    this.ready = false;
  }

  requestsFor(threadId) {
    return [...this.serverRequests.values()].filter(request => request.params?.threadId === threadId);
  }

  answer(requestId, answers) {
    const request = this.serverRequests.get(requestId);
    if (!request || request.method !== 'item/tool/requestUserInput') throw new Error('This question is no longer available. Refresh the session.');
    if (this.submittedAnswers.has(requestId)) throw new Error('This answer was already submitted. Waiting for Codex to resolve the question.');
    if (!this.ready) throw new Error('Codex is disconnected');
    this.submittedAnswers.add(requestId);
    try { this.wire.send(JSON.stringify({ id: requestId, result: { answers } })); }
    catch (error) { this.submittedAnswers.delete(requestId); throw error; }
    // JSON-RPC responses have no response of their own. Keep the question in
    // the snapshot until serverRequest/resolved confirms daemon consumption.
    return { status: 'submitted' };
  }
}

export function classify(thread, turn) {
  const status = thread.status?.type;
  const flags = thread.status?.activeFlags || [];
  if (status === 'systemError') return 'error';
  if (status === 'active') {
    if (flags.includes('waitingOnApproval')) return 'approval';
    if (flags.includes('waitingOnUserInput')) return 'input';
    return 'processing';
  }
  if (turn?.status === 'failed') return 'error';
  if (turn?.status === 'interrupted') return 'interrupted';
  if (turn?.status === 'completed') return 'ready';
  // A persisted inProgress turn is not proof that a session is still running.
  return status === 'idle' ? 'idle' : 'offline';
}

export function summarize(thread, turn, historyError = null) {
  return {
    id: thread.id,
    title: thread.name || thread.agentNickname || thread.preview?.split('\n')[0] || 'Untitled session',
    preview: thread.preview || '', cwd: thread.cwd || '',
    branch: thread.gitInfo?.branch || '', model: thread.model || thread.modelProvider || '',
    source: typeof thread.source === 'string' ? thread.source : 'subAgent',
    parentThreadId: thread.parentThreadId || null,
    updatedAt: thread.updatedAt, createdAt: thread.createdAt,
    state: classify(thread, turn), runtime: thread.status?.type || 'notLoaded',
    lastTurn: turn ? { id: turn.id, status: turn.status, completedAt: turn.completedAt, error: turn.error?.message || null } : null,
    historyError,
  };
}

export class SessionMonitor extends EventEmitter {
  constructor(client, { interval = 3000, historyLimit = 100 } = {}) {
    super();
    Object.assign(this, { client, interval, historyLimit });
    this.cache = new Map();
    this.snapshot = { connected: false, sessions: [], updatedAt: null, error: null, mode: 'live' };
    client.on('disconnected', error => {
      this.snapshot = { ...this.snapshot, connected: false, requests: [], error };
      this.emit('update', this.snapshot);
    });
    client.on('notification', ({ method }) => {
      if (['serverRequest/resolved', 'turn/completed', 'thread/closed'].includes(method)) this.publishRequests();
      if (/^(thread\/|turn\/|serverRequest\/)/.test(method)) this.refresh();
    });
    client.on('serverRequest', () => this.publishRequests());
    this.actions = new Set();
  }

  publishRequests() {
    this.snapshot = { ...this.snapshot, requests: [...(this.client.serverRequests?.values() || [])] };
    this.emit('update', this.snapshot);
  }

  start() {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.interval);
  }

  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.poll().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async poll() {
    try {
      await this.client.connect();
      // Always fetch loaded threads separately: old but active sessions must not
      // disappear behind the recent-history limit.
      const [recent, loaded] = await Promise.all([
        this.client.request('thread/list', { limit: this.historyLimit, sortKey: 'updated_at', modelProviders: [], sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'] }),
        this.client.request('thread/loaded/list'),
      ]);
      const threads = new Map(recent.data.map(thread => [thread.id, thread]));
      // Reads do not resume, take over, or subscribe to sessions.
      for (let offset = 0; offset < loaded.data.length; offset += 8) {
        const batch = await Promise.all(loaded.data.slice(offset, offset + 8).map(async id => {
          return (await this.client.request('thread/read', { threadId: id })).thread;
        }));
        for (const thread of batch) threads.set(thread.id, thread);
      }
      const sessions = [];
      const values = [...threads.values()];
      for (let offset = 0; offset < values.length; offset += 8) {
        const batch = await Promise.all(values.slice(offset, offset + 8).map(async thread => {
          let cached = this.cache.get(thread.id);
          const key = `${thread.updatedAt}:${JSON.stringify(thread.status)}`;
          if (!cached || cached.key !== key || thread.status?.type === 'active' || Date.now() - cached.at > 30000) {
            try {
              const result = await this.client.request('thread/turns/list', { threadId: thread.id, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
              cached = { key, at: Date.now(), turn: result.data[0] || null };
              this.cache.set(thread.id, cached);
            } catch (error) { return summarize(thread, null, error.message); }
          }
          return summarize(thread, cached.turn);
        }));
        sessions.push(...batch);
      }
      const ids = new Set(values.map(t => t.id));
      for (const id of this.cache.keys()) if (!ids.has(id)) this.cache.delete(id);
      this.snapshot = { connected: true, sessions, requests: [...(this.client.serverRequests?.values() || [])], updatedAt: Date.now(), error: null, mode: 'live', historyLimit: this.historyLimit, hasMore: Boolean(recent.nextCursor) };
    } catch (error) {
      this.snapshot = { ...this.snapshot, connected: false, error: error.message };
    }
    this.emit('update', this.snapshot);
  }

  async details(id) {
    if (!this.snapshot.sessions.some(s => s.id === id)) throw new Error('Unknown session');
    const result = await this.client.request('thread/turns/list', { threadId: id, limit: 5, sortDirection: 'desc', itemsView: 'full' });
    return result.data;
  }

  requireSession(id) {
    if (!this.snapshot.sessions.some(s => s.id === id)) throw new Error('Unknown session');
    if (!this.snapshot.connected) throw new Error('Codex is disconnected');
  }

  async attach(id) {
    this.requireSession(id);
    // Rejoin without changing model, permissions, approval policy, or cwd.
    // The daemon replays outstanding server requests to the new subscriber.
    await this.client.request('thread/resume', { threadId: id, excludeTurns: true });
    this.publishRequests();
    return { requests: this.client.requestsFor(id) };
  }

  async send(id, text, clientMessageId) {
    this.requireSession(id);
    if (typeof text !== 'string' || !text.trim() || text.length > 32000) throw new Error('Enter an instruction between 1 and 32,000 characters.');
    if (this.actions.has(id)) throw new Error('An action is already being sent to this session.');
    this.actions.add(id);
    try {
      await this.attach(id);
      const { thread } = await this.client.request('thread/read', { threadId: id });
      const flags = thread.status?.activeFlags || [];
      if (flags.includes('waitingOnApproval')) throw new Error('This session needs an approval. Open it in the terminal to approve or decline.');
      if (flags.includes('waitingOnUserInput') || this.client.requestsFor(id).some(r => r.method === 'item/tool/requestUserInput' && r.params.isBlocking !== false)) {
        throw new Error('Answer the pending question using the question form below. A regular message will not resolve it.');
      }
      const input = [{ type: 'text', text: text.trim(), text_elements: [] }];
      let result;
      if (thread.status?.type === 'active') {
        const turns = await this.client.request('thread/turns/list', { threadId: id, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
        const active = turns.data.find(turn => turn.status === 'inProgress');
        if (!active) throw new Error('The active turn changed. Refresh the session before sending.');
        result = await this.client.request('turn/steer', { threadId: id, expectedTurnId: active.id, input, clientUserMessageId: clientMessageId });
      } else {
        result = await this.client.request('turn/start', { threadId: id, input, clientUserMessageId: clientMessageId });
      }
      this.cache.delete(id);
      this.refresh();
      return { status: 'sent', result };
    } finally { this.actions.delete(id); }
  }

  async answer(id, requestId, answers) {
    this.requireSession(id);
    const request = this.client.requestsFor(id).find(r => r.id === requestId && r.method === 'item/tool/requestUserInput');
    if (!request) throw new Error('This question was resolved or the connection changed. Reopen the session.');
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('Answers are required.');
    const valid = Object.create(null);
    for (const question of request.params.questions) {
      const value = Object.hasOwn(answers, question.id) ? answers[question.id]?.answers : null;
      if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== 'string' || !value[0].trim() || value[0].length > 32000) throw new Error('Provide an answer for every question.');
      valid[question.id] = { answers: [value[0].trim()] };
    }
    const result = this.client.answer(requestId, valid);
    this.refresh();
    return result;
  }

  stop() { clearInterval(this.timer); this.client.close(); }
}

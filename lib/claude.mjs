import { EventEmitter } from 'node:events';
import { access, readdir, readFile, open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

// Read-only monitor for interactive Claude Code sessions. Claude Code writes a
// registry file per running process (<config>/sessions/<pid>.json) and an
// append-only transcript per session (<config>/projects/<dir>/<sessionId>.jsonl).
// Nothing here writes to those files or talks to the Claude process.

export const CLAUDE_PREFIX = 'claude:';
export const isClaudeId = id => typeof id === 'string' && id.startsWith(CLAUDE_PREFIX);

const exists = path => access(path).then(() => true, () => false);
const isHumanPrompt = record => record.origin?.kind === 'human' || typeof record.message?.content === 'string';
const blocksOf = record => {
  const content = record.message?.content;
  return Array.isArray(content) ? content : [];
};
const userText = record => typeof record.message?.content === 'string'
  ? record.message.content
  : blocksOf(record).filter(b => b.type === 'text').map(b => b.text).join('\n');

// Claude's status values come from the CLI's session record schema:
// busy | shell | idle | waiting. Anything unknown is treated as idle.
export function classifyClaude(status, { turnEnded = false } = {}) {
  if (status === 'waiting') return 'input';
  if (status === 'busy' || status === 'shell') return 'processing';
  return turnEnded ? 'ready' : 'idle';
}

function emptyMeta() {
  return { title: '', prompt: '', branch: '', model: '', lastUserAt: 0, turnEnd: null, offset: 0, partial: Buffer.alloc(0) };
}

function applyLine(meta, line) {
  if (!line.trim()) return;
  let record;
  try { record = JSON.parse(line); } catch { return; }
  if (record.type === 'ai-title' && record.aiTitle) meta.title = record.aiTitle;
  else if (record.type === 'last-prompt' && typeof record.lastPrompt === 'string') meta.prompt = record.lastPrompt;
  else if (record.type === 'user' && isHumanPrompt(record)) meta.lastUserAt = Date.parse(record.timestamp) || meta.lastUserAt;
  else if (record.type === 'system' && record.subtype === 'turn_duration') {
    meta.turnEnd = { id: record.uuid || String(record.timestamp), at: Date.parse(record.timestamp) || 0 };
  }
  if (record.gitBranch) meta.branch = record.gitBranch;
  if (record.type === 'assistant' && record.message?.model) meta.model = record.message.model;
}

// Read the transcript incrementally: only bytes appended since the last poll.
export async function readMeta(path, cache = new Map()) {
  const info = await stat(path);
  let meta = cache.get(path) || emptyMeta();
  if (info.size < meta.offset) meta = emptyMeta(); // truncated or replaced
  if (info.size > meta.offset) {
    const length = info.size - meta.offset;
    const handle = await open(path, 'r');
    try {
      const chunk = Buffer.alloc(length);
      await handle.read(chunk, 0, length, meta.offset);
      // Split on bytes, not characters, so a multi-byte UTF-8 sequence cut at
      // the chunk boundary is completed by the next read.
      const buffer = Buffer.concat([meta.partial, chunk]);
      const end = buffer.lastIndexOf(0x0a);
      if (end !== -1) {
        for (const line of buffer.subarray(0, end).toString('utf8').split('\n')) applyLine(meta, line);
        meta.partial = buffer.subarray(end + 1);
      } else meta.partial = buffer;
      meta.offset = info.size;
    } finally { await handle.close(); }
  }
  cache.set(path, meta);
  return meta;
}

// Full read of the most recent turns, newest first, in the shape the details
// view already renders for Codex turns.
export async function readTurns(path, limit = 5) {
  const text = await readFile(path, 'utf8');
  const turns = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record.type === 'user' && isHumanPrompt(record)) {
      current = { id: record.uuid, status: 'inProgress', error: null, items: [{ type: 'userMessage', content: [{ type: 'text', text: userText(record) }] }] };
      turns.push(current);
    } else if (!current) continue;
    else if (record.type === 'assistant') {
      for (const block of blocksOf(record)) {
        if (block.type === 'text' && block.text) current.items.push({ type: 'agentMessage', text: block.text });
        else if (block.type === 'tool_use') current.items.push({ type: 'dynamicToolCall', tool: block.name || 'tool', status: 'called' });
      }
    } else if (record.type === 'system' && record.subtype === 'turn_duration') current.status = 'completed';
  }
  return turns.slice(-limit).reverse();
}

export class ClaudeMonitor extends EventEmitter {
  constructor({ home = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), interval = 3000, procRoot = '/proc' } = {}) {
    super();
    Object.assign(this, { home, interval, procRoot });
    this.transcriptCache = new Map();
    this.paths = new Map();
    this.snapshot = { connected: true, sessions: [], requests: [], updatedAt: null, error: null, mode: 'live' };
  }

  start() {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.interval);
  }

  stop() { clearInterval(this.timer); }

  refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.poll().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  // A pid alone can be reused, so compare the kernel start time recorded when
  // Claude Code wrote the registry file.
  async isAlive(record) {
    const pid = record.pid;
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      const text = await readFile(join(this.procRoot, String(pid), 'stat'), 'utf8');
      const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
      return record.procStart === undefined || fields[19] === String(record.procStart);
    } catch (error) {
      if (error.code === 'ENOENT' && await exists(join(this.procRoot, 'self'))) return false;
      // No /proc (e.g. macOS): fall back to a signal-0 probe.
      try { process.kill(pid, 0); return true; } catch (probe) { return probe.code === 'EPERM'; }
    }
  }

  async transcriptPath(record) {
    const known = this.paths.get(record.sessionId);
    if (known && await exists(known)) return known;
    const file = `${record.sessionId}.jsonl`;
    const direct = join(this.home, 'projects', String(record.cwd || '').replace(/[^A-Za-z0-9-]/g, '-'), file);
    let path = null;
    if (await exists(direct)) path = direct;
    else {
      // Fall back to a scan if Claude Code encodes the project directory differently.
      const root = join(this.home, 'projects');
      for (const dir of await readdir(root).catch(() => [])) {
        if (await exists(join(root, dir, file))) { path = join(root, dir, file); break; }
      }
    }
    if (path) this.paths.set(record.sessionId, path);
    return path;
  }

  async poll() {
    try {
      const dir = join(this.home, 'sessions');
      const files = (await readdir(dir).catch(() => [])).filter(name => /^\d+\.json$/.test(name));
      const sessions = [];
      const seen = new Set();
      for (const name of files) {
        let record;
        try { record = JSON.parse(await readFile(join(dir, name), 'utf8')); } catch { continue; }
        // Background and daemon workers are out of scope for this view.
        if (record.kind !== 'interactive' || !record.sessionId) continue;
        if (!await this.isAlive(record)) continue;
        const path = await this.transcriptPath(record);
        let meta = emptyMeta();
        let mtime = Date.now();
        if (path) {
          seen.add(path);
          meta = await readMeta(path, this.transcriptCache);
          mtime = (await stat(path)).mtimeMs;
        }
        sessions.push(this.summarize(record, meta, mtime, path));
      }
      for (const path of this.transcriptCache.keys()) if (!seen.has(path)) this.transcriptCache.delete(path);
      this.snapshot = { connected: true, sessions, requests: [], updatedAt: Date.now(), error: null, mode: 'live' };
    } catch (error) {
      this.snapshot = { ...this.snapshot, connected: false, error: error.message };
    }
    this.emit('update', this.snapshot);
  }

  summarize(record, meta, mtime, path) {
    const turnEnded = Boolean(meta.turnEnd && meta.turnEnd.at >= meta.lastUserAt);
    const state = classifyClaude(record.status, { turnEnded });
    const updatedMs = Math.max(record.statusUpdatedAt || 0, mtime);
    if (path) this.paths.set(record.sessionId, path);
    return {
      id: `${CLAUDE_PREFIX}${record.sessionId}`,
      rawId: record.sessionId,
      title: meta.title || record.name || basename(record.cwd || '') || 'Untitled session',
      preview: (meta.prompt || '').split('\n')[0].slice(0, 300),
      cwd: record.cwd || '',
      branch: meta.branch && meta.branch !== 'HEAD' ? meta.branch : '',
      model: meta.model || 'Claude Code',
      source: 'claude',
      parentThreadId: null,
      updatedAt: Math.floor(updatedMs / 1000),
      createdAt: Math.floor((record.startedAt || updatedMs) / 1000),
      state,
      runtime: record.status || 'unknown',
      waitingFor: typeof record.waitingFor === 'string' ? record.waitingFor : null,
      lastTurn: meta.turnEnd ? { id: meta.turnEnd.id, status: 'completed', completedAt: Math.floor(meta.turnEnd.at / 1000), error: null } : null,
      historyError: null,
      readOnly: true,
    };
  }

  async details(id) {
    const session = this.snapshot.sessions.find(s => s.id === id);
    if (!session) throw new Error('Unknown session');
    const path = this.paths.get(session.rawId);
    if (!path) return [];
    return readTurns(path);
  }
}

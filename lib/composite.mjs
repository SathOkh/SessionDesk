import { EventEmitter } from 'node:events';
import { isClaudeId } from './claude.mjs';

// Merges the Codex and Claude Code monitors into one snapshot. Each source keeps
// its own connection state, so a stopped Codex daemon does not hide Claude
// sessions, and vice versa. Codex remains the only source that accepts actions.
export class CompositeMonitor extends EventEmitter {
  constructor({ codex, claude }) {
    super();
    Object.assign(this, { codex, claude });
    this.snapshot = null;
    codex.on('update', () => this.merge());
    claude.on('update', () => this.merge());
    this.merge();
  }

  merge() {
    const codex = this.codex.snapshot;
    const claude = this.claude.snapshot;
    this.snapshot = {
      ...codex,
      // Actions and the Codex banner depend on the Codex connection only.
      connected: codex.connected,
      error: codex.error,
      sessions: [...codex.sessions, ...claude.sessions],
      sources: {
        codex: { connected: codex.connected, error: codex.error },
        claude: { connected: claude.connected, error: claude.error, count: claude.sessions.length },
      },
      updatedAt: Math.max(codex.updatedAt || 0, claude.updatedAt || 0) || null,
    };
    this.emit('update', this.snapshot);
  }

  get client() { return this.codex.client; }

  start() { this.codex.start(); this.claude.start(); }

  stop() { this.codex.stop(); this.claude.stop(); }

  details(id) { return isClaudeId(id) ? this.claude.details(id) : this.codex.details(id); }

  attach(id) { return this.codex.attach(id); }

  send(id, text, clientMessageId) { return this.codex.send(id, text, clientMessageId); }

  answer(id, requestId, answers) { return this.codex.answer(id, requestId, answers); }
}

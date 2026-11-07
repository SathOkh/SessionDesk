import { EventEmitter } from 'node:events';

export class DemoMonitor extends EventEmitter {
  constructor() {
    super();
    const now = Math.floor(Date.now() / 1000);
    const examples = [
      ['approval', 'Add OAuth sign-in', 'atlas-web', 'feat/oauth', 'The migration is ready. Codex needs approval to run the database command.', 42],
      ['input', 'Design the billing settings', 'atlas-web', 'feat/billing', 'Should annual billing use a separate price, or apply a discount to the monthly price?', 83],
      ['processing', 'Fix flaky integration tests', 'api-service', 'fix/test-isolation', 'Investigating shared fixtures and running the integration suite.', 16],
      ['processing', 'Build the session dashboard', 'session-desk', 'main', 'Connecting the live session feed and checking status transitions.', 8],
      ['ready', 'Optimize the activity feed', 'atlas-web', 'perf/activity-feed', 'Added cursor pagination and removed duplicate queries. All 24 tests pass.', 190],
      ['ready', 'Document the release workflow', 'platform', 'docs/releases', 'Release checklist and rollback instructions are ready for review.', 480],
      ['error', 'Upgrade the database client', 'api-service', 'chore/db-client', 'The registry request failed. Check the connection before retrying.', 920],
      ['offline', 'Explore the search architecture', 'search-service', 'main', 'Compare indexing approaches for the project search.', 3600],
    ];
    const claudeExamples = [
      ['processing', 'Claude Code job monitoring', 'session-desk', 'main', 'Writing the transcript reader and checking turn boundaries.', 5],
      ['ready', 'Refactor the login form', 'atlas-web', 'feat/login', 'Extracted the validation helpers. The form tests pass.', 300],
    ];
    this.snapshot = {
      connected: true, mode: 'demo', updatedAt: Date.now(), error: null,
      sources: { codex: { connected: true, error: null }, claude: { connected: true, error: null, count: claudeExamples.length } },
      sessions: [...examples.map(([state, title, project, branch, preview, age], i) => ({
        id: `demo-session-${i + 1}`, title, cwd: `/workspace/${project}`, branch, preview,
        state, runtime: ['approval', 'input', 'processing'].includes(state) ? 'active' : state === 'offline' ? 'notLoaded' : 'idle',
        model: 'Codex', source: 'cli', parentThreadId: null,
        updatedAt: now - age, createdAt: now - age - 1800,
        lastTurn: { id: `turn-${i}`, status: state === 'ready' ? 'completed' : state === 'error' ? 'failed' : 'inProgress', error: state === 'error' ? preview : null },
      })), ...claudeExamples.map(([state, title, project, branch, preview, age], i) => ({
        id: `claude:demo-claude-${i + 1}`, rawId: `demo-claude-${i + 1}`, title, cwd: `/workspace/${project}`, branch, preview,
        state, runtime: state === 'processing' ? 'busy' : 'idle', model: 'Claude Code', source: 'claude', parentThreadId: null,
        updatedAt: now - age, createdAt: now - age - 1800, readOnly: true, waitingFor: null,
        lastTurn: { id: `claude-turn-${i}`, status: 'completed', completedAt: now - age, error: null },
      }))],
    };
  }
  start() { this.timer = setInterval(() => this.refresh(), 3000); }
  refresh() { this.snapshot.updatedAt = Date.now(); this.emit('update', this.snapshot); }
  async details(id) {
    const session = this.snapshot.sessions.find(s => s.id === id);
    if (!session) throw new Error('Unknown session');
    return [{ id: session.lastTurn.id, status: session.lastTurn.status, items: [
      { type: 'userMessage', content: [{ type: 'text', text: session.title }] },
      { type: 'agentMessage', text: session.preview },
    ] }];
  }
  stop() { clearInterval(this.timer); }
}

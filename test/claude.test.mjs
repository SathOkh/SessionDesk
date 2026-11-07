import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, appendFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeMonitor, classifyClaude, readTurns, readMeta } from '../lib/claude.mjs';
import { CompositeMonitor } from '../lib/composite.mjs';
import { selectSessions, resumeCommand } from '../public/state.js';

const sessionId = '11111111-2222-3333-4444-555555555555';
const cwd = '/work/example-project';
const encoded = '-work-example-project';

// The kernel start time Claude Code would have recorded for this very process.
async function liveProcStart(pid = process.pid) {
  const text = await readFile(`/proc/${pid}/stat`, 'utf8');
  return text.slice(text.lastIndexOf(')') + 2).split(' ')[19];
}

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'session-desk-claude-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, 'sessions'), { recursive: true });
  await mkdir(join(home, 'projects', encoded), { recursive: true });
  return home;
}

const record = (overrides = {}) => ({
  pid: process.pid, procStart: undefined, sessionId, cwd, kind: 'interactive', name: 'example', status: 'idle',
  startedAt: Date.parse('2026-11-07T18:00:00Z'), statusUpdatedAt: Date.parse('2026-11-07T18:00:00Z'), ...overrides,
});
const line = object => JSON.stringify(object) + '\n';
const transcriptPath = home => join(home, 'projects', encoded, `${sessionId}.jsonl`);

test('Claude status values map onto Session Desk states', () => {
  assert.equal(classifyClaude('busy'), 'processing');
  assert.equal(classifyClaude('shell'), 'processing');
  assert.equal(classifyClaude('waiting'), 'input');
  assert.equal(classifyClaude('idle', { turnEnded: true }), 'ready');
  assert.equal(classifyClaude('idle', { turnEnded: false }), 'idle');
  assert.equal(classifyClaude('something-new', { turnEnded: false }), 'idle');
});

test('ClaudeMonitor lists live interactive sessions and follows status and transcript changes', async t => {
  const home = await fixture(t);
  const procStart = await liveProcStart();
  await writeFile(join(home, 'sessions', `${process.pid}.json`), JSON.stringify(record({ procStart })));
  // Same pid with a different start time means the pid was reused: not live.
  await writeFile(join(home, 'sessions', '1.json'), JSON.stringify(record({ pid: 1, procStart: '1', sessionId: 'reused' })));
  await writeFile(transcriptPath(home), [
    line({ type: 'ai-title', aiTitle: 'Build the monitor', sessionId }),
    line({ type: 'user', origin: { kind: 'human' }, uuid: 'u1', timestamp: '2026-11-07T18:01:00.000Z', message: { role: 'user', content: 'Build the monitor please' }, gitBranch: 'feat/monitor' }),
    line({ type: 'assistant', uuid: 'a1', timestamp: '2026-11-07T18:01:05.000Z', message: { model: 'claude-test', content: [{ type: 'text', text: 'Done.' }] } }),
    line({ type: 'system', subtype: 'turn_duration', uuid: 'd1', timestamp: '2026-11-07T18:01:06.000Z' }),
  ].join(''));

  const monitor = new ClaudeMonitor({ home, interval: 60000, procRoot: '/proc' });
  t.after(() => monitor.stop());
  await monitor.poll();
  let [session] = monitor.snapshot.sessions;
  assert.equal(monitor.snapshot.sessions.length, 1, 'pid reuse must not produce a session');
  assert.equal(session.id, `claude:${sessionId}`);
  assert.equal(session.rawId, sessionId);
  assert.equal(session.source, 'claude');
  assert.equal(session.title, 'Build the monitor');
  assert.equal(session.branch, 'feat/monitor');
  assert.equal(session.state, 'ready');
  assert.equal(session.lastTurn.id, 'd1');

  await writeFile(join(home, 'sessions', `${process.pid}.json`), JSON.stringify(record({ procStart, status: 'busy' })));
  await monitor.poll();
  assert.equal(monitor.snapshot.sessions[0].state, 'processing');

  await writeFile(join(home, 'sessions', `${process.pid}.json`), JSON.stringify(record({ procStart, status: 'waiting', waitingFor: 'input needed' })));
  await monitor.poll();
  assert.equal(monitor.snapshot.sessions[0].state, 'input');
  assert.equal(monitor.snapshot.sessions[0].waitingFor, 'input needed');

  // A new human prompt after the last turn end means the agent is between turns.
  await appendFile(transcriptPath(home), line({ type: 'user', origin: { kind: 'human' }, uuid: 'u2', timestamp: '2026-11-07T18:05:00.000Z', message: { role: 'user', content: 'Also add tests' } }));
  await writeFile(join(home, 'sessions', `${process.pid}.json`), JSON.stringify(record({ procStart, status: 'idle' })));
  await monitor.poll();
  assert.equal(monitor.snapshot.sessions[0].state, 'idle');
  assert.equal(monitor.snapshot.sessions[0].preview, '', 'no last-prompt event yet');

  await appendFile(transcriptPath(home), line({ type: 'system', subtype: 'turn_duration', uuid: 'd2', timestamp: '2026-11-07T18:05:30.000Z' }));
  await monitor.poll();
  assert.equal(monitor.snapshot.sessions[0].state, 'ready');
  assert.equal(monitor.snapshot.sessions[0].lastTurn.id, 'd2');
});

test('ClaudeMonitor ignores background and daemon workers', async t => {
  const home = await fixture(t);
  await writeFile(join(home, 'sessions', `${process.pid}.json`), JSON.stringify(record({ procStart: await liveProcStart(), kind: 'bg' })));
  const monitor = new ClaudeMonitor({ home, interval: 60000 });
  t.after(() => monitor.stop());
  await monitor.poll();
  assert.deepEqual(monitor.snapshot.sessions, []);
  assert.equal(monitor.snapshot.connected, true);
});

test('ClaudeMonitor with no Claude Code directory reports zero sessions instead of failing', async t => {
  const home = await mkdtemp(join(tmpdir(), 'session-desk-empty-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const monitor = new ClaudeMonitor({ home, interval: 60000 });
  t.after(() => monitor.stop());
  await monitor.poll();
  assert.equal(monitor.snapshot.connected, true);
  assert.equal(monitor.snapshot.error, null);
  assert.deepEqual(monitor.snapshot.sessions, []);
});

test('transcript reader handles partial lines and multi-byte text split across reads', async t => {
  const home = await fixture(t);
  const path = transcriptPath(home);
  const cache = new Map();
  const full = Buffer.from(line({ type: 'ai-title', aiTitle: 'Café ☕ planning' }));
  // Cut in the middle of the 3-byte ☕ character, before the line is complete.
  const cut = full.indexOf(Buffer.from('☕')) + 1;
  await writeFile(path, full.subarray(0, cut));
  let meta = await readMeta(path, cache);
  assert.equal(meta.title, '');
  await appendFile(path, full.subarray(cut));
  meta = await readMeta(path, cache);
  assert.equal(meta.title, 'Café ☕ planning');
});

test('readTurns returns the newest turns first with user and agent items', async t => {
  const home = await fixture(t);
  await writeFile(transcriptPath(home), [
    line({ type: 'user', origin: { kind: 'human' }, uuid: 't1', message: { content: 'first' } }),
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'reply one' }] } }),
    line({ type: 'system', subtype: 'turn_duration', uuid: 'e1', timestamp: '2026-11-07T18:00:00.000Z' }),
    line({ type: 'user', origin: { kind: 'human' }, uuid: 't2', message: { content: [{ type: 'text', text: 'second' }] } }),
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }, { type: 'text', text: 'reply two' }] } }),
  ].join(''));
  const turns = await readTurns(transcriptPath(home), 5);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].id, 't2');
  assert.equal(turns[0].status, 'inProgress');
  assert.deepEqual(turns[0].items.map(i => i.type), ['userMessage', 'dynamicToolCall', 'agentMessage']);
  assert.equal(turns[1].status, 'completed');
  assert.equal(turns[1].items[1].text, 'reply one');
  assert.equal((await readTurns(transcriptPath(home), 1)).length, 1);
});

test('composite monitor merges sources and keeps Codex connection state separate', () => {
  const codex = new EventEmitter();
  codex.snapshot = { connected: false, error: 'daemon down', sessions: [{ id: 'codex-1', source: 'cli' }], updatedAt: 100, mode: 'live' };
  codex.details = async () => [];
  const claude = new ClaudeMonitor({ home: '/nonexistent' });
  claude.snapshot = { connected: true, error: null, sessions: [{ id: 'claude:x', source: 'claude', state: 'processing' }], updatedAt: 200, mode: 'live' };
  const composite = new CompositeMonitor({ codex, claude });
  const updates = [];
  composite.on('update', snapshot => updates.push(snapshot));
  codex.emit('update', codex.snapshot);
  const merged = updates.at(-1);
  assert.equal(merged.sessions.length, 2);
  assert.equal(merged.connected, false, 'actions and banner follow the Codex connection');
  assert.equal(merged.sources.codex.connected, false);
  assert.equal(merged.sources.claude.connected, true);
  assert.equal(merged.sources.claude.count, 1);
  assert.equal(merged.updatedAt, 200);
});

test('state helpers filter by source and build a Claude resume command', () => {
  const sessions = [
    { id: 'a', title: 'Codex work', cwd: '/p', updatedAt: 1, state: 'processing', source: 'cli' },
    { id: 'claude:b', rawId: 'b', title: 'Claude work', cwd: '/p', updatedAt: 2, state: 'processing', source: 'claude' },
  ];
  assert.deepEqual(selectSessions(sessions, { source: 'claude' }).map(s => s.id), ['claude:b']);
  assert.deepEqual(selectSessions(sessions, { source: 'codex' }).map(s => s.id), ['a']);
  assert.equal(selectSessions(sessions, { source: 'all' }).length, 2);
  assert.equal(resumeCommand(sessions[1]), "cd '/p' && claude --resume 'b'");
  assert.match(resumeCommand(sessions[0]), /^codex resume 'a'/);
});

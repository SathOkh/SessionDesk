import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../lib/codex.mjs';
import { displayState, revision, selectSessions, resumeCommand } from '../public/state.js';

test('live status overrides stale completed turns and approval takes precedence', () => {
  const completed = { status: 'completed' };
  for (const [flags, expected] of [[[], 'processing'], [['waitingOnApproval'], 'approval'], [['waitingOnUserInput'], 'input'], [['waitingOnUserInput', 'waitingOnApproval'], 'approval']]) {
    assert.equal(classify({ status: { type: 'active', activeFlags: flags } }, completed), expected);
  }
  assert.equal(classify({ status: { type: 'systemError' } }, completed), 'error');
});

test('persisted turn states are not mistaken for live processing', () => {
  const unloaded = { status: { type: 'notLoaded' } };
  assert.equal(classify(unloaded, { status: 'inProgress' }), 'offline');
  assert.equal(classify(unloaded, { status: 'completed' }), 'ready');
  assert.equal(classify(unloaded, { status: 'failed' }), 'error');
  assert.equal(classify(unloaded, { status: 'interrupted' }), 'interrupted');
  assert.equal(classify(unloaded, null), 'offline');
  assert.equal(classify({ status: { type: 'idle' } }, null), 'idle');
});

test('finished is local to a response revision and new activity reopens it', () => {
  const session = { id: 'a', state: 'ready', updatedAt: 10, lastTurn: { id: 'turn-a' } };
  const finished = { a: revision(session) };
  assert.equal(displayState(session, finished), 'finished');
  assert.equal(displayState({ ...session, updatedAt: 11 }, finished), 'ready');
  assert.equal(displayState({ ...session, lastTurn: { id: 'turn-b' } }, finished), 'ready');
  assert.equal(displayState({ ...session, state: 'processing' }, finished), 'processing');
});

test('search, filters, attention precedence, project, and pins compose', () => {
  const sessions = [
    { id: 'a', title: 'Polish billing', state: 'ready', cwd: '/web', branch: 'billing', updatedAt: 30 },
    { id: 'b', title: 'Fix API', state: 'processing', cwd: '/api', branch: 'fix', updatedAt: 20 },
    { id: 'c', title: 'Approve migration', state: 'approval', cwd: '/api', branch: 'db', updatedAt: 10 },
  ];
  assert.deepEqual(selectSessions(sessions).map(s => s.id), ['c', 'b', 'a']);
  assert.deepEqual(selectSessions(sessions, { query: 'BILLING' }).map(s => s.id), ['a']);
  assert.deepEqual(selectSessions(sessions, { project: '/api', filter: 'attention' }).map(s => s.id), ['c']);
  assert.deepEqual(selectSessions(sessions, { pins: ['b'], filter: 'pinned' }).map(s => s.id), ['b']);
  assert.deepEqual(selectSessions(sessions, { sort: 'recent' }).map(s => s.id), ['a', 'b', 'c']);
});

test('resume commands quote untrusted path and session fields for POSIX shells', () => {
  assert.equal(resumeCommand({ id: 'abc', cwd: "/tmp/sam's work/$(touch nope)" }), "codex resume 'abc' --cd '/tmp/sam'\\''s work/$(touch nope)'");
  assert.equal(resumeCommand({ id: 'abc' }), "codex resume 'abc'");
});

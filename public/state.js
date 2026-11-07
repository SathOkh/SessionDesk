export const states = {
  approval: { label: 'Approval needed', group: 'attention', rank: 0, hint: 'Approve or decline in the original Codex session.' },
  input: { label: 'Input needed', group: 'attention', rank: 1, hint: 'Codex has a question. Answer it below to let the agent continue.' },
  error: { label: 'Error', group: 'attention', rank: 2, hint: 'Open the session to investigate and retry.' },
  interrupted: { label: 'Interrupted', group: 'attention', rank: 3, hint: 'The last turn was interrupted.' },
  processing: { label: 'Processing', group: 'processing', rank: 4, hint: 'Codex is working.' },
  ready: { label: 'Response ready', group: 'ready', rank: 5, hint: 'Codex finished its turn. Review the result before marking the task finished.' },
  finished: { label: 'Finished', group: 'finished', rank: 6, hint: 'You marked this response finished in Session Desk.' },
  idle: { label: 'Idle', group: 'other', rank: 7, hint: 'The session is loaded and has no active turn.' },
  offline: { label: 'Not running', group: 'other', rank: 8, hint: 'Not loaded on the connected daemon. It may be running in an isolated process or on another server.' },
};
export function revision(session) { return `${session.lastTurn?.id || ''}:${session.updatedAt}`; }
export function displayState(session, finished = {}) {
  return session.state === 'ready' && finished[session.id] === revision(session) ? 'finished' : session.state;
}
export const sourceLabels = { codex: 'Codex', claude: 'Claude Code' };
export function sourceOf(session) { return session.source === 'claude' ? 'claude' : 'codex'; }
export function selectSessions(sessions, { query = '', filter = 'all', project = '', source = 'all', sort = 'attention', finished = {}, pins = [] } = {}) {
  const search = query.toLowerCase().trim();
  return sessions.filter(session => {
    const state = displayState(session, finished);
    return (!search || [session.title, session.preview, session.cwd, session.branch, session.id].join(' ').toLowerCase().includes(search))
      && (!project || session.cwd === project)
      && (source === 'all' || sourceOf(session) === source)
      && (filter === 'all' || (filter === 'pinned' ? pins.includes(session.id) : states[state]?.group === filter));
  }).sort((a, b) => {
    if (sort === 'recent') return b.updatedAt - a.updatedAt;
    if (sort === 'project') return a.cwd.localeCompare(b.cwd) || b.updatedAt - a.updatedAt;
    return (states[displayState(a, finished)]?.rank ?? 9) - (states[displayState(b, finished)]?.rank ?? 9)
      || Number(pins.includes(b.id)) - Number(pins.includes(a.id)) || b.updatedAt - a.updatedAt;
  });
}
export function resumeCommand(session) {
  const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
  if (sourceOf(session) === 'claude') {
    return `${session.cwd ? `cd ${quote(session.cwd)} && ` : ''}claude --resume ${quote(session.rawId || session.id)}`;
  }
  return `codex resume ${quote(session.id)}${session.cwd ? ` --cd ${quote(session.cwd)}` : ''}`;
}

import { states, revision, displayState, selectSessions, resumeCommand, sourceLabels, sourceOf } from './state.js';

const $ = selector => document.querySelector(selector);
const escape = text => String(text ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const save = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { toast('Browser storage is unavailable. Changes will last for this visit.'); } };
let finished = read('desk.finished', {});
let pins = read('desk.pins', []);
if (!finished || typeof finished !== 'object' || Array.isArray(finished)) finished = {};
if (!Array.isArray(pins)) pins = [];
let view = read('desk.view', 'list') === 'board' ? 'board' : 'list';
let filter = 'all';
let snapshot = { connected: false, sessions: [], updatedAt: null, mode: 'live' };
let streamConnected = false;
let selectedId = null;
let detailVersion = '';
let detailGeneration = 0;
let previous = new Map();
let firstSnapshot = true;
let toastTimer;
let notificationsEnabled = read('desk.notifications', false);
let terminalConfig = { available: false, reason: 'Checking available terminals…' };
const attached = new Set();
const attaching = new Map();
const drafts = new Map();
const sending = new Set();
const submittedRequests = new Set();
const questionForms = new Map();
const names = { all: 'All sessions', attention: 'Needs attention', processing: 'Processing', ready: 'Response ready', finished: 'Finished', pinned: 'Pinned' };
const projectName = cwd => cwd?.split(/[\\/]/).filter(Boolean).at(-1) || 'No project';
const timeAgo = timestamp => {
  if (!timestamp) return '—';
  const age = Math.max(0, Math.floor(Date.now() / 1000 - timestamp));
  return age < 60 ? 'Just now' : age < 3600 ? `${Math.floor(age / 60)}m ago` : age < 86400 ? `${Math.floor(age / 3600)}h ago` : `${Math.floor(age / 86400)}d ago`;
};
const badge = state => `<span class="badge ${escape(state)}"><span class="badge-dot"></span>${escape(states[state]?.label || state)}</span>`;
const sourceTag = session => `<span class="source-tag ${sourceOf(session)}">${escape(sourceLabels[sourceOf(session)])}</span>`;
// Claude sessions come from the local transcript and cannot receive instructions here.
const readOnly = session => sourceOf(session) === 'claude';
const pinButton = session => `<button class="row-action ${pins.includes(session.id) ? 'pinned' : ''}" data-pin="${escape(session.id)}" aria-label="${pins.includes(session.id) ? 'Unpin' : 'Pin'} ${escape(session.title)}" aria-pressed="${pins.includes(session.id)}">${pins.includes(session.id) ? '★' : '☆'}</button>`;

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3500);
}

function updateConnection() {
  const connected = snapshot.connected && streamConnected;
  for (const selector of ['#sidebar-dot', '#live-dot']) $(selector).className = `connection-dot ${connected ? 'connected' : 'disconnected'}`;
  $('#sidebar-connection').innerHTML = `${snapshot.mode === 'demo' ? 'Demo workspace' : connected ? 'Connected to Codex' : 'Connection unavailable'}<small>${snapshot.mode === 'demo' ? 'Sample sessions · no live data' : 'Local daemon · interactive'}</small>`;
  $('#live-label').textContent = connected ? snapshot.mode === 'demo' ? 'Demo feed' : 'Live updates' : 'Disconnected';
  $('#last-sync').textContent = snapshot.updatedAt ? `${connected ? 'Synced' : 'Last synced'} ${timeAgo(snapshot.updatedAt / 1000).toLowerCase()}` : 'Waiting for first sync';
  $('#mode').textContent = snapshot.mode === 'demo' ? 'DEMO' : 'LOCAL';
  const banner = $('#banner');
  banner.className = `banner ${snapshot.mode === 'demo' && connected ? 'demo' : ''}`;
  if (!connected) {
    banner.hidden = false;
    const heading = snapshot.updatedAt ? 'Codex connection lost · Codex statuses below may be out of date' : snapshot.error ? 'Unable to connect to Codex' : 'Connecting to your Codex daemon';
    banner.innerHTML = `<strong>${heading}</strong>${snapshot.error ? 'Check the connection error below. If the daemon is stopped, run <code>codex app-server daemon start</code> in your terminal.' : 'Connecting to the shared daemon on your machine.'} Sessions started with <code>--no-daemon</code> are outside this view. We’ll reconnect automatically.${snapshot.error ? `<pre>${escape(snapshot.error)}</pre>` : ''}`;
  } else if (snapshot.mode === 'demo') {
    banner.hidden = false;
    banner.innerHTML = '<strong>Demo workspace</strong>These are sample sessions. Start with <code>npm start</code> to see your own Codex activity.';
  } else banner.hidden = true;
}

function render() {
  updateConnection();
  const counts = { all: snapshot.sessions.length, attention: 0, processing: 0, ready: 0, finished: 0, pinned: 0 };
  for (const session of snapshot.sessions) {
    const group = states[displayState(session, finished)]?.group;
    if (group in counts) counts[group]++;
    if (pins.includes(session.id)) counts.pinned++;
  }
  for (const [key, value] of Object.entries(counts)) {
    const counter = $(`[data-count="${key}"]`);
    if (counter) counter.textContent = value;
    const stat = $(`#stat-${key}`);
    if (stat) stat.textContent = value;
  }
  document.querySelectorAll('.nav-item').forEach(button => {
    button.classList.toggle('active', button.dataset.filter === filter);
    if (button.dataset.filter === filter) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  $('#breadcrumb').textContent = names[filter];
  $('#sessions-heading').innerHTML = `${escape(names[filter])} <span id="result-count">0</span>`;
  const project = $('#project').value;
  const projects = [...new Set(snapshot.sessions.map(s => s.cwd).filter(Boolean))].sort();
  const projectHtml = '<option value="">All projects</option>' + projects.map(cwd => `<option value="${escape(cwd)}">${escape(projectName(cwd))}</option>`).join('');
  if ($('#project').innerHTML !== projectHtml) { $('#project').innerHTML = projectHtml; $('#project').value = projects.includes(project) ? project : ''; }
  const sessions = selectSessions(snapshot.sessions, { query: $('#search').value, filter, project: $('#project').value, source: $('#source').value, sort: $('#sort').value, finished, pins });
  $('#result-count').textContent = sessions.length;
  $('#shown-count').textContent = `Showing ${sessions.length} of ${snapshot.sessions.length} sessions${snapshot.hasMore ? ` · latest ${snapshot.historyLimit} + all loaded sessions` : ''}${!snapshot.connected || !streamConnected ? ' · awaiting live connection' : ''}`;
  $('#list-view').classList.toggle('selected', view === 'list');
  $('#board-view').classList.toggle('selected', view === 'board');
  $('#list-view').setAttribute('aria-pressed', view === 'list');
  $('#board-view').setAttribute('aria-pressed', view === 'board');
  let html;
  if (!sessions.length) {
    const noData = snapshot.sessions.length === 0;
    html = `<div class="empty-state"><div class="empty-symbol">${noData ? '⌘' : '⌕'}</div><h3>${noData ? snapshot.connected ? 'A clear desk. A fresh start.' : 'Let’s connect your sessions.' : 'Nothing here right now.'}</h3><p>${noData ? snapshot.connected ? 'Start a Codex session in your terminal. It will appear here automatically.' : 'Start the shared Codex daemon in your terminal.<br><code>codex app-server daemon start</code>' : filter === 'finished' ? 'Review a completed response, then mark it finished in its details.' : 'Try a different search, project, or session filter.'}</p>${!noData ? '<button class="button" data-clear>Show all sessions</button>' : ''}</div>`;
  } else if (view === 'board') {
    const columns = [['attention', 'Needs attention'], ['processing', 'Processing'], ['ready', 'Response ready'], ['finished', 'Finished / idle']];
    html = '<div class="board">' + columns.map(([group, title]) => {
      const items = sessions.filter(s => group === 'finished' ? ['finished', 'other'].includes(states[displayState(s, finished)]?.group) : states[displayState(s, finished)]?.group === group);
      return `<section class="board-column"><h3>${escape(title)}<small>${items.length}</small></h3>${items.map(card).join('') || '<p class="column-empty">Nothing here. Room to breathe.</p>'}</section>`;
    }).join('') + '</div>';
  } else {
    html = '<div class="session-table" role="table" aria-label="Codex sessions"><div class="table-head" role="row"><span role="columnheader">SESSION</span><span role="columnheader">STATUS</span><span role="columnheader">PROJECT / BRANCH</span><span role="columnheader">UPDATED</span><span class="sr-only" role="columnheader">Pin session</span></div>' + sessions.map(row).join('') + '</div>';
  }
  // Avoid replacing focused elements or triggering a live-region announcement on
  // every poll when the displayed data has not changed.
  const active = document.activeElement;
  const focusRow = active?.dataset?.session;
  const focusPin = active?.dataset?.pin;
  if ($('#sessions').innerHTML !== html) {
    $('#sessions').innerHTML = html;
    if (focusPin) [...document.querySelectorAll('[data-pin]')].find(el => el.dataset.pin === focusPin)?.focus();
    else if (focusRow) [...document.querySelectorAll('[data-session]')].find(el => el.dataset.session === focusRow)?.focus();
  }
  const attention = counts.attention;
  document.title = `${attention ? `(${attention}) ` : ''}Session Desk · Codex command center`;
  if (selectedId && $('#detail').open) {
    const session = snapshot.sessions.find(s => s.id === selectedId);
    const version = session ? detailKey(session) : 'missing';
    if (version !== detailVersion) openDetails(selectedId, false);
  }
}

function row(session) {
  const state = displayState(session, finished);
  return `<div class="session-row ${states[state]?.group === 'attention' ? 'attention-row' : ''} ${state === 'error' ? 'error-row' : ''}" role="row" tabindex="0" data-session="${escape(session.id)}" aria-label="${escape(session.title)}, ${escape(states[state]?.label)}"><div class="session-main" role="cell"><div class="session-symbol" aria-hidden="true">&gt;_</div><div class="session-text"><div class="session-title">${escape(session.title)} ${sourceTag(session)}</div><div class="session-preview">${session.parentThreadId ? '↳ Subagent · ' : ''}${escape(session.preview)}</div></div></div><div role="cell">${badge(state)}</div><div class="project-cell" role="cell"><div class="project-name" title="${escape(session.cwd)}">${escape(projectName(session.cwd))}</div><div class="branch">${escape(session.branch || 'No branch')}</div></div><div class="updated" role="cell" title="${escape(new Date(session.updatedAt * 1000).toLocaleString())}">${timeAgo(session.updatedAt)}</div><div role="cell">${pinButton(session)}</div></div>`;
}

function card(session) {
  return `<article class="session-card" tabindex="0" data-session="${escape(session.id)}" aria-label="${escape(session.title)}"><div class="card-top">${badge(displayState(session, finished))}${sourceTag(session)}${pinButton(session)}</div><div class="session-title">${escape(session.title)}</div><div class="session-preview">${escape(session.preview)}</div><div class="card-bottom"><span class="project-name">${escape(projectName(session.cwd))}</span><span class="updated">${timeAgo(session.updatedAt)}</span></div></article>`;
}

async function openDetails(id, show = true) {
  const focused = $('#detail').contains(document.activeElement) ? document.activeElement.id : null;
  const cursor = focused === 'instruction' ? [$('#instruction').selectionStart, $('#instruction').selectionEnd] : null;
  const session = snapshot.sessions.find(s => s.id === id);
  const generation = ++detailGeneration;
  selectedId = id;
  if (!session) { $('#detail-content').innerHTML = '<h2 id="detail-title">Session no longer listed</h2><p class="history-note">The session may have been archived or removed.</p>'; return; }
  const state = displayState(session, finished);
  detailVersion = detailKey(session);
  const meta = [['Project', session.cwd], ['Branch', session.branch || '—'], ['Model', session.model], ['Source', session.source], ['Runtime', session.runtime], ['Session ID', session.id]];
  $('#detail-content').innerHTML = `<h2 class="detail-title" id="detail-title">${escape(session.title)}</h2>${badge(state)}<p class="detail-hint">${escape(states[state]?.hint || '')}</p><div id="composer"></div><dl class="detail-meta">${meta.map(([key, value]) => `<dt>${key}</dt><dd>${escape(value)}</dd>`).join('')}</dl><div class="detail-actions"><button class="button" id="open-terminal">↗ Open in terminal</button><button class="button" id="copy-resume">Copy resume command</button>${state === 'ready' ? '<button class="button" id="finish-session">✓ Mark finished</button>' : state === 'finished' ? '<button class="button" id="unfinish-session">Move back to review</button>' : ''}<button class="button" id="detail-pin">${pins.includes(id) ? '★ Unpin' : '☆ Pin session'}</button></div><p class="detail-copy-note">Open a new terminal window attached to this agent, or copy the command. Approval requests are handled in the terminal.</p><input class="resume-field" readonly aria-label="Resume command" value="${escape(resumeCommand(session))}"><div class="detail-turns"><h3>Recent activity</h3><div id="turns"><p class="history-note">Loading the latest turns…</p></div></div>`;
  mountComposer(session);
  updateTerminalButton();
  // "Open in terminal" would launch a Codex client, so it is not offered for Claude sessions.
  if (readOnly(session)) $('#open-terminal').hidden = true;
  $('#open-terminal').addEventListener('click', async () => {
    const button = $('#open-terminal'); button.disabled = true;
    try { await action(id, 'terminal'); toast('Terminal launch requested for this agent.'); }
    catch (error) { toast(error.message); }
    finally { updateTerminalButton(); }
  });
  $('#copy-resume').disabled = snapshot.mode === 'demo';
  if (snapshot.mode === 'demo') $('#copy-resume').title = 'Sample sessions cannot be resumed';
  $('#copy-resume').addEventListener('click', () => copy(resumeCommand(session)));
  $('#detail-pin').addEventListener('click', () => { togglePin(id); openDetails(id, false); });
  $('#finish-session')?.addEventListener('click', () => {
    finished[id] = revision(session); save('desk.finished', finished); render(); toast('Marked finished. New activity will bring it back.');
  });
  $('#unfinish-session')?.addEventListener('click', () => { delete finished[id]; save('desk.finished', finished); render(); });
  $('.resume-field').addEventListener('click', event => event.target.select());
  if (show && !$('#detail').open) $('#detail').showModal();
  if (focused && document.getElementById(focused)) {
    document.getElementById(focused).focus();
    if (cursor) $('#instruction').setSelectionRange(...cursor);
  }
  if (snapshot.mode !== 'demo' && snapshot.connected && !readOnly(session) && !attached.has(id)) {
    let attachError = '';
    if (!attaching.has(id)) attaching.set(id, action(id, 'attach').then(result => {
      attached.add(id);
      snapshot.requests = [...(snapshot.requests || []).filter(r => r.params?.threadId !== id), ...result.requests];
    }).finally(() => attaching.delete(id)));
    try { await attaching.get(id); }
    catch (error) {
      attachError = `Cannot connect interactive controls: ${error.message}`;
    }
    if (generation !== detailGeneration || selectedId !== id) return;
    mountComposer(session);
    if (attachError) $('#composer-error').textContent = attachError;
    detailVersion = detailKey(session);
  }
  try {
    const response = await fetch(`/api/session/${encodeURIComponent(id)}`);
    const result = await response.json();
    if (generation !== detailGeneration || selectedId !== id) return;
    if (!response.ok) throw new Error(result.error);
    $('#turns').innerHTML = result.turns.length ? result.turns.map(turn => {
      const items = (turn.items || []).filter(item => ['agentMessage', 'userMessage', 'commandExecution', 'plan', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(item.type));
      return `<section class="turn"><div class="turn-header">${escape(turn.status)} · ${escape(turn.id)}</div>${turn.error ? `<p class="turn-error">${escape(turn.error.message)}</p>` : ''}${items.map(itemHtml).join('') || '<p class="history-note">No messages recorded in this turn.</p>'}</section>`;
    }).join('') : '<p class="history-note">This session has no recorded turns yet.</p>';
  } catch (error) { if (generation === detailGeneration && selectedId === id) $('#turns').innerHTML = `<p class="history-note">Could not load activity: ${escape(error.message)}</p>`; }
}

function detailKey(session) {
  const requests = (snapshot.requests || []).filter(r => r.params?.threadId === session.id);
  return `${revision(session)}:${displayState(session, finished)}:${snapshot.connected}:${streamConnected}:${JSON.stringify(requests)}`;
}

async function action(id, name, body = {}) {
  const response = await fetch(`/api/session/${encodeURIComponent(id)}/${name}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Desk': '1' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Action failed');
  return result;
}

function updateTerminalButton() {
  const button = $('#open-terminal');
  if (!button) return;
  button.disabled = !terminalConfig.available || snapshot.mode === 'demo' || !snapshot.connected;
  button.title = terminalConfig.available ? 'Open a new terminal window attached to this session' : terminalConfig.reason;
}

function mountComposer(session) {
  if (selectedId !== session.id || !$('#composer')) return;
  if (readOnly(session)) {
    $('#composer').innerHTML = '<section class="message-composer"><p class="history-note">Read-only. This Claude Code session can be continued from its own terminal with the resume command below.</p></section>';
    return;
  }
  const focused = document.activeElement;
  const focusId = $('#composer').contains(focused) ? focused.id : null;
  const selection = typeof focused?.selectionStart === 'number' ? [focused.selectionStart, focused.selectionEnd] : null;
  const id = session.id;
  const requests = (snapshot.requests || []).filter(r => r.params?.threadId === id && r.method === 'item/tool/requestUserInput');
  const disabled = !snapshot.connected || !streamConnected || snapshot.mode === 'demo' || sending.has(id);
  const blocked = session.state === 'approval' || session.state === 'input' || requests.some(r => r.params.isBlocking !== false);
  const busy = sending.has(id);
  $('#composer').innerHTML = `<section class="message-composer"><label for="instruction">Send instructions to this agent</label><textarea id="instruction" maxlength="32000" rows="3" placeholder="Tell Codex what to do next…" ${disabled ? 'disabled' : ''}></textarea><div class="composer-bottom"><span>${blocked ? 'Answer the question below, or open the terminal for approvals.' : session.state === 'processing' ? 'Sent immediately to the running turn.' : 'Starts the next turn in this session.'}</span><button class="button primary" id="send-instruction" ${disabled || blocked ? 'disabled' : ''}>${busy ? 'Sending…' : session.state === 'processing' ? 'Send to running agent' : 'Send instruction'}</button></div><p id="composer-error" class="action-error" role="status"></p>${snapshot.mode === 'demo' ? '<p class="history-note">Controls are disabled for sample sessions.</p>' : ''}${session.state === 'input' && !requests.length ? '<p class="history-note">Waiting for the daemon to replay the question. If it does not appear, open this agent in the terminal.</p>' : ''}</section><div id="question-forms"></div>`;
  $('#instruction').value = drafts.get(id) || '';
  $('#instruction').addEventListener('input', event => drafts.set(id, event.target.value));
  $('#instruction').addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !$('#send-instruction').disabled) { event.preventDefault(); $('#send-instruction').click(); }
  });
  $('#send-instruction').addEventListener('click', async () => {
    const text = $('#instruction').value;
    if (!text.trim()) { $('#instruction').focus(); return; }
    sending.add(id); mountComposer(session);
    try {
      await action(id, 'message', { text, clientMessageId: crypto.randomUUID() });
      drafts.delete(id);
      delete finished[id]; save('desk.finished', finished);
      toast('Instruction sent to Codex.');
    } catch (error) {
      // A timeout can occur after delivery. Do not automatically retry.
      if (selectedId === id) $('#composer-error').textContent = `${error.message}${/timed out|fetch/i.test(error.message) ? ' Delivery is uncertain. Check recent activity before trying again.' : ''}`;
      toast(error.message);
    } finally {
      sending.delete(id);
      if (selectedId === id) {
        const error = $('#composer-error')?.textContent;
        mountComposer(snapshot.sessions.find(s => s.id === id) || session);
        $('#composer-error').textContent = error || '';
      }
    }
  });
  for (const request of requests) mountQuestion(request, disabled);
  const restore = focused?.isConnected ? focused : focusId ? document.getElementById(focusId) : null;
  if (restore && $('#composer').contains(restore)) {
    restore.focus();
    if (selection && typeof restore.setSelectionRange === 'function') restore.setSelectionRange(...selection);
  }
}

function mountQuestion(request, disabled) {
  const key = JSON.stringify([request.params.threadId, request.id]);
  const submitted = submittedRequests.has(key);
  const existing = questionForms.get(key);
  if (existing && existing.signature === JSON.stringify(request)) {
    for (const control of existing.form.querySelectorAll('input, select, button')) control.disabled = disabled || submitted || existing.form.submitting;
    $('#question-forms').append(existing.form);
    return;
  }
  const form = document.createElement('form');
  form.className = 'question-form';
  questionForms.set(key, { form, signature: JSON.stringify(request) });
  form.innerHTML = `<h3>${request.params.isBlocking === false ? 'A question from Codex' : 'Codex needs your input'}</h3>${request.params.questions.map((q, index) => `<fieldset><legend>${escape(q.header || `Question ${index + 1}`)}</legend><p>${escape(q.question)}</p>${q.options?.length ? `<label class="answer-label">Choose an answer<select data-choice="${index}" ${disabled || submitted ? 'disabled' : ''}><option value="">Choose…</option>${q.options.map(option => `<option value="${escape(option.label)}">${escape(option.label)}${option.description ? ` — ${escape(option.description)}` : ''}</option>`).join('')}</select></label>` : ''}<label class="answer-label">${q.options?.length ? 'Or type your answer' : 'Your answer'}<input type="${q.isSecret ? 'password' : 'text'}" data-answer="${index}" maxlength="32000" autocomplete="off" ${disabled || submitted ? 'disabled' : ''}></label></fieldset>`).join('')}<button class="button primary" type="submit" ${disabled || submitted ? 'disabled' : ''}>${submitted ? 'Answer submitted · waiting for Codex' : 'Submit answers'}</button><p class="action-error" role="status"></p>`;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const answers = Object.create(null);
    for (const [index, question] of request.params.questions.entries()) {
      const text = form.querySelector(`[data-answer="${index}"]`).value.trim() || form.querySelector(`[data-choice="${index}"]`)?.value;
      if (!text) { form.querySelector('.action-error').textContent = 'Please answer every question.'; return; }
      answers[question.id] = { answers: [text] };
    }
    const controls = [...form.querySelectorAll('input, select, button')];
    form.submitting = true;
    controls.forEach(control => { control.disabled = true; });
    try {
      await action(request.params.threadId, 'answer', { requestId: request.id, answers });
      submittedRequests.add(key);
      form.querySelector('button').textContent = 'Answer submitted · waiting for Codex';
      toast('Answer submitted to Codex.');
    } catch (error) {
      form.querySelector('.action-error').textContent = error.message;
      controls.forEach(control => { control.disabled = false; });
    } finally { form.submitting = false; }
  });
  $('#question-forms').append(form);
}

function itemHtml(item) {
  let text = item.text || '';
  const labels = { agentMessage: 'Codex', userMessage: 'You', commandExecution: 'Terminal', plan: 'Plan', fileChange: 'Changed files', mcpToolCall: 'Tool', dynamicToolCall: 'Tool' };
  if (item.type === 'userMessage') text = (item.content || []).map(c => c.text || (c.type === 'image' || c.type === 'localImage' ? '[Image]' : '')).join('\n');
  if (item.type === 'commandExecution') text = `$ ${item.command}\n${item.aggregatedOutput || ''}`;
  if (item.type === 'fileChange') text = (item.changes || []).map(c => c.path).join('\n');
  if (['mcpToolCall', 'dynamicToolCall'].includes(item.type)) text = `${item.server ? item.server + ' / ' : ''}${item.tool} · ${item.status}`;
  // Render model output as text, never HTML or unsanitized Markdown.
  return `<div class="turn-item"><div class="turn-item-label">${labels[item.type] || escape(item.type)}</div><pre>${escape(text.slice(0, 30000))}${text.length > 30000 ? '\n[Display truncated]' : ''}</pre></div>`;
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Resume command copied. Paste it into your terminal.'); }
  catch { $('.resume-field')?.select(); toast('Select and copy the command shown in the session details.'); }
}
function togglePin(id) { pins = pins.includes(id) ? pins.filter(pin => pin !== id) : [...pins, id]; save('desk.pins', pins); render(); }
function setFilter(next) { filter = next; render(); }
function notificationLabel() {
  const available = 'Notification' in window;
  $('#notifications span').textContent = available && notificationsEnabled && Notification.permission === 'granted' ? 'Notifications on' : 'Enable notifications';
}
$('#notifications').addEventListener('click', async () => {
  if (!('Notification' in window)) return toast('Desktop notifications are unavailable in this browser.');
  if (notificationsEnabled && Notification.permission === 'granted') {
    notificationsEnabled = false; save('desk.notifications', false); notificationLabel(); return toast('Notifications turned off.');
  }
  const permission = await Notification.requestPermission();
  notificationsEnabled = permission === 'granted';
  save('desk.notifications', notificationsEnabled); notificationLabel();
  toast(notificationsEnabled ? 'You’ll be notified when sessions need you or finish a response.' : 'Allow notifications in your browser settings to enable them.');
});

document.addEventListener('click', event => {
  const pin = event.target.closest('[data-pin]');
  if (pin) { togglePin(pin.dataset.pin); return; }
  const filterButton = event.target.closest('[data-filter]');
  if (filterButton) return setFilter(filterButton.dataset.filter);
  const session = event.target.closest('[data-session]');
  if (session) return openDetails(session.dataset.session);
  if (event.target.closest('[data-clear]')) { $('#search').value = ''; $('#project').value = ''; setFilter('all'); }
});
document.addEventListener('keydown', event => {
  if (event.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(event.target.tagName) && !$('#detail').open) { event.preventDefault(); $('#search').focus(); }
  if (['Enter', ' '].includes(event.key) && event.target.matches('[data-session]')) { event.preventDefault(); openDetails(event.target.dataset.session); }
});
$('#search').addEventListener('input', render);
$('#project').addEventListener('change', render);
$('#source').addEventListener('change', render);
$('#sort').addEventListener('change', render);
for (const option of ['list', 'board']) $(`#${option}-view`).addEventListener('click', () => { view = option; save('desk.view', view); render(); });
$('#close-detail').addEventListener('click', () => $('#detail').close());
$('#detail').addEventListener('close', () => { selectedId = null; detailGeneration++; questionForms.clear(); });
$('#detail').addEventListener('click', event => { if (event.target === $('#detail')) { const box = event.target.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) event.target.close(); } });
window.addEventListener('storage', event => {
  if (event.key === 'desk.finished') { finished = read('desk.finished', {}); if (!finished || typeof finished !== 'object' || Array.isArray(finished)) finished = {}; }
  if (event.key === 'desk.pins') { pins = read('desk.pins', []); if (!Array.isArray(pins)) pins = []; }
  if (event.key === 'desk.notifications') { notificationsEnabled = read('desk.notifications', false); notificationLabel(); }
  render();
});

const stream = new EventSource('/api/events');
stream.onopen = () => { streamConnected = true; render(); };
stream.onerror = () => { streamConnected = false; render(); };
stream.onmessage = event => {
  try {
    const next = JSON.parse(event.data);
    if (!Array.isArray(next.sessions)) return;
    if (!next.connected) { attached.clear(); submittedRequests.clear(); questionForms.clear(); }
    const requestKeys = new Set((next.requests || []).map(r => JSON.stringify([r.params?.threadId, r.id])));
    for (const key of questionForms.keys()) if (!requestKeys.has(key)) questionForms.delete(key);
    for (const key of submittedRequests) if (!requestKeys.has(key)) submittedRequests.delete(key);
    // Claude sessions keep updating while the Codex daemon is down, so track them too.
    const live = next.connected || Boolean(next.sources?.claude?.connected);
    if (live && !firstSnapshot && notificationsEnabled && 'Notification' in window && Notification.permission === 'granted') {
      for (const session of next.sessions) {
        const was = previous.get(session.id);
        if (was !== session.state && ['approval', 'input', 'error', 'ready'].includes(session.state)) {
          const notification = new Notification(`${states[session.state].label} · ${session.title}`, { body: projectName(session.cwd), tag: session.id, icon: '/icon.svg' });
          notification.onclick = () => { window.focus(); openDetails(session.id); notification.close(); };
        }
      }
    }
    if (live) { previous = new Map(next.sessions.map(s => [s.id, s.state])); firstSnapshot = false; }
    snapshot = next; render();
  } catch (error) { console.error('Could not update sessions', error); }
};
notificationLabel();
fetch('/api/capabilities').then(response => response.json()).then(result => {
  terminalConfig = result.terminal; updateTerminalButton();
}).catch(() => { terminalConfig = { available: false, reason: 'Could not detect terminal support. Use Copy resume command.' }; updateTerminalButton(); });
render();
setInterval(() => { updateConnection(); }, 10000);

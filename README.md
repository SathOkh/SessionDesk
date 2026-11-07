# Session Desk

A local browser dashboard for Codex and Claude Code: see what is processing, waiting for input or approval, ready to review, or finished, across both tools in one list. No packages, API keys, or build step required.

<img width="2520" height="1264" alt="2026-11-07_21-32" src="https://github.com/user-attachments/assets/86871b25-6510-4aae-afcd-f1a163b4cb50" />

## Run

Requires **Node.js 22.8+** and a recent **Codex CLI** with `codex app-server proxy` support. Developed against Codex CLI 0.166.0–0.167.0.

```bash
codex app-server daemon start
npm start
```

Open **http://127.0.0.1:4317**. Start your Codex sessions normally in another terminal. Leave out `--no-daemon` so they use the shared daemon.

To explore the interface with explicitly labeled sample data:

```bash
npm run demo
```

## What you get

- Live overview, refreshed every three seconds and after relevant daemon events.
- Interactive **Claude Code** sessions on this machine appear alongside Codex sessions, tagged by source. Claude sessions are read-only (see below).
- Attention-first list and four-column board.
- Separate statuses for approval needed, input needed, processing, response ready, errors, interrupted, idle, and not running.
- Search titles, prompts, projects, branches, and IDs. Filter by project or status and sort by recency.
- Pin sessions, inspect the latest five turns, and copy a terminal command to resume a session.
- Send instructions directly to an agent; messages start a new turn when idle or steer the current turn while processing.
- Answer structured Codex questions in the dashboard to unblock the running agent.
- Open a new terminal window attached to the same agent on supported desktop systems.
- Optional browser desktop notifications when an observed session transitions to input, approval, error, or response ready. The browser tab must remain open.
- Mark a reviewed response **Finished**. This is a local organizational label, not a claim made by the model. A different turn or session update invalidates it automatically. Pins and finished labels are stored in this browser and synchronized across its tabs.

## Claude Code sessions (read-only)

Interactive Claude Code sessions are found from the files Claude Code writes locally, in `~/.claude` (or `CLAUDE_CONFIG_DIR`):

- `sessions/<pid>.json` is the live-session record: status, working directory, and start time. A record counts only while its process is still the same one (the start time must match), so reused PIDs are ignored.
- `projects/<project>/<session-id>.jsonl` is the transcript, read incrementally. It supplies the title, branch, latest prompt, and turn boundaries.

Background and daemon workers (`jobs/`, `daemon/roster.json`) are not shown yet.

Claude status mapping:

| Claude status | Session Desk state |
| --- | --- |
| `busy`, `shell` | Processing |
| `waiting` | Input needed (Claude's own wait reason is shown in details when provided) |
| `idle` after a finished turn | Response ready |
| `idle`, no finished turn | Idle |

Claude sessions cannot receive instructions, answers, or terminal launches from Session Desk. Continue them in their own terminal: the details view offers `cd <project> && claude --resume <id>`. The local HTTP API rejects actions on Claude sessions with HTTP 409. Mark-finished works for them the same way as for Codex.

## Send instructions and answer questions

Click a session to open its details. Write in **Send instructions to this agent** and click **Send instruction** (or press Ctrl/Cmd+Enter). When the agent is processing, **Send to running agent** adds your instruction to its active turn immediately. This is steering, not a queue for later.

Opening session details joins the session with `thread/resume`, subscribes to its events, and receives outstanding human-input requests when the daemon replays them. This preserves the thread's model, sandbox, and approval policy. It does not start a new turn by itself. Viewing only the overview remains observational.

When Codex is waiting for structured input, the question appears below the message box. Select an option or enter your answer, then click **Submit answers**. The dashboard sends the question's JSON-RPC response, rather than an ordinary message. Questions remain visible until the daemon confirms resolution; questions resolved in another client disappear too. Form entries survive live updates and are not written to browser storage. Secret answers use password fields. Closing session details clears question forms.

Regular instructions are blocked while a blocking question or approval is pending. Approval requests still use the terminal. The dashboard never automatically accepts or declines requests. If an older daemon does not replay a pending question, use **Open in terminal** or **Copy resume command**. A request timeout can mean the instruction was delivered; check recent activity before manually retrying. The app never automatically retries a submitted instruction.

## Open in terminal

**Open in terminal** launches a new window connected to this session. It does not locate or focus an existing terminal tab. Linux auto-detection supports GNOME Terminal, Konsole, Xfce Terminal, Kitty, Alacritty, WezTerm, the system terminal alternative, and xterm; macOS uses Terminal.app. A Linux desktop display must be available in the server process's environment. On headless/SSH hosts the button is disabled with an explanation, and copying the command still works.

For another terminal, configure an executable and its fixed arguments as a JSON array; the app appends `codex resume <session-id> --cd <project>` as separate arguments. For example:

```bash
SESSION_DESK_TERMINAL='["wezterm","start","--"]' npm start
SESSION_DESK_TERMINAL='["kitty"]' npm start
```

This command configuration is set locally when starting the app, never supplied through the browser. The launcher does not invoke a shell. Copied resume commands use POSIX shell quoting (bash/zsh). A custom `CODEX_SOCKET` is passed to the launched client as `--remote unix://…`.

## Status meanings

| Status | Evidence |
| --- | --- |
| Approval needed | Active thread with `waitingOnApproval` |
| Input needed | Active thread with `waitingOnUserInput` |
| Processing | Active thread with neither waiting flag |
| Response ready | Most recent turn completed; no currently active turn |
| Finished | You marked the current completed response finished in this browser |
| Error | Runtime system error or most recent turn failed |
| Interrupted | Most recent turn interrupted |
| Idle | Loaded thread with no active turn or known completed result |
| Not running | Not loaded on this daemon and no known completed result |

A completed turn means a response is ready; it does not prove the overall task is done. Questions written as ordinary final messages are response-ready unless the daemon supplies a waiting-for-input flag. A session running with `--no-daemon`, in another Codex home, or on a different server cannot be reliably monitored through this daemon. A stale persisted `inProgress` turn is never used to assert that a session is processing.

The overview includes the most recent **100 non-archived sessions plus every loaded session**, even if its last update is older. When more history exists, the footer says so. Session-history failures are shown without inventing a completed state. During disconnection, the previous snapshot remains visible with a stale-data warning.

## Configuration

```bash
PORT=4400 npm start
CODEX_BIN=/absolute/path/to/codex npm start
CODEX_SOCKET=/absolute/path/to/control.sock npm start
CLAUDE_CONFIG_DIR=/absolute/path/to/.claude npm start
```

`CODEX_HOME` is inherited by the Codex proxy, so use the same home as your regular Codex clients. `CODEX_SOCKET` overrides the proxy socket path. The app connects using `codex app-server proxy`, performs the HTTP WebSocket Upgrade handshake over its raw byte stream, initializes the JSON-RPC connection, then reads `thread/list`, `thread/loaded/list`, `thread/read`, and `thread/turns/list`. The Unix control socket uses WebSocket frames, not the JSONL framing used by a standalone stdio app-server. It does not start an isolated server, which would misrepresent the running sessions' status.

The HTTP server binds only to `127.0.0.1` and accepts local same-origin requests. Actions require JSON POST requests with a custom header and a bounded body; arbitrary daemon methods and shell execution are not exposed. There are no third-party scripts, fonts, analytics, or external dependencies. Session content is served locally; instructions and answers are sent through your existing Codex daemon. Do not expose the port publicly: the dashboard contains your session prompts and outputs and can send instructions to your agents.

## Troubleshooting

- **Cannot connect:** run `codex app-server daemon start`, check `codex app-server daemon version`, and check whether your Codex installation supports `codex app-server proxy --help`.
- **Missing sessions:** check that the dashboard and sessions share `CODEX_HOME` and the same daemon. Isolated sessions are outside this view; archived sessions are excluded.
- **No detailed history:** the installed daemon may not support paginated `thread/turns/list`, or the thread history may be unavailable. The dashboard reports the failure instead of guessing. Use a daemon version compatible with your CLI.
- **Permission denied:** run the dashboard from your regular terminal with access to the Codex control socket. Restricted sandboxes may block socket access.
- **Notifications:** click Enable notifications and grant browser permission. They apply to transitions observed after connecting, not all old completed sessions. OS notification settings can also suppress them.
- **Port in use:** choose a different `PORT`.
- **Claude sessions missing:** they must be interactive sessions running as your user with `CLAUDE_CONFIG_DIR` (default `~/.claude`) pointing at the same home. Session Desk must be able to read `/proc` to check process liveness on Linux.

## Verify

```bash
npm run check
npm test
```

Tests exercise Claude Code status mapping, PID reuse, incremental transcript reads, read-only enforcement, source merging, status precedence, completion invalidation, filtering, safe shell quoting, WebSocket upgrade/framing/fragmentation/ping handling, transport errors/timeouts, monitor aggregation, disconnects, structured input responses, start/steer routing, terminal arguments, and the HTTP/SSE endpoints using a simulated Codex daemon. No model calls or real terminal launches are made.

import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { spawn } from 'node:child_process';

const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

export class TerminalLauncher {
  constructor({ env = process.env, platform = process.platform, spawnProcess = spawn, executable = null } = {}) {
    Object.assign(this, { env, platform, spawnProcess });
    this.executable = executable || (async name => {
      for (const directory of (env.PATH || '').split(delimiter)) {
        try { const path = join(directory, name); await access(path, constants.X_OK); return path; } catch {}
      }
      return null;
    });
  }

  async detect() {
    if (this.env.SESSION_DESK_TERMINAL) {
      let command;
      try { command = JSON.parse(this.env.SESSION_DESK_TERMINAL); } catch { return { available: false, reason: 'SESSION_DESK_TERMINAL must be a JSON array of executable and arguments.' }; }
      if (!Array.isArray(command) || !command.length || command.some(v => typeof v !== 'string' || v.includes('\0'))) return { available: false, reason: 'Invalid SESSION_DESK_TERMINAL command.' };
      return { available: true, command, label: 'Configured terminal' };
    }
    if (this.platform === 'darwin') return { available: true, command: ['osascript'], label: 'Terminal.app', appleScript: true };
    if (this.platform !== 'linux') return { available: false, reason: 'Configure SESSION_DESK_TERMINAL to open a terminal on this platform.' };
    if (!this.env.DISPLAY && !this.env.WAYLAND_DISPLAY) return { available: false, reason: 'No desktop display found. Use Copy resume command, or run Session Desk in your desktop environment.' };
    const candidates = [
      ['gnome-terminal', '--'], ['konsole', '-e'], ['xfce4-terminal', '--disable-server', '-x'],
      ['kitty'], ['alacritty', '-e'], ['wezterm', 'start', '--'], ['x-terminal-emulator', '-e'], ['xterm', '-e'],
    ];
    for (const [name, ...args] of candidates) {
      const executable = await this.executable(name);
      if (executable) return { available: true, command: [executable, ...args], label: name };
    }
    return { available: false, reason: 'No supported terminal found. Set SESSION_DESK_TERMINAL or use Copy resume command.' };
  }

  async open(session) {
    const config = await this.detect();
    if (!config.available) throw new Error(config.reason);
    const binary = this.env.CODEX_BIN || 'codex';
    const codexArgs = ['resume', session.id, ...(session.cwd ? ['--cd', session.cwd] : [])];
    // Keep a custom daemon endpoint consistent with the dashboard.
    if (this.env.CODEX_SOCKET) codexArgs.push('--remote', `unix://${this.env.CODEX_SOCKET}`);
    let [program, ...args] = config.command;
    if (config.appleScript) {
      const command = [binary, ...codexArgs].map(quote).join(' ');
      args = ['-e', 'on run argv\ntell application "Terminal"\nactivate\ndo script (item 1 of argv)\nend tell\nend run', command];
    } else args.push(binary, ...codexArgs);
    await new Promise((resolve, reject) => {
      const child = this.spawnProcess(program, args, { detached: true, stdio: 'ignore', shell: false, env: this.env });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    });
    return { status: 'launched', terminal: config.label };
  }
}

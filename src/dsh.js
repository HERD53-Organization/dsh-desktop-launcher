'use strict';

const { EventEmitter } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const config = require('./config');

/**
 * Supervises the local `dsh web` server.
 *
 * Hard constraint: `dsh` runs under the SYSTEM Node executable, never under
 * Electron's bundled Node. The profile dependency tree in
 * `$DSH_HOME/profiles/node_modules` contains native modules (node-pty, sharp,
 * koffi) built for the system Node's ABI; loading them under a different Node
 * runtime fails. Electron is only the shell, tray, and window owner here.
 *
 * States: 'stopped' -> 'starting' -> 'ready' -> 'stopping' -> 'stopped',
 * with 'failed' for a process that exited before becoming ready.
 */

const DEFAULT_RETENTION_BYTES = 64 * 1024;
const URL_PATTERN = /^dsh web:\s+(\S+)/u;

function npmGlobalRoots() {
  const roots = [];
  if (process.platform === 'win32') {
    if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm'));
    // pnpm's per-user global layout.
    if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'pnpm', 'global'));
  } else {
    roots.push('/usr/local/lib', '/usr/lib', path.join(process.env.HOME ?? '', '.local', 'share', 'pnpm', 'global'));
  }
  if (process.env.npm_config_prefix) roots.push(process.env.npm_config_prefix);
  return roots.filter((root) => root !== '' && fs.existsSync(root));
}

/** Locate the dsh CLI entry script (lib/bin.js) in a global install prefix. */
function findDshEntry() {
  const candidates = [];
  for (const root of npmGlobalRoots()) {
    candidates.push(
      path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      path.join(root, '5', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      path.join(root, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    );
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Locate the Node executable that owns the installed dsh.
 *
 * Preference order matters: the launcher must not silently switch runtimes when
 * a user installs a Node version manager later, so a cached and still-valid
 * path always wins over a fresh PATH lookup.
 */
function findNodePath() {
  const cached = config.get('nodePath');
  if (typeof cached === 'string' && cached !== '' && fs.existsSync(cached)) return cached;

  const onPath = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['node'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (onPath.status === 0) {
    const first = String(onPath.stdout).split(/\r?\n/u).map((line) => line.trim()).find((line) => line !== '');
    if (first !== undefined && fs.existsSync(first)) return first;
  }

  const wellKnown = process.platform === 'win32'
    ? [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node.exe')]
    : ['/usr/local/bin/node', '/usr/bin/node', '/opt/homebrew/bin/node'];
  for (const candidate of wellKnown) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function probePort(host, port, timeoutMs = 700) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (listening) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

class Supervisor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port ?? config.get('port');
    this.host = '127.0.0.1';
    this.child = null;
    this.state = 'stopped';
    this.webUrl = null;
    this.error = null;
    this.startedByUs = false;
    this.retentionBytes = options.retentionBytes ?? DEFAULT_RETENTION_BYTES;
    this.stdoutTail = '';
    this.stderrTail = '';
    this.exitInfo = null;
  }

  get authority() {
    return `${this.host}:${String(this.port)}`;
  }

  get url() {
    return `http://${this.authority}/`;
  }

  /** Is anything already listening on the configured port? */
  async probe() {
    return probePort(this.host, this.port);
  }

  setState(state, patch = {}) {
    this.state = state;
    Object.assign(this, patch);
    this.emit('state', this.snapshot());
  }

  snapshot() {
    return {
      state: this.state,
      port: this.port,
      authority: this.authority,
      url: this.url,
      startedByUs: this.startedByUs,
      webUrl: this.webUrl,
      error: this.error,
      pid: this.child?.pid ?? null,
      exitInfo: this.exitInfo,
    };
  }

  appendTail(current, chunk) {
    const next = current + chunk;
    return next.length <= this.retentionBytes ? next : next.slice(next.length - this.retentionBytes);
  }

  /**
   * Make a server available on the configured port.
   * @returns {Promise<{ok: boolean, adopted: boolean, reason?: string}>}
   */
  async ensure() {
    if (this.state === 'ready' && await this.probe()) {
      return { ok: true, adopted: !this.startedByUs };
    }

    // Any listener already on the port is adopted rather than restarted: its
    // browser-session cookie is minted from the persistent secret, so an
    // instance the launcher did not start still authenticates.
    if (await this.probe()) {
      this.webUrl = null;
      this.setState('ready', { startedByUs: false, error: null });
      return { ok: true, adopted: true };
    }

    return this.start();
  }

  start() {
    if (this.child !== null) return Promise.resolve({ ok: false, adopted: false, reason: '已经在启动中' });

    const nodePath = findNodePath();
    if (nodePath === null) {
      const reason = '未找到 Node.js。请先安装 Node.js，然后重新启动启动器。';
      this.setState('failed', { error: reason });
      return Promise.resolve({ ok: false, adopted: false, reason });
    }
    const dshEntry = config.get('dshEntryPath') ?? findDshEntry();
    if (dshEntry === null || !fs.existsSync(dshEntry)) {
      const reason = '未找到 dsh 命令行工具。请执行：npm install -g @deepseek-ai/dsh';
      this.setState('failed', { error: reason });
      return Promise.resolve({ ok: false, adopted: false, reason });
    }
    config.save({ nodePath, dshEntryPath: dshEntry });

    this.stdoutTail = '';
    this.stderrTail = '';
    this.exitInfo = null;
    this.webUrl = null;
    this.setState('starting', { error: null, startedByUs: true });

    const args = [dshEntry, '--profile', 'web', '--no-open', '--port', String(this.port)];
    const child = spawn(nodePath, args, {
      cwd: path.dirname(dshEntry),
      env: { ...process.env, BROWSER: 'none' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;

    // One settlement path for every outcome: the URL line on stdout, an early
    // exit, a spawn error, EADDRINUSE on stderr, a port that answers before the
    // URL line (another process won the race), or the startup deadline. Without
    // a single decider the caller could resolve on the first event only.
    let decided = false;
    const startup = new Promise((resolve) => {
      const decide = (value) => {
        if (decided) return;
        decided = true;
        clearInterval(watchdog);
        clearTimeout(deadline);
        resolve(value);
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        this.stdoutTail = this.appendTail(this.stdoutTail, chunk);
        this.emit('output', { stream: 'stdout', chunk });
        for (const line of chunk.split(/\r?\n/u)) {
          const match = URL_PATTERN.exec(line);
          if (match === null) continue;
          this.webUrl = match[1];
          this.setState('ready', { error: null, startedByUs: true });
          decide({ ok: true, adopted: false });
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        this.stderrTail = this.appendTail(this.stderrTail, chunk);
        this.emit('output', { stream: 'stderr', chunk });
        if (!chunk.includes('EADDRINUSE')) return;
        const reason = `端口 ${String(this.port)} 已被其他程序占用。`;
        this.setState('failed', { error: reason });
        decide({ ok: false, adopted: false, reason });
      });

      child.once('error', (error) => {
        const reason = `无法启动 dsh：${error.message}`;
        this.setState('failed', { error: reason });
        decide({ ok: false, adopted: false, reason });
      });

      child.once('exit', (code, signal) => {
        this.exitInfo = { code, signal, at: Date.now() };
        this.child = null;
        const wasReady = this.state === 'ready';
        if (!wasReady) this.error ??= `dsh 在就绪前退出（代码 ${String(code)}）。`;
        this.setState(wasReady ? 'stopped' : 'failed', {
          error: wasReady ? null : this.error,
          startedByUs: false,
        });
        decide({
          ok: false,
          adopted: false,
          reason: `dsh 在输出 URL 之前退出（代码 ${String(code)}）。`,
        });
      });

      const watchdog = setInterval(() => {
        void this.probe().then((listening) => {
          if (!listening) return;
          this.setState('ready', { error: null, startedByUs: true });
          decide({ ok: true, adopted: false });
        });
      }, 400);

      const deadline = setTimeout(() => {
        const seconds = Math.round(config.get('startupTimeoutMs') / 1000);
        const reason = `dsh 在 ${String(seconds)} 秒内未能就绪。`;
        this.setState('failed', { error: reason });
        decide({ ok: false, adopted: false, reason });
      }, config.get('startupTimeoutMs'));
    });

    return startup;
  }

  /**
   * Stop the supervised server. Kills the whole process tree: `dsh web` spawns
   * children, and leaving them behind keeps the port bound.
   *
   * @param options.force - skip the graceful window and kill immediately. Used
   *   on application quit: the timeout exists to let an in-flight install or
   *   config write finish, but nothing at exit needs that, and waiting made
   *   quitting feel broken (8s grace + 3s confirm before the window even went
   *   away).
   * @param options.timeoutMs - grace period before escalating to a forced kill.
   */
  async stop({ timeoutMs = 1500, force = false } = {}) {
    const child = this.child;
    if (child === null) {
      this.setState('stopped', { startedByUs: false });
      return { ok: true, killed: false };
    }
    this.setState('stopping');

    const exited = new Promise((resolve) => child.once('exit', () => resolve(true)));

    if (force) {
      killTree(child.pid, true);
    } else {
      killTree(child.pid, false);
      const graceful = await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
      ]);
      if (graceful === false) killTree(child.pid, true);
    }

    // Bounded confirmation; the tree kill above is authoritative either way.
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);

    this.child = null;
    this.webUrl = null;
    this.setState('stopped', { startedByUs: false, error: null });
    return { ok: true, killed: true };
  }

  /** Stop, then start again on the same port. */
  async restart() {
    await this.stop();
    // Give the OS a moment to release the socket before rebinding.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && await this.probe()) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return this.start();
  }
}

function killTree(pid, force) {
  if (pid === undefined || pid === null) return;
  if (process.platform === 'win32') {
    const args = ['/PID', String(pid), '/T'];
    if (force) args.push('/F');
    spawnSync('taskkill', args, { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try {
    if (force) process.kill(-pid, 'SIGKILL');
    else process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    } catch {
      // Process already gone.
    }
  }
}

module.exports = {
  Supervisor,
  findDshEntry,
  findNodePath,
  probePort,
  npmGlobalRoots,
};

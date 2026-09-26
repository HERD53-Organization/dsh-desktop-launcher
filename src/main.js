'use strict';

const { app, BrowserWindow, Menu, Tray, shell, ipcMain, nativeImage, nativeTheme, dialog } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const auth = require('./auth');
const config = require('./config');
const { Supervisor, findDshEntry, findNodePath } = require('./dsh');
const updater = require('./updater');

/**
 * A closed console must never take the launcher down.
 *
 * When the process has no valid console handle — a packaged build started with
 * a hidden window, a detached console, a pipe whose reader exited — writing to
 * stdout raises EPIPE. Node delivers that as an asynchronous 'error' event on
 * the stream, so a try/catch around console.log does not catch it and the
 * uncaught exception kills the process. Both streams are made inert instead.
 */
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error) => {
    if (error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED') return;
    throw error;
  });
}

/**
 * Launcher shell: single-instance guard, tray, window choreography, and IPC.
 *
 * The DSH UI runs in its own window on a persistent session partition so the
 * user's normal browser is never involved: no tabs, no history, no cookies
 * shared with Chrome or Edge. Authentication is minted from the persistent
 * browser-session secret (see auth.js) rather than scraped from stdout, which
 * is what lets the launcher adopt a server it did not start.
 */

const SESSION_PARTITION = 'persist:dsh';
const ASSETS = path.join(__dirname, '..', 'assets');
const ICON_ICO = path.join(ASSETS, 'icon.ico');
const ICON_PNG = path.join(ASSETS, 'icon.png');
const LOG_LIMIT = 400;

/**
 * Launcher-owned window chrome.
 *
 * These apply to the launcher's own surfaces: the loading page, the diagnostics
 * window, error pages, and the BrowserWindow background that shows before a
 * page paints. They deliberately do NOT reach into the DSH UI, which themes
 * itself; the point is that the frame around it stops looking bolted on.
 */
const COLOR_BACKGROUND = '#1f1d19';
const COLOR_TEXT = '#f2efe9';
/** Secondary copy: a dimmed tint of the text colour, not a different hue. */
const COLOR_MUTED = 'rgba(242, 239, 233, 0.62)';
const COLOR_FAINT = 'rgba(242, 239, 233, 0.38)';
const COLOR_BORDER = 'rgba(242, 239, 233, 0.12)';
const COLOR_ACCENT = '#c9a061';

/**
 * Native caption tint.
 *
 * `backgroundColor` only paints the client area, so the system title bar kept
 * its own colour and the chrome disagreed with the content. Electron exposes no
 * `titleBarColor`; the supported route on Windows 10/11 is a hidden title bar
 * plus `titleBarOverlay`, which keeps the native minimize/maximize/close
 * buttons but lets their background and glyph colours be set. It needs
 * `nativeTheme.themeSource = 'dark'`, otherwise Windows draws light-theme
 * buttons over a dark bar.
 */
const TITLE_BAR_HEIGHT = 32;
function titleBarOverlay() {
  return { color: COLOR_BACKGROUND, symbolColor: COLOR_TEXT, height: TITLE_BAR_HEIGHT };
}

/**
 * Icon for a window or the tray. Windows can read .ico; the other platforms
 * cannot, so they get the PNG. Regenerate both with `npm run make-icons`.
 */
function iconPath() {
  if (process.platform === 'win32' && fs.existsSync(ICON_ICO)) return ICON_ICO;
  return fs.existsSync(ICON_PNG) ? ICON_PNG : undefined;
}

/** @type {{dsh: BrowserWindow|null, diagnostics: BrowserWindow|null, loading: BrowserWindow|null, tray: Tray|null}} */
const windows = { dsh: null, diagnostics: null, loading: null, tray: null };

let supervisor = null;
let quitting = false;
let openingDsh = false;
let state = { state: 'stopped', port: 3080, url: '', adopted: false, error: null };
let updateState = { phase: 'idle', current: null, latest: null, message: null };
const logLines = [];

/**
 * Make a hidden-title-bar window draggable again.
 *
 * `titleBarStyle: 'hidden'` removes the native title bar together with its drag
 * area, so the window cannot be moved at all — Electron does not put one back
 * for `titleBarOverlay`, the page has to provide it.
 *
 * A transparent strip is injected at the very top with the maximum z-index. It
 * must be the topmost element in that band: `app-region` is inherited by
 * descendants but overridden by any element that declares its own, and the DSH
 * UI declares `no-drag` on its own layout containers. Anything the page paints
 * over the strip would therefore break dragging there.
 *
 * Drag regions are click-through in Electron — verified by
 * scripts/probe-drag-region.js, where document.elementFromPoint over such a
 * region still returns the control beneath it — so this does not make the UI
 * underneath unclickable.
 *
 * @returns {Promise<void>} resolves once the rule is registered; call it after
 *   every navigation, because a new document starts without it.
 */
async function installDragRegion(win) {
  if (win.isDestroyed()) return;
  const css = `
    #dsh-launcher-drag-strip {
      position: fixed !important;
      top: 0 !important;
      left: 0 !important;
      right: 0 !important;
      height: ${String(TITLE_BAR_HEIGHT)}px !important;
      z-index: 2147483647 !important;
      background: transparent !important;
      -webkit-app-region: drag !important;
      app-region: drag !important;
    }
  `;
  try {
    const key = await win.webContents.insertCSS(css);
    win.__dragRegionKey = key;
  } catch (error) {
    console.warn('main: could not install the drag region (%s)', error.message);
  }
}

/** Inject the strip element into whatever document is currently loaded. */
async function attachDragRegion(win) {
  if (win.isDestroyed()) return;
  const script = `(() => {
    if (document.getElementById('dsh-launcher-drag-strip') !== null) return true;
    const strip = document.createElement('div');
    strip.id = 'dsh-launcher-drag-strip';
    (document.body || document.documentElement).append(strip);
    return true;
  })()`;
  try {
    await win.webContents.executeJavaScript(script);
  } catch (error) {
    console.warn('main: could not attach the drag strip (%s)', error.message);
  }
}

function recordLog(stream, chunk) {
  const stamp = new Date().toISOString().slice(11, 19);
  for (const line of String(chunk).split(/\r?\n/u)) {
    if (line === '') continue;
    // Never let a launch token reach the diagnostics buffer.
    logLines.push(`[${stamp}] ${stream}: ${line.replace(/([?&]token=)[^\s&]+/gu, '$1<redacted>')}`);
  }
  while (logLines.length > LOG_LIMIT) logLines.shift();
}

function trayImage() {
  const resolved = iconPath();
  if (resolved !== undefined) {
    const image = nativeImage.createFromPath(resolved);
    if (!image.isEmpty()) return image;
    console.warn('main: tray icon at %s decoded empty', resolved);
  }
  // An empty tray image makes the tray invisible; returning empty still keeps
  // the handle alive so the menu remains reachable.
  return nativeImage.createEmpty();
}

function statusLabel() {
  if (supervisor === null) return '状态：空闲';
  switch (state.state) {
    case 'ready': return state.adopted ? '状态：运行中（复用已有服务）' : '状态：运行中';
    case 'starting': return '状态：启动中…';
    case 'stopping': return '状态：停止中…';
    case 'failed': return '状态：启动失败';
    case 'stopped': return '状态：已停止';
    default: return `状态：${state.state}`;
  }
}

/**
 * Was this process started by the login item rather than by the user?
 *
 * The login item is registered with the `--autostart` argument and that flag is
 * the only signal consulted. Two earlier attempts were both wrong:
 *
 *   1. Matching the registry value name. Electron writes the entry as
 *      `electron.app.Electron`, not the product name, so the regex never
 *      matched and every launch looked manual.
 *   2. Matching the command line against `process.execPath`. It is exact, but
 *      only for one copy of the app: the launcher ships in both `build\` and
 *      the deliverable folder, and the Run entry points at whichever copy the
 *      user toggled the setting from. Launching the other copy then looked like
 *      an autostart and silently stayed in the tray.
 *
 * An explicit argument is immune to both, and it works on every platform.
 */
const AUTOSTART_ARG = '--autostart';
function launchedAtLogin() {
  return process.argv.includes(AUTOSTART_ARG);
}

/** Keep the registry entry and the `--autostart` argument in sync. */
function applyLoginItem(wanted) {
  app.setLoginItemSettings({
    openAtLogin: wanted,
    // Rewritten on every toggle, so an entry created without the argument by an
    // older build starts carrying it from the next switch onward.
    args: wanted ? [AUTOSTART_ARG] : [],
  });
}

function refreshTray() {
  if (windows.tray === null) return;
  windows.tray.setToolTip(`DSH 启动器 — ${statusLabel().replace(/^状态：/u, '')}`);
  windows.tray.setContextMenu(Menu.buildFromTemplate([
    { label: statusLabel(), enabled: false },
    { type: 'separator' },
    { label: '打开 DeepSeek Harness', click: () => { void openDsh(); } },
    { label: '重启服务', click: () => { void restartService(); } },
    { type: 'separator' },
    { label: '诊断…', click: () => { showDiagnostics(); } },
    { label: '打开数据目录', click: () => { void shell.openPath(app.getPath('userData')); } },
    { label: '打开 DSH 主目录', click: () => { void shell.openPath(dshHome()); } },
    {
      label: '开机自动启动',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        applyLoginItem(item.checked);
        config.save({ launchAtLogin: item.checked });
      },
    },
    { type: 'separator' },
    { label: updateLabel(), click: () => { void checkForUpdates(); } },
    { type: 'separator' },
    { label: '退出', click: () => { void quitApp(); } },
  ]));
}

function updateLabel() {
  switch (updateState.phase) {
    case 'checking': return '正在检查更新…';
    case 'available': return `可更新到 ${updateState.latest} — 点击安装`;
    case 'current': return `已是最新版本（${updateState.current ?? '?'}）`;
    case 'installing': return '正在安装更新…';
    case 'failed': return '检查更新失败 — 点击重试';
    default: return '检查 dsh 更新…';
  }
}

function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  return fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : path.join(os.homedir(), '.dsh');
}

// ── windows ──────────────────────────────────────────────────────────────────

function ensureLoadingWindow() {
  if (windows.loading !== null && !windows.loading.isDestroyed()) return windows.loading;
  // Standalone and framed on purpose: it appears while the DSH window is still
  // hidden, so it must be movable and closable rather than owned by a parent.
  // A native frame also means it needs no injected drag region.
  const loading = new BrowserWindow({
    width: 460,
    height: 240,
    resizable: false,
    center: true,
    show: false,
    backgroundColor: COLOR_BACKGROUND,
    title: 'DeepSeek Harness',
    icon: iconPath(),
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  void loading.loadFile(path.join(__dirname, '..', 'renderer', 'loading.html'));
  windows.loading = loading;
  loading.once('closed', () => { windows.loading = null; });
  return loading;
}

function closeLoadingWindow() {
  if (windows.loading !== null && !windows.loading.isDestroyed()) windows.loading.destroy();
  windows.loading = null;
}

function waitForServerAndLoad({ quiet = false } = {}) {
  return new Promise((resolve) => {
    const timeout = config.get('startupTimeoutMs');
    const deadline = Date.now() + timeout;
    void (async () => {
      while (Date.now() < deadline) {
        if (state.state === 'failed' && !state.adopted) {
          if (!quiet) void showFailure(state.error ?? '服务启动失败。');
          return resolve(false);
        }
        if (supervisor !== null && await supervisor.probe()) {
          closeLoadingWindow();
          const outcome = await loadAuthenticated();
          return resolve(outcome);
        }
        await new Promise((r) => setTimeout(r, 350));
      }
      if (!quiet) void showFailure(`The server did not become ready within ${String(Math.round(timeout / 1000))}s.`);
      resolve(false);
    })();
  });
}

async function loadAuthenticated() {
  // Authority comes from the supervisor, never a literal: the configured port,
  // and therefore the cookie audience, must match the server actually running.
  if (supervisor === null) return false;
  const target = { host: supervisor.host, port: supervisor.port };
  const session = require('electron').session.fromPartition(SESSION_PARTITION);
  const configured = await auth.configureSession(session, target);
  if (!configured.ok) {
    console.warn('main: session cookie unavailable (%s)', configured.reason);
  }
  const win = windows.dsh;
  if (win === null || win.isDestroyed()) return false;

  const bare = `http://${target.host}:${String(target.port)}/`;
  try {
    await win.loadURL(bare);
  } catch (error) {
    console.warn('main: loadURL failed (%s)', error.message);
  }

  // Distinguish "the page is there" from "we are authenticated": an
  // unauthenticated server answers the root request with 401, which Chromium
  // renders as a blank body rather than a load failure.
  await new Promise((r) => setTimeout(r, 1200));

  if (!configured.ok) {
    await showAuthFailure(configured.reason);
    return false;
  }
  win.show();
  win.focus();
  return true;
}

async function showAuthFailure(reason) {
  const win = windows.dsh;
  if (win === null || win.isDestroyed()) return;
  const authority = supervisor === null ? '127.0.0.1' : supervisor.authority;
  const html = `<!doctype html><meta charset="utf-8"><title>需要重新认证</title>
<style>
body{font:14px/1.7 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;background:${COLOR_BACKGROUND};color:${COLOR_TEXT};margin:0;padding:44px}
h1{font-size:18px;font-weight:600;margin:0 0 14px}
p{margin:0 0 12px;color:${COLOR_MUTED}}
code{background:rgba(242,239,233,0.08);color:${COLOR_TEXT};padding:2px 6px;border-radius:4px}
</style>
<h1>这个窗口无法完成认证</h1>
<p>${String(reason).replace(/[<&]/gu, (c) => (c === '<' ? '&lt;' : '&amp;'))}</p>
<p>服务正在 <code>http://${authority}/</code> 运行，但启动器无法从
<code>.credentials.yaml</code> 取得浏览器会话 cookie。</p>
<p>请在托盘菜单中执行「重启服务」，让 DSH 重新写入会话记录，然后重新打开此窗口。</p>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  win.show();
  win.focus();
}

function ensureDshWindow() {
  if (windows.dsh !== null && !windows.dsh.isDestroyed()) {
    if (windows.dsh.isMinimized()) windows.dsh.restore();
    windows.dsh.show();
    windows.dsh.focus();
    return windows.dsh;
  }
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'DeepSeek Harness',
    backgroundColor: COLOR_BACKGROUND,
    icon: iconPath(),
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlay(),
    webPreferences: {
      partition: SESSION_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  // Closing hides to the tray instead of quitting: the tray owns the lifecycle.
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });
  // Re-attach after every navigation: a new document starts without the rule
  // and without the strip element.
  win.webContents.on('did-finish-load', () => { void attachDragRegion(win); });
  win.webContents.on('did-navigate', () => { void attachDragRegion(win); });
  void installDragRegion(win);
  win.once('closed', () => { windows.dsh = null; });
  windows.dsh = win;
  return win;
}

/**
 * Open (or focus) the DSH window, starting the server when needed.
 *
 * Guarded against re-entry: the startup path and a tray click can race, and two
 * concurrent ensure() calls would fight over the same port.
 */
async function openDsh() {
  if (openingDsh) return;
  openingDsh = true;
  try {
    ensureDshWindow();
    const loading = ensureLoadingWindow();
    if (!loading.isVisible()) loading.show();

    if (supervisor === null) {
      await showFailure('启动器尚未初始化完成。');
      return;
    }

    const ensured = await supervisor.ensure();
    state = supervisor.snapshot();
    refreshTray();

    if (!ensured.ok) {
      if (ensured.reason === '已经在启动中') {
        await waitForServerAndLoad();
        return;
      }
      await showFailure(ensured.reason ?? '服务无法启动。');
      return;
    }
    await waitForServerAndLoad();
  } finally {
    openingDsh = false;
  }
}

async function showFailure(message) {
  closeLoadingWindow();
  const win = ensureDshWindow();
  const safe = String(message).replace(/[<&]/gu, (c) => (c === '<' ? '&lt;' : '&amp;'));
  const html = `<!doctype html><meta charset="utf-8"><title>DSH 启动器</title>
<style>
body{font:14px/1.7 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;background:${COLOR_BACKGROUND};color:${COLOR_TEXT};margin:0;padding:44px}
h1{font-size:18px;font-weight:600;margin:0 0 14px;color:#e8a0a0}
p{margin:0 0 12px;color:${COLOR_MUTED}}
code,pre{background:rgba(242,239,233,0.08);color:${COLOR_TEXT};padding:2px 6px;border-radius:4px}
b{color:${COLOR_TEXT}}
.draghint{position:fixed;top:0;left:0;right:0;height:${String(TITLE_BAR_HEIGHT)}px;-webkit-app-region:drag;app-region:drag}
</style>
<div class="draghint"></div>
<h1>DeepSeek Harness 服务启动失败</h1>
<p>${safe}</p>
<p>请打开托盘菜单 → <b>诊断…</b> 查看捕获的输出，或点 <b>重启服务</b> 重试。</p>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await attachDragRegion(win);
  win.show();
  win.focus();
}

function showDiagnostics() {
  if (windows.diagnostics !== null && !windows.diagnostics.isDestroyed()) {
    windows.diagnostics.show();
    windows.diagnostics.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 780,
    height: 620,
    minWidth: 520,
    minHeight: 380,
    show: false,
    title: 'DSH 启动器 — 诊断',
    backgroundColor: COLOR_BACKGROUND,
    icon: iconPath(),
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlay(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  void win.loadFile(path.join(__dirname, '..', 'renderer', 'diagnostics.html'));
  win.webContents.on('did-finish-load', () => { void attachDragRegion(win); });
  void installDragRegion(win);
  win.once('ready-to-show', () => win.show());
  win.once('closed', () => { windows.diagnostics = null; });
  windows.diagnostics = win;
}

// ── actions ──────────────────────────────────────────────────────────────────

async function restartService() {
  const answer = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['重启', '取消'],
    defaultId: 1,
    cancelId: 1,
    title: '重启 DSH 服务',
    message: '确定要重启 DeepSeek Harness 服务吗？',
    detail: state.adopted && supervisor?.child == null
      ? '当前端口上的服务不是启动器启动的。重启会终止该进程，其中正在运行的 agent 任务也会一并中断。'
      : '当前会话中正在运行的 agent 任务会被中断。',
  });
  if (answer.response !== 0) return;

  if (state.adopted && supervisor !== null && supervisor.child === null) {
    // Adopted instances are not our children; ask the OS to end whatever owns the port.
    await killForeignListener(state.port);
  }
  closeLoadingWindow();
  ensureDshWindow();
  ensureLoadingWindow().show();
  await supervisor.restart();
  state = supervisor.snapshot();
  refreshTray();
  await waitForServerAndLoad();
}

function killForeignListener(port) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(false);
    const find = spawn('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true });
    let out = '';
    find.stdout.setEncoding('utf8');
    find.stdout.on('data', (chunk) => { out += chunk; });
    find.once('close', () => {
      const pids = new Set();
      for (const line of out.split(/\r?\n/u)) {
        const parts = line.trim().split(/\s+/u);
        if (parts.length < 5) continue;
        if (parts[1]?.endsWith(`:${String(port)}`) === true && parts[3] === 'LISTENING') pids.add(parts[4]);
      }
      for (const pid of pids) {
        spawn('taskkill', ['/PID', pid, '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      }
      resolve(pids.size > 0);
    });
    find.once('error', () => resolve(false));
  });
}

async function checkForUpdates() {
  if (updateState.phase === 'checking' || updateState.phase === 'installing') return;
  updateState = { ...updateState, phase: 'checking', message: null };
  refreshTray();
  pushUpdateState();

  const result = await updater.check();
  if (!result.ok) {
    updateState = { phase: 'failed', current: null, latest: null, message: result.reason };
    refreshTray();
    pushUpdateState();
    void dialog.showMessageBox({ type: 'error', title: '检查更新失败', message: '无法检查 dsh 更新。', detail: result.reason });
    return;
  }

  if (!result.updateAvailable) {
    updateState = { phase: 'current', current: result.current, latest: result.latest, message: null };
    refreshTray();
    pushUpdateState();
    void dialog.showMessageBox({ type: 'info', title: '暂无更新', message: `dsh ${result.current} 已是当前已发布的最新版本。` });
    return;
  }

  updateState = { phase: 'available', current: result.current, latest: result.latest, message: null };
  refreshTray();
  pushUpdateState();

  const answer = await dialog.showMessageBox({
    type: 'question',
    buttons: [`更新到 ${result.latest}`, '取消'],
    defaultId: 0,
    cancelId: 1,
    title: 'dsh 有新版本',
    message: `将 dsh 从 ${result.current} 更新到 ${result.latest}？`,
    detail: [
      '更新前会先停止服务，正在运行的 agent 任务会被中断。',
      'Windows 上 dsh 运行时全局安装会失败，因此必须先停止服务。',
      '下次启动可能需要重装 profile 依赖，耗时较长。',
    ].join('\n'),
  });
  if (answer.response !== 0) return;

  updateState = { ...updateState, phase: 'installing' };
  refreshTray();
  pushUpdateState();

  await supervisor.stop();
  state = supervisor.snapshot();
  refreshTray();

  const install = await updater.install(result.latest, (line) => recordLog('update', line));
  if (!install.ok) {
    updateState = { phase: 'failed', current: result.current, latest: result.latest, message: install.reason };
    refreshTray();
    pushUpdateState();
    void dialog.showMessageBox({ type: 'error', title: '更新失败', message: '无法安装更新。', detail: install.reason });
    return;
  }

  config.save({ dshEntryPath: findDshEntry(), nodePath: findNodePath() });
  const verify = await updater.installedVersion();
  const confirmed = verify.ok && verify.version === result.latest;
  updateState = {
    phase: confirmed ? 'current' : 'failed',
    current: verify.ok ? verify.version : null,
    latest: result.latest,
    message: confirmed ? null : `已安装 ${result.latest}，但 dsh 报告版本为 ${verify.ok ? verify.version : '未知版本'}`,
  };
  refreshTray();
  pushUpdateState();

  await supervisor.start();
  state = supervisor.snapshot();
  refreshTray();
  void dialog.showMessageBox({
    type: confirmed ? 'info' : 'warning',
    title: confirmed ? '更新完成' : '更新需要处理',
    message: confirmed ? `dsh ${result.latest} 已安装。` : '更新未能通过校验。',
    detail: confirmed ? '服务已重新启动。' : String(updateState.message),
  });
}

function pushUpdateState() {
  if (windows.diagnostics !== null && !windows.diagnostics.isDestroyed()) {
    windows.diagnostics.webContents.send('launcher:update', updateState);
  }
}

async function quitApp() {
  quitting = true;
  try {
    // force: quitting is not a moment to negotiate. The graceful window exists
    // for restarts, where an in-flight install may still be writing.
    if (supervisor !== null) await supervisor.stop({ force: true });
  } catch (error) {
    console.warn('main: shutdown error (%s)', error.message);
  }
  app.quit();
}

// ── diagnostics IPC ──────────────────────────────────────────────────────────

function diagnosticsSnapshot() {
  return {
    state: state.state,
    statusLabel: statusLabel(),
    port: state.port,
    url: `http://127.0.0.1:${String(state.port)}/`,
    adopted: state.adopted,
    error: state.error,
    pid: supervisor?.child?.pid ?? null,
    configPath: config.configPath(),
    credentialsPath: auth.credentialsPath(),
    dshHome: dshHome(),
    nodePath: config.get('nodePath'),
    dshEntryPath: config.get('dshEntryPath'),
    profileNodeModules: updater.profileNodeModules(),
    update: updateState,
    logs: logLines.join('\n'),
  };
}

function registerIpc() {
  ipcMain.handle('launcher:snapshot', () => diagnosticsSnapshot());
  ipcMain.handle('launcher:open-dsh', async () => { await openDsh(); return diagnosticsSnapshot(); });
  ipcMain.handle('launcher:restart', async () => { await restartService(); return diagnosticsSnapshot(); });
  ipcMain.handle('launcher:check-updates', async () => { void checkForUpdates(); return { started: true }; });
  ipcMain.handle('launcher:open-path', async (_event, target) => {
    const allowed = new Set([dshHome(), app.getPath('userData')]);
    if (!allowed.has(target)) return { ok: false, reason: '启动器不允许打开该路径' };
    const error = await shell.openPath(target);
    return error === '' ? { ok: true } : { ok: false, reason: error };
  });
  ipcMain.handle('launcher:copy-url', async (_event, value) => {
    // Only the bare URL is ever exposed; a token-bearing URL must not leak here.
    const { clipboard } = require('electron');
    clipboard.writeText(String(value));
    return { ok: true };
  });
}

// ── lifecycle ────────────────────────────────────────────────────────────────

/**
 * Build the supervisor as early as possible: window code reads host/port from
 * it, so a late construction would let a window bind to a stale authority.
 * Nothing here touches an Electron API before app readiness.
 */
function createSupervisor(port) {
  const instance = new Supervisor({ port });
  instance.on('state', (snapshot) => {
    state = snapshot;
    refreshTray();
    pushUpdateState();
    if (windows.diagnostics !== null && !windows.diagnostics.isDestroyed()) {
      windows.diagnostics.webContents.send('launcher:state', diagnosticsSnapshot());
    }
  });
  instance.on('output', ({ stream, chunk }) => { recordLog(stream, chunk); });
  return instance;
}

supervisor = createSupervisor(config.get('port'));

/**
 * Headless integration check, enabled only by DSH_LAUNCHER_SELF_TEST=1.
 *
 * Covers the paths that cannot be verified by clicking the tray: server
 * adoption, cookie minting, that the authenticated root request actually
 * returns 200 through Chromium's own session cookie jar, and that shutdown
 * leaves no orphan. Exits non-zero on the first failed step.
 */
async function runSelfTest() {
  // Results also land in a file. A packaged GUI-subsystem build does not
  // reliably attach to the parent console, so stdout alone is not trustworthy
  // evidence that the checks ran at all.
  const reportPath = process.env.DSH_LAUNCHER_SELF_TEST_REPORT;
  const report = [];
  // Defence in depth: the stream handler above stops EPIPE from throwing, but a
  // dead console should degrade to "file only" rather than risk anything else.
  const emit = (line) => {
    try {
      process.stdout.write(`${line}\n`);
    } catch {
      // Ignore: the file report is the authoritative record.
    }
  };
  const step = (name, ok, detail) => {
    const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` - ${detail}`}`;
    emit(line);
    report.push(line);
    if (reportPath !== undefined && reportPath !== '') {
      try {
        fs.writeFileSync(reportPath, `${report.join('\n')}\n`, 'utf8');
      } catch (error) {
        emit(`could not write report: ${error.message}`);
      }
    }
    if (!ok) process.exitCode = 1;
    return ok;
  };

  step('isolated launcher instance (single-instance lock held)', true);

  // A self-test run must look like a manual launch, otherwise it would exercise
  // the tray-only path and never open a window. This also pins the autostart
  // detection: two earlier implementations reported true for ordinary launches
  // and left the window hidden.
  step('self-test is not treated as an autostart launch', launchedAtLogin() === false,
    `argv has ${AUTOSTART_ARG}: ${String(process.argv.includes(AUTOSTART_ARG))}`);

  const port = Number.parseInt(process.env.DSH_LAUNCHER_SELF_TEST_PORT ?? '', 10) || config.get('port');
  const nodePath = findNodePath();
  const dshEntry = config.get('dshEntryPath') ?? findDshEntry();
  step('resolve node', nodePath !== null, nodePath ?? 'not found');
  step('resolve dsh entry', dshEntry !== null && fs.existsSync(dshEntry), dshEntry ?? 'not found');
  if (nodePath === null || dshEntry === null) return;

  supervisor = createSupervisor(port);

  const alreadyListening = await supervisor.probe();
  const ensured = await supervisor.ensure();
  step('server available', ensured.ok, ensured.adopted ? 'adopted an existing listener' : 'started by the launcher');
  if (!ensured.ok) return;

  const target = { host: '127.0.0.1', port };
  const session = require('electron').session.fromPartition(SESSION_PARTITION);

  const anonymous = await new Promise((resolve) => {
    const request = require('node:http').get(`http://${target.host}:${String(port)}/`, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    request.on('error', () => resolve(0));
  });
  step('unauthenticated root request is fenced', alreadyListening ? anonymous === 401 : anonymous !== 200,
    `status ${String(anonymous)}`);

  const configured = await auth.configureSession(session, target);
  step('mint browser-session cookie', configured.ok, configured.ok ? configured.source : configured.reason);
  if (!configured.ok) return;

  const stored = await session.cookies.get({ name: auth.cookieName(target.host + ':' + String(port)) });
  step('cookie is present in the window session', stored.length === 1, `${String(stored.length)} match(es)`);

  const win = ensureDshWindow();
  await loadAuthenticated();
  step('authenticated page loaded', !win.isDestroyed(), win.webContents.getURL());

  const outcome = await new Promise((resolve) => {
    const request = require('node:http').get(
      { host: target.host, port, path: '/', headers: { cookie: `${stored[0]?.name ?? ''}=${stored[0]?.value ?? ''}` } },
      (res) => { res.resume(); resolve(res.statusCode); },
    );
    request.on('error', () => resolve(0));
  });
  step('cookie authenticates over HTTP', outcome === 200, `status ${String(outcome)}`);

  if (supervisor.child !== null) {
    const childPid = supervisor.child.pid;
    await supervisor.stop();
    step('supervisor released its child', supervisor.child === null);
    // Windows does not reap the PID or release the socket synchronously, so
    // both conditions are polled rather than asserted on the next tick.
    step('child process is gone', await waitUntil(() => !isAlive(childPid)), `pid ${String(childPid)}`);
    step('port is released', await waitUntil(async () => !(await supervisor.probe())), `${String(port)} free`);
    const again = await supervisor.stop();
    step('stop is idempotent on an already-stopped server', again.ok === true && again.killed === false);
  } else {
    step('left adopted server running (not owned by the launcher)', true);
  }

  // The tray owns the lifecycle: its icon must actually load, and a window
  // close must hide rather than destroy the DSH view.
  const image = trayImage();
  step('tray icon loads', !image.isEmpty(), `${String(image.getSize().width)}x${String(image.getSize().height)}`);
  const closeable = ensureDshWindow();
  closeable.close();
  step('window close hides to tray', !closeable.isDestroyed() && !closeable.isVisible());
  step('hidden window is reused, not recreated', ensureDshWindow() === closeable);

  // `titleBarStyle: 'hidden'` removes the native title bar along with its drag
  // area, which made the window impossible to move. The replacement is an
  // injected strip that must exist in the document.
  const dragStrip = await closeable.webContents.executeJavaScript(
    `(() => {
       const strip = document.getElementById('dsh-launcher-drag-strip');
       if (strip === null) return { present: false };
       const style = getComputedStyle(strip);
       return {
         present: true,
         region: style.getPropertyValue('app-region') || style.getPropertyValue('-webkit-app-region'),
         height: strip.getBoundingClientRect().height,
         top: strip.getBoundingClientRect().top,
       };
     })()`,
  ).catch((error) => ({ present: false, error: error.message }));
  step('drag strip present in the DSH window', dragStrip.present === true,
    dragStrip.error ?? `${String(dragStrip.height)}px tall at y=${String(dragStrip.top)}, region="${String(dragStrip.region)}"`);
  step('drag strip declares a drag region', dragStrip.region === 'drag');

  // The packaged app once shipped without renderer/ because the electron-builder
  // `files` allowlist did not list it. The diagnostics window then opened blank,
  // and nothing in this self-test noticed. Assert both that the assets exist and
  // that the page really renders.
  const rendererDir = path.join(__dirname, '..', 'renderer');
  for (const page of ['loading.html', 'diagnostics.html']) {
    const file = path.join(rendererDir, page);
    step(`renderer asset present: ${page}`, fs.existsSync(file), file);
  }

  const diagnostics = new BrowserWindow({
    width: 780,
    height: 620,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  let loadFailure = null;
  diagnostics.webContents.on('did-fail-load', (_event, code, description) => {
    loadFailure = `${String(code)} ${description}`;
  });
  const loaded = new Promise((resolve) => diagnostics.webContents.once('did-finish-load', resolve));
  void diagnostics.loadFile(path.join(rendererDir, 'diagnostics.html'));
  await Promise.race([loaded, new Promise((resolve) => setTimeout(resolve, 8000))]);
  step('diagnostics page loads', loadFailure === null, loadFailure ?? 'no did-fail-load');

  const rendered = await diagnostics.webContents.executeJavaScript(
    `(() => {
       const facts = document.getElementById('facts');
       const status = document.getElementById('status');
       return {
         title: document.title,
         hasFacts: facts !== null,
         rows: facts === null ? 0 : facts.children.length,
         statusText: status === null ? null : status.textContent,
         bridge: typeof window.launcher === 'object' && window.launcher !== null,
       };
     })()`,
  ).catch((error) => ({ error: error.message }));
  step('diagnostics renders content', rendered.error === undefined && rendered.hasFacts === true,
    rendered.error ?? `title="${rendered.title}" rows=${String(rendered.rows)}`);
  step('preload bridge exposed', rendered.bridge === true);
  step('diagnostics read a snapshot', rendered.rows > 0, `${String(rendered.rows)} row(s), status "${rendered.statusText}"`);
  diagnostics.destroy();

  // Quitting used to take ~20s because stop() waited 8s for a graceful exit and
  // another 3s to confirm, on top of Electron teardown. Time it, so a
  // regression is caught here instead of being felt by the user.
  if (supervisor.child !== null) {
    const startedAt = Date.now();
    await supervisor.stop({ force: true });
    const elapsed = Date.now() - startedAt;
    step('forced stop returns promptly', elapsed < 4000, `${String(elapsed)}ms`);
  }
}

/** Poll a condition that Windows may only satisfy after a delay. */
async function waitUntil(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

function isAlive(pid) {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

if (app.requestSingleInstanceLock() === false) {
  app.quit();
} else {
  app.on('second-instance', () => { void openDsh(); });

  app.whenReady().then(async () => {
    // The caption overlay is drawn by Windows, which picks light or dark glyph
    // rendering from the system theme. Without this the buttons are rendered
    // for a light title bar and look wrong on the dark caption.
    nativeTheme.themeSource = 'dark';

    registerIpc();

    if (process.env.DSH_LAUNCHER_SELF_TEST === '1') {
      try {
        await runSelfTest();
      } catch (error) {
        console.log(`FAIL  self-test threw - ${error.stack ?? error.message}`);
        process.exitCode = 1;
      }
      quitting = true;
      app.exit(process.exitCode ?? 0);
      return;
    }

    supervisor = createSupervisor(config.get('port'));

    windows.tray = new Tray(trayImage());
    windows.tray.setToolTip('DSH 启动器');
    refreshTray();
    windows.tray.on('click', () => { void openDsh(); });

    // Honour a persisted preference on start, then always show the tray. The
    // mismatch check also migrates an entry written by an older build, which
    // registered the path without the --autostart argument.
    const desired = config.get('launchAtLogin');
    if (desired !== app.getLoginItemSettings().openAtLogin) {
      applyLoginItem(desired);
    }

    state = supervisor.snapshot();
    refreshTray();

    // A manual launch opens the window straight away; a login launch only
    // installs the tray, so signing in does not throw a window in the user's
    // face. Both leave the tray as the single owner of the lifecycle.
    if (launchedAtLogin()) {
      recordLog('launcher', 'started by the login item; staying in the tray');
    } else {
      void openDsh();
    }

    // Quit-path timing hook for the self-test. Quitting used to take ~20s, and
    // the regular self-test cannot observe it: that path calls app.exit()
    // directly, while the slow code lives in quitApp(). This drives the real
    // function so the measured number reflects what a user feels.
    const quitAfter = Number.parseInt(process.env.DSH_LAUNCHER_SELF_TEST_QUIT_AFTER_MS ?? '', 10);
    if (Number.isFinite(quitAfter) && quitAfter > 0) {
      setTimeout(() => {
        const startedAt = Date.now();
        recordLog('selftest', `quit path starting (after ${String(quitAfter)}ms of runtime)`);
        process.once('exit', () => {
          const elapsed = Date.now() - startedAt;
          try {
            fs.writeFileSync(
              process.env.DSH_LAUNCHER_SELF_TEST_QUIT_REPORT ?? path.join(app.getPath('userData'), 'quit-timing.txt'),
              `${String(elapsed)}\n`,
              'utf8',
            );
          } catch {
            // A missing report only costs the measurement, not the shutdown.
          }
        });
        void quitApp();
      }, quitAfter);
    }
  });

  // The tray owns the lifecycle: closing every window must not quit.
  app.on('window-all-closed', () => {});

  app.on('before-quit', () => { quitting = true; });
}

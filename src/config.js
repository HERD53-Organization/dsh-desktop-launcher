'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Electron is optional: this module also runs under bare Node, where requiring
// the 'electron' package throws rather than returning a stub.
let app;
try {
  ({ app } = require('electron'));
} catch {
  app = undefined;
}

/**
 * Launcher-owned configuration. This file lives under Electron's userData and
 * never touches ~/.dsh: DSH hot-reloads its own configuration files (cordis
 * watches them), so a second writer there would fight the running server.
 */

const DEFAULTS = {
  // Port for the launcher-managed `dsh web` instance.
  port: 3080,
  // Resolved once and cached, so PATH changes cannot silently switch Node.
  nodePath: null,
  dshEntryPath: null,
  // Launch the launcher (not the server) when the user signs in.
  launchAtLogin: false,
  // How long to wait for `dsh web` to print its URL before showing a hint.
  startupTimeoutMs: 180000,
};

let cache = null;

/**
 * Directory for launcher-owned state.
 *
 * Electron's userData is the real answer, but the updater and the resolver are
 * plain modules that must also run under bare Node (scripts, tests), so this
 * falls back to the platform's conventional location when Electron is absent.
 */
function dataDir() {
  if (app !== undefined && typeof app.getPath === 'function') return app.getPath('userData');
  const os = require('node:os');
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'dsh-desktop-launcher');
  }
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'dsh-desktop-launcher');
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'dsh-desktop-launcher');
}

function configPath() {
  return path.join(dataDir(), 'launcher-config.json');
}

function load() {
  if (cache !== null) return cache;
  const file = configPath();
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('config: ignoring unreadable %s (%s)', file, error.message);
    }
  }
  cache = { ...DEFAULTS, ...(stored !== null && typeof stored === 'object' ? stored : {}) };
  return cache;
}

function save(patch) {
  const next = { ...load(), ...patch };
  cache = next;
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
  return next;
}

function get(key) {
  return load()[key];
}

module.exports = { get, save, load, configPath, DEFAULTS };

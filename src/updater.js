'use strict';

const { execFile } = require('node:child_process');
const path = require('node:path');
const semver = require('semver');
const config = require('./config');

/**
 * Manual-only update check for the dsh CLI.
 *
 * Version selection deliberately does NOT use npm dist-tags. On this product
 * `latest` lags the release-candidate line (latest=0.1.5-rc.3 while the newest
 * published version is 0.1.7-rc.2), so anything tag-driven either stalls or
 * silently downgrades. Instead the full version list is read and the highest
 * semver wins, prereleases included.
 *
 * A test build of the desktop product appends a fourth numeric field
 * (0.1.6-alpha.1.20260916.1). Those are not CLI releases and are excluded.
 */

const PACKAGE_NAME = '@deepseek-ai/dsh';
const TEST_BUILD_PATTERN = /^\d+\.\d+\.\d+-[0-9A-Za-z.-]+\.\d{8}\.\d+$/u;

/**
 * Run a tool without `shell: true`.
 *
 * Node deprecated passing `shell: true` together with args because the args are
 * concatenated rather than escaped. npm and npx ship as `.cmd` shims on
 * Windows, which execFile refuses to launch directly, so those are routed
 * through `cmd.exe` explicitly instead of via a shell string.
 */
function runTool(command, args, options = {}) {
  const isShim = process.platform === 'win32' && /\.(cmd|bat)$/iu.test(command);
  const file = isShim ? (process.env.ComSpec ?? 'cmd.exe') : command;
  const argv = isShim ? ['/d', '/s', '/c', command, ...args] : args;
  return new Promise((resolve) => {
    execFile(file, argv, {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      ...options,
    }, (error, stdout, stderr) => {
      resolve({ error, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** All published versions of the CLI, as plain strings. */
async function fetchVersions() {
  const result = await runTool(NPM, ['view', PACKAGE_NAME, 'versions', '--json']);
  if (result.error) {
    return { ok: false, reason: `could not reach the npm registry: ${result.error.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    return { ok: false, reason: `npm returned unreadable output: ${error.message}` };
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return { ok: true, versions: list.filter((value) => typeof value === 'string') };
}

/** The installed CLI version, read from the CLI itself rather than from npm. */
async function installedVersion() {
  const nodePath = config.get('nodePath');
  const dshEntry = config.get('dshEntryPath');
  if (nodePath === null || dshEntry === null) return { ok: false, reason: 'the launcher has not resolved node/dsh yet' };
  const result = await runTool(nodePath, [dshEntry, '--version']);
  if (result.error) return { ok: false, reason: `dsh --version failed: ${result.error.message}` };
  const version = result.stdout.trim().split(/\s+/u)[0];
  return semver.valid(version) === null
    ? { ok: false, reason: `unexpected dsh --version output: ${JSON.stringify(result.stdout.trim())}` }
    : { ok: true, version };
}

function highestVersion(versions) {
  const usable = versions.filter((value) => semver.valid(value) !== null && !TEST_BUILD_PATTERN.test(value));
  if (usable.length === 0) return null;
  return usable.reduce((best, value) => (semver.gt(value, best) ? value : best));
}

/**
 * Compare the installed CLI against every published version.
 * @returns {Promise<{ok: boolean, current?: string, latest?: string, updateAvailable?: boolean, reason?: string}>}
 */
async function check() {
  const current = await installedVersion();
  if (!current.ok) return { ok: false, reason: current.reason };

  const published = await fetchVersions();
  if (!published.ok) return { ok: false, reason: published.reason };

  const latest = highestVersion(published.versions);
  if (latest === null) return { ok: false, reason: 'no usable versions were published' };

  return {
    ok: true,
    current: current.version,
    latest,
    updateAvailable: semver.gt(latest, current.version),
  };
}

/**
 * Install one exact version globally.
 *
 * Caller contract: the supervisor must already be stopped. On Windows a global
 * install fails with EPERM when a running dsh holds files in the install tree,
 * and an in-flight agent task should not be interrupted by a package swap.
 * @param {string} version - exact version to install.
 * @param {(line: string) => void} [onLine] - progress sink.
 */
async function install(version, onLine = () => {}) {
  if (semver.valid(version) === null) return { ok: false, reason: `refusing to install invalid version ${JSON.stringify(version)}` };
  onLine(`npm install -g ${PACKAGE_NAME}@${version}`);
  const result = await runTool(NPM, ['install', '-g', `${PACKAGE_NAME}@${version}`, '--no-audit', '--no-fund']);
  if (result.stdout.trim() !== '') onLine(result.stdout.trim());
  if (result.error) {
    const detail = (result.stderr.trim() || result.error.message).split(/\r?\n/u)[0];
    return { ok: false, reason: `update failed: ${detail}` };
  }
  onLine(result.stderr.trim());
  return { ok: true, version };
}

/** Directory that holds the profile dependency tree, for diagnostics. */
function profileNodeModules() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : path.join(require('node:os').homedir(), '.dsh');
  return path.join(home, 'profiles', 'node_modules');
}

module.exports = {
  PACKAGE_NAME,
  check,
  install,
  fetchVersions,
  installedVersion,
  highestVersion,
  profileNodeModules,
};

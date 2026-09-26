'use strict';

const { createHash, createHmac } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');

/**
 * DSH browser-session authentication.
 *
 * A local `dsh web` server authenticates with two independent keys:
 *
 *   1. A per-process launch token, minted with randomBytes(32) at startup. It
 *      appears as `?token=` in the URL `dsh web` prints, is verified only for
 *      the first `GET /`, and is exchanged there for a cookie. It changes on
 *      every restart.
 *   2. A persistent signing secret stored in the credentials document as the
 *      `client-connection/browser-session` record. It signs the HttpOnly
 *      `dsh-auth-<authority>` cookie that authenticates every later request.
 *
 * Only key 2 lives outside a running process, so a launcher that owns its own
 * Electron session can authenticate without capturing stdout and without
 * restarting a server it did not start. The cookie payload carries the
 * authority plus issue/expiry timestamps — never the launch token — so a cookie
 * stays valid across server restarts.
 *
 * The layout below mirrors @deepseek-ai/dsh-client-connection (browser-auth
 * region). It is an implementation detail of a release-candidate product, not a
 * public API: if DSH changes the format, `configureSession` fails loudly and
 * the supervisor falls back to the URL printed on stdout.
 */

const AUTHORITY_HEADER = 'host';
const COOKIE_PREFIX = 'dsh-auth-';
const COOKIE_PAYLOAD_VERSION = 1;
const STORED_SECRET_VERSION = 1;
const SECRET_BYTES = 32;
const DAY_MILLISECONDS = 1440 * 60 * 1000;
const AUTH_RECORD_KEY = 'client-connection/browser-session';

function encodeBase64Url(value) {
  return Buffer.from(value).toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

function decodeBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/u.test(value)) return undefined;
  if (value.length % 4 === 1) return undefined;
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const decoded = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64');
  return encodeBase64Url(decoded) === value ? decoded : undefined;
}

function canonicalSecret(value) {
  const decoded = decodeBase64Url(value);
  if (decoded === undefined || decoded.byteLength !== SECRET_BYTES) return undefined;
  return decoded;
}

function credentialsPath() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh');
  return path.join(home, '.credentials.yaml');
}

/**
 * Read the persistent browser-session signing secret.
 * @returns {{secret: Buffer, path: string}|{error: string, path: string}}
 */
function readSessionSecret() {
  const file = credentialsPath();
  if (!fs.existsSync(file)) return { error: `credentials file not found: ${file}`, path: file };
  let document;
  try {
    document = YAML.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { error: `credentials file is not valid YAML: ${error.message}`, path: file };
  }
  const record = document?.records?.[AUTH_RECORD_KEY];
  if (record === undefined) {
    return { error: `${AUTH_RECORD_KEY} record is absent; the server has not minted one yet`, path: file };
  }
  if (record.kind !== 'grant' || record.payload?.version !== STORED_SECRET_VERSION) {
    return { error: `${AUTH_RECORD_KEY} record has an unsupported format`, path: file };
  }
  const secret = canonicalSecret(record.payload.secret);
  if (secret === undefined) {
    return { error: `${AUTH_RECORD_KEY} record carries an invalid secret`, path: file };
  }
  return { secret, path: file };
}

function cookieName(authority) {
  return COOKIE_PREFIX + encodeBase64Url(createHash('sha256').update(authority).digest());
}

function encodeCookie(payload, secret) {
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signature = encodeBase64Url(createHmac('sha256', secret).update(body).digest());
  return `v1.${body}.${signature}`;
}

/**
 * Mint a session cookie for one authority.
 * @param {Buffer} secret - persistent signing secret.
 * @param {string} authority - `host:port` exactly as the server sees it in Host.
 * @param {number} maxAgeDays - absolute cookie lifetime in days.
 */
function mintCookie(secret, authority, maxAgeDays) {
  const issuedAt = Date.now();
  const maxAgeMilliseconds = maxAgeDays * DAY_MILLISECONDS;
  const expiresAt = issuedAt + maxAgeMilliseconds;
  const value = encodeCookie(
    { version: COOKIE_PAYLOAD_VERSION, authority, issuedAt, expiresAt },
    secret,
  );
  return { name: cookieName(authority), value, expiresAt, maxAgeMilliseconds };
}

/**
 * Authenticate a window session against a local server without a launch token.
 * @param {Electron.Session} session - the window's session (persistent partition).
 * @param {{host: string, port: number}} target - server authority.
 * @returns {Promise<{ok: true, authority: string, source: string}|{ok: false, reason: string}>}
 */
async function configureSession(session, target) {
  const authority = `${target.host}:${String(target.port)}`;
  const read = readSessionSecret();
  if (read.secret === undefined) return { ok: false, reason: read.error };

  const minted = mintCookie(read.secret, authority, 30);
  const url = `http://${authority}/`;
  try {
    await session.cookies.set({
      url,
      name: minted.name,
      value: minted.value,
      domain: target.host,
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'strict',
      expirationDate: minted.expiresAt / 1000,
    });
  } catch (error) {
    return { ok: false, reason: `could not set session cookie: ${error.message}` };
  }

  // Persist to disk so the cookie is present even if the server restarts before
  // the page loads. Failure here is not fatal: the in-memory cookie still works.
  try {
    await session.cookies.flushStore();
  } catch (error) {
    console.warn('auth: cookie store flush failed (%s)', error.message);
  }

  return { ok: true, authority, source: read.path };
}

/** Clear the launcher's authentication cookies so a recovered session re-mints. */
async function clearSession(session) {
  try {
    const cookies = await session.cookies.get({});
    await Promise.all(cookies
      .filter((cookie) => cookie.name.startsWith(COOKIE_PREFIX))
      .map((cookie) => session.cookies.remove(`http://${cookie.domain}${cookie.path}`, cookie.name)));
  } catch (error) {
    console.warn('auth: could not clear session cookies (%s)', error.message);
  }
}

module.exports = {
  AUTH_RECORD_KEY,
  credentialsPath,
  readSessionSecret,
  mintCookie,
  configureSession,
  clearSession,
  cookieName,
};

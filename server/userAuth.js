'use strict';
// User-based mutation auth for the office HUD, sharing the control-center's
// account store (~/.openalice-control/auth.json). Token and password formats
// are byte-compatible with control-center/auth.py: cookie value is
// b64url("user|role|exp").hex(hmac-sha256(secret, payload)), passwords are
// PBKDF2-SHA256(120k, hex salt).
//
// Scope decision (2026-10-11): reads stay open, mutations require a session.
// That matches the existing read-only API gate; this module replaces "405
// read-only" with "401/403 login_required" for the allowlisted POSTs.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROLES = { viewer: 0, operator: 1, admin: 2 };
const SESSION_TTL = 12 * 3600;
const COOKIE = 'hud_session';
const PBKDF2_ITERS = 120000;
const LOGIN_WINDOW_MS = 60000;
const LOGIN_MAX_ATTEMPTS = 10;

function authFile() {
  return process.env.CONTROL_AUTH_FILE
    || path.join(os.homedir(), '.openalice-control', 'auth.json');
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(authFile(), 'utf8'));
  } catch {
    return null;
  }
}

function hashPassword(pw, saltHex) {
  return crypto.pbkdf2Sync(pw, Buffer.from(saltHex, 'hex'), PBKDF2_ITERS, 32, 'sha256').toString('hex');
}

function verify(user, pw) {
  const data = load();
  const entry = data && data.users && data.users[user];
  if (!entry) return null;
  const calc = Buffer.from(hashPassword(pw, entry.salt), 'utf8');
  const want = Buffer.from(entry.hash, 'utf8');
  if (calc.length === want.length && crypto.timingSafeEqual(calc, want)) return entry.role;
  return null;
}

function b64url(s) {
  return Buffer.from(s, 'utf8').toString('base64url').replace(/=+$/, '');
}

function unb64url(s) {
  return Buffer.from(s, 'base64url').toString('utf8');
}

function makeToken(user, role) {
  const data = load() || {};
  if (!data.secret) return null;
  const payload = `${user}|${role}|${Math.floor(Date.now() / 1000) + SESSION_TTL}`;
  const sig = crypto.createHmac('sha256', data.secret).update(payload).digest('hex');
  return `${b64url(payload)}.${sig}`;
}

const revoked = new Map(); // payload -> exp (epoch sec)

function revoke(token) {
  try {
    const payload = String(token).split('.', 1)[0];
    const exp = Number(unb64url(payload).split('|')[2]);
    if (revoked.size > 4096) {
      const now = Math.floor(Date.now() / 1000);
      for (const [k, e] of revoked) if (e < now) revoked.delete(k);
    }
    revoked.set(payload, Number.isFinite(exp) ? exp : 0);
  } catch { /* unreadable token was never valid anyway */ }
}

function checkToken(token) {
  const data = load();
  if (!data || !data.secret) return null;
  try {
    const dot = token.indexOf('.');
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const raw = unb64url(payload);
    const expect = crypto.createHmac('sha256', data.secret).update(raw).digest('hex');
    const a = Buffer.from(sig, 'utf8');
    const b = Buffer.from(expect, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    if (revoked.has(payload)) return null;
    const [user, role, exp] = raw.split('|');
    if (!(role in ROLES) || Number(exp) < Math.floor(Date.now() / 1000)) return null;
    const entry = data.users && data.users[user];
    if (!entry || entry.role !== role) return null; // role change or user removal ends sessions
    return { user, role };
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function session(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  return token ? checkToken(token) : null;
}

// Role floors for mutation routes. Everything allowlisted defaults to
// operator; routes that run code, touch processes, or change policy need admin.
const ADMIN_PREFIXES = [
  '/api/terminals/',
  '/api/recovery/',
  '/api/sessions/',
];
const ADMIN_EXACT = new Set([
  '/api/jarvis/command',
  '/api/autopilot/policy',
  '/api/autopilot/tick',
  '/api/autonomy/policy',
  '/api/polymarket/start',
  '/api/polymarket/stop',
]);

function requiredRole(p) {
  if (ADMIN_EXACT.has(p)) return 'admin';
  if (ADMIN_PREFIXES.some((prefix) => p.startsWith(prefix))) return 'admin';
  return 'operator';
}

const EXEMPT_POST = new Set(['/api/login', '/api/logout']);
// The login routes need not be allowlisted by the read-only gate to reach their
// handlers; index.js consults this set when deciding what counts as a mutation.
const AUTH_ROUTES = EXEMPT_POST;

const loginAttempts = new Map(); // ip -> {count, windowStart}

function rateLimited(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec || now - rec.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, windowStart: now });
    return false;
  }
  rec.count += 1;
  return rec.count > LOGIN_MAX_ATTEMPTS;
}

/**
 * Express middleware. Mount AFTER the read-only/allowlist gate: it sees only
 * POSTs that the gate let through, plus the exempt login routes.
 */
function mutationGate(req, res, next) {
  if (process.env.HUD_MUTATION_AUTH === 'off') return next();
  const p = req.originalUrl.split('?')[0];
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (AUTH_ROUTES.has(p)) return next();
  if (!load()) {
    return res.status(503).json({ error: 'auth_not_configured', detail: `no users at ${authFile()}` });
  }
  const sess = session(req);
  if (!sess) {
    return res.status(401).json({ error: 'login_required', login: '/login' });
  }
  const need = requiredRole(p);
  if (ROLES[sess.role] < ROLES[need]) {
    return res.status(403).json({ error: 'insufficient_role', required: need, role: sess.role });
  }
  req.user = sess;
  return next();
}

function registerAuthRoutes(app) {
  app.post('/api/login', (req, res) => {
    if (process.env.HUD_MUTATION_AUTH === 'off') {
      return res.status(503).json({ error: 'auth_disabled', detail: 'HUD_MUTATION_AUTH=off' });
    }
    const ip = req.socket.remoteAddress || 'unknown';
    if (rateLimited(ip)) {
      return res.status(429).json({ error: 'too_many_login_attempts' });
    }
    const { user, password } = req.body || {};
    if (typeof user !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'user_and_password_required' });
    }
    const role = verify(user, password);
    if (!role) return res.status(401).json({ error: 'bad_credentials' });
    const token = makeToken(user, role);
    if (!token) return res.status(503).json({ error: 'auth_not_configured', detail: 'no secret in auth file' });
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL}`);
    return res.json({ user, role });
  });

  app.post('/api/logout', (req, res) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) revoke(token);
    res.setHeader('Set-Cookie', `${COOKIE}=deleted; Path=/; Max-Age=0`);
    return res.json({ ok: true });
  });

  app.get('/api/whoami', (req, res) => {
    const sess = session(req);
    if (!sess) return res.status(401).json({ error: 'anonymous' });
    return res.json(sess);
  });

  const LOGIN_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Office HUD login</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family:ui-monospace,monospace;background:#0b0e14;color:#d8dee9;display:flex;justify-content:center;padding-top:12vh">
<form id="f" style="display:flex;flex-direction:column;gap:10px;width:280px">
<h2 style="margin:0 0 6px;font-size:15px">OFFICE HUD — operator login</h2>
<input id="u" placeholder="user" autocomplete="username" style="padding:8px;background:#141922;color:#d8dee9;border:1px solid #2a3140;border-radius:4px">
<input id="p" type="password" placeholder="password" autocomplete="current-password" style="padding:8px;background:#141922;color:#d8dee9;border:1px solid #2a3140;border-radius:4px">
<button type="submit" style="padding:8px;background:#2a3140;color:#d8dee9;border:0;border-radius:4px;cursor:pointer">Login</button>
<div id="m" style="font-size:12px;color:#f0a"></div>
</form>
<script>
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: document.getElementById('u').value, password: document.getElementById('p').value }) });
  if (r.ok) { location.href = '/'; return; }
  const j = await r.json().catch(() => ({}));
  document.getElementById('m').textContent = j.error || ('login failed: ' + r.status);
});
</script></body></html>`;

  app.get('/login', (_req, res) => res.type('html').send(LOGIN_HTML));
}

module.exports = {
  ROLES, SESSION_TTL, COOKIE, AUTH_ROUTES,
  verify, makeToken, checkToken, revoke, session,
  requiredRole, mutationGate, registerAuthRoutes,
  internals: { parseCookies, hashPassword, authFile, b64url, unb64url, rateLimited },
};

// local proxy + planner server, zero dependencies, node 20+

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { login, fetchAll } from './classeviva.js';
import { generatePlan, buildWindow, MODEL } from './gemini.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 5173);

// minimal .env loader (or use: node --env-file=.env server.js)
if (existsSync(path.join(ROOT, '.env'))) {
  const txt = await readFile(path.join(ROOT, '.env'), 'utf8');
  for (const line of txt.split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// in-memory sessions only, no database, no credentials on disk
const SESSIONS = new Map();
const TTL = 1000 * 60 * 60 * 3;

setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of SESSIONS) if (now - s.touched > TTL) SESSIONS.delete(sid);
}, 60_000).unref();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

const json = (res, code, data) => {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) reject(new Error('payload troppo grande'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('JSON non valido'));
      }
    });
    req.on('error', reject);
  });

function sidOf(req) {
  const raw = req.headers.cookie || '';
  const m = /(?:^|;\s*)ripasso_sid=([^;]+)/.exec(raw);
  return m?.[1] || null;
}

function sessionOf(req) {
  const sid = sidOf(req);
  const s = sid ? SESSIONS.get(sid) : null;
  if (s) s.touched = Date.now();
  return s;
}

// routes

const routes = {
  'GET /api/session': async (req, res) => {
    const s = sessionOf(req);
    if (!s) return json(res, 200, { logged: false, model: MODEL, hasKey: !!process.env.GEMINI_API_KEY });
    json(res, 200, {
      logged: true,
      model: MODEL,
      hasKey: !!process.env.GEMINI_API_KEY,
      student: s.sync?.student || null,
      syncedAt: s.sync?.syncedAt || null,
      openedAt: new Date(s.cv.openedAt).toISOString(),
    });
  },

  'POST /api/login': async (req, res) => {
    const { uid, pwd, cid, pin } = await readBody(req);
    const cv = await login({
      uid: uid || process.env.CV_UID,
      pwd: pwd || process.env.CV_PWD,
      cid: cid || process.env.CV_CID || '',
      pin: pin || process.env.CV_PIN || '',
      target: process.env.CV_TARGET || 'studenti',
    });

    const sid = randomBytes(24).toString('base64url');
    const sess = { cv, sync: null, plan: null, touched: Date.now() };
    SESSIONS.set(sid, sess);

    sess.sync = await fetchAll(cv);
    cv.studentId = sess.sync.raw.whoami.id;

    res.setHeader(
      'set-cookie',
      `ripasso_sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${TTL / 1000}`
    );
    json(res, 200, { logged: true, student: sess.sync.student });
  },

  'POST /api/logout': async (req, res) => {
    const sid = sidOf(req);
    if (sid) SESSIONS.delete(sid);
    res.setHeader('set-cookie', 'ripasso_sid=; HttpOnly; Path=/; Max-Age=0');
    json(res, 200, { logged: false });
  },

  'GET /api/sync': async (req, res) => {
    const s = sessionOf(req);
    if (!s) return json(res, 401, { error: 'Non autenticato', code: 'NO_SESSION' });
    if (!s.sync) s.sync = await fetchAll(s.cv);
    json(res, 200, { ...s.sync, raw: undefined, window: buildWindow() });
  },

  'POST /api/sync': async (req, res) => {
    const s = sessionOf(req);
    if (!s) return json(res, 401, { error: 'Non autenticato', code: 'NO_SESSION' });
    s.sync = await fetchAll(s.cv);
    s.plan = null;
    json(res, 200, { ...s.sync, raw: undefined, window: buildWindow() });
  },

  'POST /api/plan': async (req, res) => {
    const s = sessionOf(req);
    if (!s) return json(res, 401, { error: 'Non autenticato', code: 'NO_SESSION' });
    if (!s.sync) s.sync = await fetchAll(s.cv);
    const out = await generatePlan(s.sync);
    s.plan = out;
    json(res, 200, out);
  },

  'GET /api/plan': async (req, res) => {
    const s = sessionOf(req);
    if (!s) return json(res, 401, { error: 'Non autenticato', code: 'NO_SESSION' });
    if (s.plan) return json(res, 200, s.plan);
    if (!s.sync) s.sync = await fetchAll(s.cv);
    const out = await generatePlan(s.sync);
    s.plan = out;
    json(res, 200, out);
  },
};

// static files

async function serveStatic(req, res, url) {
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'no' });
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}

// server

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const key = `${req.method} ${url.pathname}`;

    if (url.pathname.startsWith('/api/')) {
      const handler = routes[key];
      if (!handler) return json(res, 404, { error: 'Endpoint inesistente' });
      try {
        await handler(req, res);
      } catch (err) {
        const map = {
          AUTH_FAILED: 401,
          SESSION_EXPIRED: 401,
          NO_KEY: 500,
          BAD_KEY: 502,
          RATE_LIMIT: 429,
          MODEL_ERROR: 502,
        };
        console.error(`[${key}]`, err.code || '', err.message);
        json(res, err.status || map[err.code] || 500, {
          error: err.message || 'Errore interno',
          code: err.code || 'UNKNOWN',
        });
      }
      return;
    }
    await serveStatic(req, res, url);
  })
  .listen(PORT, () => {
    console.log(`Ripasso su http://localhost:${PORT}`);
    console.log(`modello: ${MODEL} - chiave Gemini: ${process.env.GEMINI_API_KEY ? 'ok' : 'MANCANTE'}`);
  });

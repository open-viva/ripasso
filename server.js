// local proxy + planner server, zero dependencies, node 20+

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { login, fetchAll } from './classeviva.js';
import { generatePlan, buildWindow, MODEL } from './gemini.js';
import { loadStore, saveStore } from './store.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 5173);

// settimana corrente (0) + questa costante di settimane successive: circa un
// mese di orizzonte navigabile, così ci si organizza in modo graduale.
const MAX_WEEK_OFFSET = 3;
const AVOID_DAYS = ['lun', 'mar', 'mer', 'gio', 'ven', 'sab', 'dom'];
const FASCE = ['mattina', 'pomeriggio', 'sera', 'indifferente'];

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

function clampOffset(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 0;
  return Math.min(MAX_WEEK_OFFSET, Math.max(0, n));
}

function priorWeekSummaries(store, beforeDate) {
  return Object.entries(store.plans || {})
    .filter(([date]) => date < beforeDate)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, entry]) => ({
      settimana: entry.plan?.week_label || '',
      totale_minuti: entry.plan?.totals?.minutes ?? null,
      per_materia: (entry.plan?.focus || []).map((f) => ({ materia: f.subject, minuti: f.minutes_week })),
    }));
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
    const sess = { cv, sync: null, store: null, touched: Date.now() };
    SESSIONS.set(sid, sess);

    sess.sync = await fetchAll(cv);
    cv.studentId = sess.sync.raw.whoami.id;
    sess.store = await loadStore(cv.studentId);

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
    json(res, 200, { ...s.sync, raw: undefined, window: buildWindow() });
  },

  'GET /api/preferences': async (req, res) => {
    const s = sessionOf(req);
    if (!s) return json(res, 401, { error: 'Non autenticato', code: 'NO_SESSION' });
    json(res, 200, s.store.preferences);
  },

  'POST /api/preferences': async (req, res) => {
    const s = sessionOf(req);
    if (!s) return json(res, 401, { error: 'Non autenticato', code: 'NO_SESSION' });
    const body = await readBody(req);
    const avoid_days = Array.isArray(body.avoid_days)
      ? body.avoid_days.filter((d) => AVOID_DAYS.includes(d))
      : s.store.preferences.avoid_days;
    const preferred_time = FASCE.includes(body.preferred_time) ? body.preferred_time : 'indifferente';
    const notes = typeof body.notes === 'string' ? body.notes.slice(0, 600) : '';
    s.store.preferences = { avoid_days, preferred_time, notes };
    await saveStore(s.cv.studentId, s.store);
    json(res, 200, s.store.preferences);
  },

  // elenco delle settimane navigabili (corrente + le successive), con lo
  // stato "già generato o no" letto dai piani salvati
  'GET /api/weeks': async (req, res) => {
    const s = sessionOf(req);
    if (!s) return json(res, 401, { error: 'Non autenticato', code: 'NO_SESSION' });
    const weeks = [];
    for (let offset = 0; offset <= MAX_WEEK_OFFSET; offset++) {
      const w = buildWindow(new Date(), offset);
      const entry = s.store.plans[w.from];
      weeks.push({
        offset,
        from: w.from,
        to: w.to,
        label: w.label,
        days: w.days,
        hasPlan: !!entry,
        generatedAt: entry?.meta?.generatedAt || null,
      });
    }
    json(res, 200, { weeks, maxOffset: MAX_WEEK_OFFSET });
  },

  // piano già salvato per una settimana: non lo genera, per non rifare mai
  // una chiamata al modello solo per leggere qualcosa che esiste già
  'GET /api/plan': async (req, res, url) => {
    const s = sessionOf(req);
    if (!s) return json(res, 401, { error: 'Non autenticato', code: 'NO_SESSION' });
    const offset = clampOffset(url.searchParams.get('offset'));
    const w = buildWindow(new Date(), offset);
    const entry = s.store.plans[w.from];
    if (!entry) return json(res, 200, { hasPlan: false, offset, window: w });
    json(res, 200, { hasPlan: true, offset, window: w, plan: entry.plan, meta: entry.meta });
  },

  // genera (o rigenera) il piano per una settimana specifica e lo salva su
  // disco: da qui in poi resta disponibile senza doverlo ricreare
  'POST /api/plan': async (req, res) => {
    const s = sessionOf(req);
    if (!s) return json(res, 401, { error: 'Non autenticato', code: 'NO_SESSION' });
    if (!s.sync) s.sync = await fetchAll(s.cv);
    const body = await readBody(req);
    const offset = clampOffset(body.offset);
    const w = buildWindow(new Date(), offset);
    const priorWeeks = priorWeekSummaries(s.store, w.from);
    const out = await generatePlan(s.sync, {
      weekOffset: offset,
      prefs: s.store.preferences,
      priorWeeks,
    });
    s.store.plans[w.from] = out;
    await saveStore(s.cv.studentId, s.store);
    json(res, 200, { hasPlan: true, offset, window: w, plan: out.plan, meta: out.meta });
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
        await handler(req, res, url);
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

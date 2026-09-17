const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const DOW = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
const MONTH = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];

let SYNC = null;
let PLAN = null;       // piano della settimana attiva: { plan, meta } | null
let PREFS = null;
let WEEKS = [];         // [{ offset, from, to, label, days, hasPlan, generatedAt }]
let ACTIVE_OFFSET = 0;
const PLANS = new Map(); // offset 
const tint = new Map(); // subjectId t0 t6 class

// icons (lucide via cdn, loaded once)
let iconsReady = null;
function icons() {
  iconsReady ??= new Promise((ok) => {
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/lucide@0.469.0/dist/umd/lucide.min.js';
    s.onload = ok;
    s.onerror = ok;
    document.head.append(s);
  });
  iconsReady.then(() => window.lucide?.createIcons());
}

// api
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Errore ${res.status}`), { code: data.code, status: res.status });
  return data;
}

//login
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#login-btn');
  const err = $('#login-err');
  err.hidden = true;
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>Apro la sessione e leggo 12 endpoint…';
  try {
    await api('POST', '/api/login', {
      uid: $('#uid').value.trim(),
      pwd: $('#pwd').value,
      cid: $('#cid').value.trim(),
      pin: $('#pin').value.trim(),
    });
    await boot();
  } catch (ex) {
    err.hidden = false;
    err.className = 'banner';
    err.innerHTML = `<div class="tx"><b>${esc(ex.message)}</b><p>${
      ex.code === 'AUTH_FAILED'
        ? 'Il codice utente inizia con S per gli studenti, G per i genitori. Se la scuola richiede il codice scuola, va compilato.'
        : 'Controlla che il server locale abbia rete verso web.spaggiari.eu.'
    }</p></div>`;
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="log-in" width="15" height="15"></i>Riprova';
    icons();
  }
});

$('#logout').addEventListener('click', async () => {
  await api('POST', '/api/logout');
  location.reload();
});

// boot
async function boot() {
  const s = await api('GET', '/api/session');
  $('#model-name').textContent = s.model;
  if (!s.hasKey) {
    $('#model-sub').textContent = 'GEMINI_API_KEY mancante: il piano non può essere generato.';
  }
  if (!s.logged) {
    $('#gate').hidden = false;
    $('#app').hidden = true;
    icons();
    return;
  }
  $('#gate').hidden = true;
  $('#app').hidden = false;
  await Promise.all([loadWeeks(), loadPrefs()]);
  await loadSync();
  await loadPlanForActive();
  icons();
}

async function loadSync(force = false) {
  $('#who-sync').textContent = 'lettura in corso';
  $('#who-dot').className = 'dot warn';
  SYNC = await api(force ? 'POST' : 'GET', '/api/sync');
  render();
}

// settimane navigabili

async function loadWeeks() {
  const res = await api('GET', '/api/weeks');
  WEEKS = res.weeks;
  renderWeekTabs();
}

function weekLabelFor(w) {
  if (w.offset === 0) return 'Questa settimana';
  if (w.offset === 1) return 'Settimana prossima';
  return w.label;
}

function renderWeekTabs() {
  $('#weektabs').innerHTML = WEEKS.map(
    (w) => `<button data-off="${w.offset}" aria-current="${w.offset === ACTIVE_OFFSET}">
      ${w.hasPlan ? '<span class="dot"></span>' : ''}${esc(weekLabelFor(w))}
    </button>`
  ).join('');
}

$('#weektabs').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-off]');
  if (!b || b.getAttribute('aria-current') === 'true') return;
  ACTIVE_OFFSET = Number(b.dataset.off);
  renderWeekTabs();
  await loadPlanForActive();
});

function updateWeekHeader(w) {
  if (!w) return;
  $('#week-label').textContent = w.label;
  if (!SYNC) return;
  const inWeek = SYNC.derived.tasks.filter((t) => t.date >= w.from && t.date <= w.to);
  const tests = inWeek.filter((t) => t.kind === 'verifica').length;
  const hw = inWeek.filter((t) => t.kind === 'compito').length;
  $('#week-sub').innerHTML = inWeek.length
    ? `In questi sette giorni: <b>${tests} verifiche</b> e <b>${hw} consegne</b>. Il piano parte da qui, dalle medie e dagli argomenti firmati dai docenti.`
    : 'Nessuna scadenza in questi sette giorni. Il piano lavora sul recupero graduale delle materie con media più bassa.';
}

async function loadPlanForActive() {
  const w = WEEKS.find((x) => x.offset === ACTIVE_OFFSET);
  updateWeekHeader(w);
  if (PLANS.has(ACTIVE_OFFSET)) {
    PLAN = PLANS.get(ACTIVE_OFFSET);
    PLAN ? renderPlan() : renderPlanShell(w);
    return;
  }
  const res = await api('GET', `/api/plan?offset=${ACTIVE_OFFSET}`);
  PLAN = res.hasPlan ? { plan: res.plan, meta: res.meta } : null;
  PLANS.set(ACTIVE_OFFSET, PLAN);
  PLAN ? renderPlan() : renderPlanShell(w);
}

// preferenze di studio

async function loadPrefs() {
  PREFS = await api('GET', '/api/preferences');
  fillPrefsForm();
}

function fillPrefsForm() {
  document.querySelectorAll('#pref-days button').forEach((b) => {
    b.setAttribute('aria-pressed', String((PREFS.avoid_days || []).includes(b.dataset.day)));
  });
  $('#pref-time').value = PREFS.preferred_time || 'indifferente';
  $('#pref-notes').value = PREFS.notes || '';
}

$('#pref-days').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-day]');
  if (!b) return;
  b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
});

$('#pref-save').addEventListener('click', async () => {
  const avoid_days = [...document.querySelectorAll('#pref-days button[aria-pressed="true"]')].map((b) => b.dataset.day);
  const btn = $('#pref-save');
  btn.disabled = true;
  try {
    PREFS = await api('POST', '/api/preferences', {
      avoid_days,
      preferred_time: $('#pref-time').value,
      notes: $('#pref-notes').value,
    });
    $('#pref-saved').hidden = false;
    setTimeout(() => { $('#pref-saved').hidden = true; }, 1800);
  } catch (ex) {
    alert(ex.message);
  }
  btn.disabled = false;
});

// render

function render() {
  const { student, derived, sources, window: win } = SYNC;

  $('#who-name').textContent = `${student.firstName} ${student.lastName}`.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase());
  $('#who-class').textContent = `${student.classDesc} · ${student.year}`;
  const bad = sources.filter((x) => x.status === 'error').length;
  $('#who-dot').className = 'dot' + (bad ? ' bad' : '');
  $('#who-sync').textContent = bad ? `${bad} sorgenti in errore` : `sincronizzato ${hhmm(SYNC.syncedAt)}`;

  derived.subjects.forEach((s, i) => tint.set(s.subjectId, 't' + (i % 7)));

  $('#c-piano').textContent = '7g';
  $('#c-compiti').textContent = derived.tasks.filter((t) => t.date >= SYNC.today).length || '';
  $('#c-materie').textContent = derived.subjects.filter((s) => s.count).length || '';
  $('#c-bacheca').textContent = derived.notices.filter((n) => !n.read).length || '';

  const activeWeek = WEEKS.find((w) => w.offset === ACTIVE_OFFSET);
  updateWeekHeader(activeWeek || win);
  PLAN = PLANS.get(ACTIVE_OFFSET) || null;
  PLAN ? renderPlan() : renderPlanShell(activeWeek || win);

  renderTasks();
  renderSubjects();
  renderNotices();
  renderSources();
  icons();
}

const hhmm = (isoStr) => {
  const d = new Date(isoStr);
  return isNaN(d) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// weekly plan

function renderPlanShell(w) {
  if (PLAN) return renderPlan();
  $('#plan').innerHTML = '';
  const period = w ? `per ${w.label}` : '';
  $('#plan-msg').innerHTML = `<div class="empty">
    <b>Piano non ancora generato</b>
    <p>I dati del registro sono caricati. Premi genera: il modello riceve medie, scadenze e argomenti delle lezioni ${esc(period)}, senza i tuoi dati personali. Una volta generato resta salvato, non serve rifarlo ogni volta.</p>
    <button class="btn" data-go="regen"><i data-lucide="sparkles" width="15" height="15"></i>Genera il piano</button>
  </div>`;
  $('#plan-msg').querySelector('[data-go]').addEventListener('click', () => $('#regen').click());
  $('#gen-at').textContent = '';
  icons();
}

function deadlinesFor(date) {
  // deadlines are facts from the register, not model output
  return SYNC.derived.tasks
    .filter((t) => t.date === date && t.kind !== 'evento')
    .map((t) => {
      const kind = t.kind === 'verifica' ? 'Verifica' : 'Consegna';
      const at = t.startAt && !t.fullDay ? ` · ${t.startAt.slice(11, 16)}` : '';
      return `<div class="deadline ${t.kind === 'compito' ? 'hw' : ''} ${t.certain ? '' : 'guess'}">
        <i data-lucide="${t.kind === 'verifica' ? 'alert-circle' : 'inbox'}" width="15" height="15"></i>
        <div><div class="k">${kind}${at}${t.certain ? '' : ' · dedotta'}</div>
        <div class="v">${esc(t.subject || t.text.slice(0, 34) || 'senza materia')}</div></div></div>`;
    })
    .join('');
}

function renderPlan() {
  const p = PLAN.plan;
  $('#week-label').textContent = p.week_label;
  $('#gen-at').textContent = `generato ${hhmm(PLAN.meta.generatedAt)} · ${Math.round(p.totals.minutes / 6) / 10}h`;

  const stale = SYNC?.syncedAt && PLAN.meta.generatedAt && new Date(SYNC.syncedAt) > new Date(PLAN.meta.generatedAt);
  $('#plan-msg').innerHTML = stale
    ? `<div class="weekflag"><i data-lucide="info" width="14" height="14"></i>Il registro è stato risincronizzato dopo la generazione di questo piano: se sono cambiate scadenze o voti, rigeneralo.</div>`
    : '';

  $('#plan').innerHTML = p.days
    .map((d, i) => {
      const dt = new Date(d.date);
      const today = d.date === SYNC.today;
      const blocks = d.blocks
        .map(
          (b) => `<button class="block ${tint.get(b.subject_id) || 't6'}" style="--min:${b.minutes}" aria-expanded="false">
        <div class="bh"><span class="sub">${esc(b.subject)}</span><span class="dur">${b.minutes}′${b.fascia ? ` · ${esc(b.fascia)}` : ''}</span></div>
        <p class="note">${esc(b.topic)}</p>
        ${b.ref ? `<span class="tag">${esc(b.ref)}</span>` : ''}
        <div class="why">${esc(b.reason)}<span class="src">${esc(b.sources.join(' · '))}</span></div>
      </button>`
        )
        .join('');
      const dl = deadlinesFor(d.date);
      const empty = !blocks && !dl ? `<div class="free"><i data-lucide="coffee" width="15" height="15"></i>Giornata libera</div>` : '';
      return `<div class="row ${today ? 'today' : ''}" style="--i:${i}">
        <div class="date"><span class="dow">${DOW[dt.getDay()]}</span><span class="num">${dt.getDate()}</span>${today ? '<span class="oggi">oggi</span>' : ''}</div>
        <div class="slots">${dl}${blocks}${empty}</div></div>`;
    })
    .join('');

  $('#rules-wrap').hidden = !p.rules_applied.length;
  $('#rules-count').textContent = `${p.rules_applied.length} criteri`;
  $('#rules').innerHTML = p.rules_applied
    .map(
      (r, i) => `<div class="why-item"><span class="n">${String(i + 1).padStart(2, '0')}</span>
      <p><b>${esc(r.criterion)}.</b> ${esc(r.detail)}</p>
      <span class="from">${esc((r.sources || []).join(' · '))}</span></div>`
    )
    .join('');

  renderSubjects(); // weekly minutes come from the plan
  renderModelMeter();
  icons();
}

$('#regen').addEventListener('click', async () => {
  const btn = $('#regen');
  const w = WEEKS.find((x) => x.offset === ACTIVE_OFFSET);
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>Il modello pianifica…';
  $('#plan-msg').innerHTML = '';
  const widths = [260, 200, 300, 210, 240, 270, 190];
  $('#plan').innerHTML = (w?.days || SYNC.window.days)
    .map((date, i) => {
      const dt = new Date(date);
      return `<div class="row"><div class="date"><span class="dow">${DOW[dt.getDay()]}</span><span class="num">${dt.getDate()}</span></div>
      <div class="slots"><div class="sk" style="--w:${widths[i]}px"><span></span><span></span><span></span></div></div></div>`;
    })
    .join('');
  try {
    const res = await api('POST', '/api/plan', { offset: ACTIVE_OFFSET });
    PLAN = { plan: res.plan, meta: res.meta };
    PLANS.set(ACTIVE_OFFSET, PLAN);
    if (w) { w.hasPlan = true; w.generatedAt = res.meta.generatedAt; }
    renderWeekTabs();
    renderPlan();
  } catch (ex) {
    $('#plan').innerHTML = '';
    const help = {
      NO_KEY: 'Metti GEMINI_API_KEY nel file .env e riavvia il server.',
      BAD_KEY: 'La chiave è rifiutata: controllala su AI Studio.',
      RATE_LIMIT: 'Quota esaurita per ora. Il piano precedente resta valido.',
      SESSION_EXPIRED: 'La sessione ClasseViva è scaduta: rifai il login.',
    }[ex.code] || 'Il modello non ha risposto in tempo. Riprova.';
    $('#plan-msg').innerHTML = `<div class="banner"><i data-lucide="triangle-alert" width="18" height="18" style="color:var(--accent-deep)"></i>
      <div class="tx"><b>${esc(ex.message)}</b><p>${esc(help)}</p></div></div>`;
  }
  btn.disabled = false;
  btn.innerHTML = '<i data-lucide="sparkles" width="15" height="15"></i>' + (PLAN ? 'Rigenera' : 'Genera piano');
  icons();
});

$('#plan').addEventListener('click', (e) => {
  const b = e.target.closest('.block');
  if (!b) return;
  const open = b.getAttribute('aria-expanded') === 'true';
  b.parentElement.querySelectorAll('.block').forEach((x) => x.setAttribute('aria-expanded', 'false'));
  b.setAttribute('aria-expanded', String(!open));
});

// homework: two-source list

function renderTasks() {
  const list = SYNC.derived.tasks.filter((t) => t.date >= SYNC.today).slice(0, 60);
  $('#task-count').textContent = `${list.length} in arrivo`;

  if (!list.length) {
    $('#tasks').innerHTML = `<div class="empty"><b>Agenda vuota</b>
      <p>Né <span class="mono">agendav2</span> né <span class="mono">homeworks/index</span> hanno voci future. Se i tuoi docenti li scrivono altrove, la sorgente si vede nella scheda Sorgenti.</p></div>`;
    return;
  }

  $('#tasks').innerHTML = list
    .map((t) => {
      const dt = new Date(t.date);
      const both = t.sources.length > 1;
      const badge = both
        ? '<i class="badge both">doppio</i>'
        : t.sources[0] === 'homeworks'
        ? '<i class="badge homeworks">compiti</i>'
        : '<i class="badge agenda">agenda</i>';
      return `<div class="task">
        <div class="day"><b>${dt.getDate()} ${MONTH[dt.getMonth()]}</b>${DOW[dt.getDay()]}</div>
        <div class="what">
          <div class="mat">${esc(t.subject || 'materia non indicata')}</div>
          <p class="txt">${esc(t.text || '—')}</p>
          ${t.author ? `<div class="prof">${esc(t.author)}</div>` : ''}
        </div>
        <div class="badges">
          ${t.kind === 'verifica' ? '<i class="badge verifica">verifica</i>' : t.kind === 'compito' ? '<i class="badge">compito</i>' : '<i class="badge">evento</i>'}
          ${t.certain ? '' : '<i class="badge guess">dedotto</i>'}
          ${badge}
        </div></div>`;
    })
    .join('');
}

// subjects

function sparkline(grades) {
  if (grades.length < 2) return '<span style="color:var(--ink-3); font-size:.8125rem">pochi voti</span>';
  const g = grades.slice(-8).map((x) => x.value);
  const w = 76, h = 22, min = 4, max = 10;
  const pts = g.map((v, i) => [i * (w / (g.length - 1)), h - ((Math.max(min, Math.min(max, v)) - min) / (max - min)) * h]);
  const trend = g.at(-1) - g[0];
  const col = trend < -0.3 ? 'var(--accent)' : trend > 0.3 ? 'var(--olive)' : 'var(--ink-3)';
  const six = h - ((6 - min) / (max - min)) * h;
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
    <line x1="0" y1="${six}" x2="${w}" y2="${six}" stroke="var(--rule-2)" stroke-dasharray="2 3"/>
    <polyline points="${pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')}" fill="none" stroke="${col}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${pts.at(-1)[0].toFixed(1)}" cy="${pts.at(-1)[1].toFixed(1)}" r="2.4" fill="${col}"/></svg>`;
}

function renderSubjects() {
  const focus = new Map((PLAN?.plan.focus || []).map((f) => [f.subject_id, f]));
  const rows = SYNC.derived.subjects;
  $('#c-materie').textContent = rows.filter((r) => r.count).length;
  $('#mat-period').textContent = rows.reduce((s, r) => s + r.count, 0) + ' voti';

  $('#mat-body').innerHTML = rows
    .map((r) => {
      const f = focus.get(r.subjectId);
      const cls = r.average == null ? '' : r.average < 6 ? 'bad' : r.average < 6.6 ? 'mid' : 'ok';
      const last = r.lastGrade;
      return `<tr>
        <td><div class="mat">${esc(r.subject)}</div><div class="prof">${esc(r.teachers.slice(0, 2).join(', '))}</div></td>
        <td><span class="media ${cls}">${r.average == null ? '—' : r.average.toFixed(1)}</span></td>
        <td class="hide-s">${sparkline(r.grades)}</td>
        <td class="hide-s"><span class="ore">${last ? `${new Date(last.date).getDate()} ${MONTH[new Date(last.date).getMonth()]} · ${esc(last.display)}` : '—'}</span></td>
        <td class="r"><span class="ore">${f?.minutes_week ? f.minutes_week + '′' : '—'}</span></td>
        <td class="r">${f ? `<span class="pill ${f.risk}" title="${esc(f.note)}">${f.risk}</span>` : '<span class="pill">—</span>'}</td>
      </tr>`;
    })
    .join('');
}

// noticeboard

function renderNotices() {
  const n = SYNC.derived.notices;
  const act = n.filter((x) => x.needs.join || x.needs.file || x.needs.sign || x.needs.reply);
  const rest = n.filter((x) => !act.includes(x)).slice(0, 12);
  $('#notice-count').textContent = `${act.length} con azione · ${n.length} totali`;

  const card = (x) => `<article class="notice ${x.read ? '' : 'unread'}">
    <div class="when">${x.date ? new Date(x.date).getDate() + ' ' + MONTH[new Date(x.date).getMonth()] : '—'}<span class="cat">${esc(x.category || x.evtCode)}</span></div>
    <div>
      <h3>${esc(x.title)}</h3>
      ${x.validTo ? `<p class="body">Valida fino al ${esc(x.validTo)}.</p>` : ''}
      <div class="badges" style="justify-content:flex-start; margin-top:10px">
        ${x.needs.join ? '<i class="badge guess">adesione</i>' : ''}
        ${x.needs.sign ? '<i class="badge guess">firma</i>' : ''}
        ${x.needs.file ? '<i class="badge guess">file</i>' : ''}
        ${x.needs.reply ? '<i class="badge guess">risposta</i>' : ''}
        ${x.attachments.length ? `<i class="badge">${x.attachments.length} allegati</i>` : ''}
      </div>
    </div></article>`;

  $('#notices').innerHTML = act.length || rest.length
    ? act.map(card).join('') + rest.map(card).join('')
    : `<div class="empty"><b>Bacheca vuota</b><p>L'endpoint noticeboard non ha restituito voci attive.</p></div>`;
}

// data sources

const FEEDS = {
  whoami: 'Identità e anno scolastico',
  subjects: 'Materie e docenti',
  grades: 'Medie e priorità',
  agenda: 'Verifiche ed eventi',
  homeworks: 'Compiti assegnati',
  lessons: 'Argomenti e carico orario',
  absences: 'Lezioni da recuperare',
  noticeboard: 'Scadenze dalle circolari',
  didactics: 'Materiali dei docenti',
  schoolbooks: 'Riferimenti ai libri',
  notes: 'Note disciplinari',
  minister: 'Comunicazioni MIM',
};

function renderSources() {
  $('#ep-body').innerHTML = SYNC.sources
    .map((s) => {
      const path = esc(s.path).replace(/\b(\d{6,})\b/g, '<span class="var">{id}</span>');
      const label = s.status === 'ok' ? 'attivo' : s.status === 'empty' ? 'vuoto' : 'errore';
      const dot = s.status === 'ok' ? 'dot' : s.status === 'empty' ? 'dot warn' : 'dot bad';
      return `<tr>
        <td><div class="ep">${path}</div>${s.error ? `<div class="prof">${esc(s.error)}</div>` : ''}</td>
        <td class="hide-s" style="font-size:.875rem; color:var(--ink-2)">${esc(FEEDS[s.key] || '')}</td>
        <td class="r"><span class="ore">${s.count}</span></td>
        <td class="r"><span class="st ${s.status}"><span class="${dot}"></span>${label}</span></td>
      </tr>`;
    })
    .join('');
  renderModelMeter();
}

function renderModelMeter() {
  const m = PLAN?.meta;
  $('#model-meter').innerHTML = m
    ? `<div><dt>Modello</dt><dd>${esc(m.model)}</dd></div>
       <div><dt>Contesto inviato</dt><dd>${(m.contextBytes / 1024).toFixed(1)} KB</dd></div>
       <div><dt>Token in / out</dt><dd>${m.inputTokens ?? '?'} / ${m.outputTokens ?? '?'}</dd></div>
       <div><dt>Latenza</dt><dd>${(m.latencyMs / 1000).toFixed(1)} s</dd></div>
       <div><dt>Generato</dt><dd>${hhmm(m.generatedAt)}</dd></div>`
    : `<div><dt>Stato</dt><dd>nessuna chiamata</dd></div>`;
}

$('#resync').addEventListener('click', async (e) => {
  const b = e.currentTarget;
  b.disabled = true;
  b.innerHTML = '<span class="spin"></span>Rileggo gli endpoint…';
  try {
    await loadSync(true);
  } catch (ex) {
    alert(ex.message);
  }
  b.disabled = false;
  b.innerHTML = '<i data-lucide="refresh-cw" width="15" height="15"></i>Risincronizza';
  icons();
});

// navigation

$('#nav').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-v]');
  if (!b) return;
  document.querySelectorAll('#nav button').forEach((x) => x.setAttribute('aria-current', String(x === b)));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('on', v.id === 'v-' + b.dataset.v));
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

boot().catch((ex) => {
  document.body.innerHTML = `<div class="gate"><div><h1>Server non raggiungibile</h1><p class="say">${esc(ex.message)}. Avvia <span class="mono">node server.js</span> e ricarica.</p></div></div>`;
});

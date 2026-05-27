'use strict';
const express = require('express');
const session = require('express-session');
const fetch   = require('node-fetch');
const cron    = require('node-cron');
const crypto  = require('crypto');
const path    = require('path');

// ─────────────────────────────────────────────
// CONFIG  (set these as Railway env variables)
// ─────────────────────────────────────────────
const PORT          = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const ADMIN_KEY     = process.env.ADMIN_KEY || 'mude-esta-chave';   // used by the bookmarklet

// Users who can view the dashboard: "user1:pass1,user2:pass2"
const USERS = Object.fromEntries(
  (process.env.USERS || 'vinicius:senha123')
    .split(',')
    .map(pair => pair.trim().split(':'))
);

// ─────────────────────────────────────────────
// TICKETMASTER EVENTS
// ─────────────────────────────────────────────
// 36 eventos Primeira Classe Rock in Rio - verificados via API /api/v2/events (mai/2026)
const EVENT_IDS = [
  '14136','14137','14138','14139','14140','14141','14142','14143',
  '14144','14145','14146','14147','14148','14149','14150','14152',
  '14153','14155','14156','14157','14158','14159','14160','14161',
  '14162','14163','14164','14165','14166','14174','14181','14182',
  '14183','14184','14185','14187'
];
const EVENT_NAMES = [
  'Botafogo Praia Shopping','Shopping Rio Sul','Copacabana','Copacabana - Posto 5',
  'Ipanema','Mix Rio FM - Bossa Nova Mall','RIO Galeão','Rio Design Barra',
  'Norte Shopping','Nova América','Recreio Shopping','Carioca Shopping',
  'Tijuca','Niterói - São Francisco','Niterói Plaza Shopping','Lagoa',
  'Shopping Nova Iguaçú','West Shopping','Petrópolis','Búzios',
  'Cabo Frio','Campinas','Piracicaba','Sorocaba',
  'Belo Horizonte','Poços de Caldas','Itajubá','Campos dos Goytacazes',
  'Macaé','Nova Friburgo','Resende','Barra Mansa',
  'Volta Redonda','Piraí','São Gonçalo Shopping','Shopping Eldorado - São Paulo'
];

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
let state = {
  token: null,          // "Bearer eyJ..."
  tokenSetAt: null,     // Date when token was synced
  data: null,           // Aggregated dashboard data
  lastRefresh: null,    // Date of last successful data fetch
  refreshing: false,
  error: null
};

// ─────────────────────────────────────────────
// TICKETMASTER API HELPERS
// ─────────────────────────────────────────────
const TM_BASE = 'https://api.boletius.com';

// Fetch with automatic timeout + abort
function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: ctrl.signal })
    .finally(() => clearTimeout(timer));
}

async function fetchIndicators(eventId, token) {
  const res = await fetchWithTimeout(`${TM_BASE}/eventConsoleWs/indicators/${eventId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': token
    },
    body: JSON.stringify({
      indicators: [
        { indicator: 'SALES_INDICATORS', parameters: { from: 'now-2y' } },
        { indicator: 'SALES_BY_PAYMENT_METHODS', parameters: { from: 'now-2y', to: 'now' } }
      ]
    })
  });
  if (!res.ok) throw new Error(`indicators ${eventId}: HTTP ${res.status}`);
  return res.json();
}

async function fetchCalendar(eventId, token) {
  const res = await fetchWithTimeout(
    `${TM_BASE}/reportWs/calendarSectorReport/${eventId}?type=calendarSector&month=2026-09&eventId=${eventId}`,
    { headers: { 'Authorization': token } }
  );
  if (!res.ok) throw new Error(`calendar ${eventId}: HTTP ${res.status}`);
  return res.json();
}

// Run promises in parallel with a concurrency limit
async function pool(tasks, concurrency = 6) {
  const results = new Array(tasks.length);
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      try { results[i] = { ok: true, value: await tasks[i]() }; }
      catch (e) { results[i] = { ok: false, error: e.message }; }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ─────────────────────────────────────────────
// DATA AGGREGATION
// ─────────────────────────────────────────────
function aggregateData(eventResults, calendarResults) {
  const FESTIVAL_DATES = ['2026-09-04','2026-09-05','2026-09-06','2026-09-07',
                          '2026-09-11','2026-09-12','2026-09-13'];
  const DATE_LABELS    = ['Sex 04/Set','Sáb 05/Set','Dom 06/Set','Seg 07/Set',
                          'Qui 11/Set','Sex 12/Set','Sáb 13/Set'];

  const events   = [];
  const rawShows = [];
  const byDate   = {};
  const byTime   = {};
  const heatmap  = {};
  FESTIVAL_DATES.forEach(d => { byDate[d] = 0; });

  EVENT_IDS.forEach((id, i) => {
    const name = EVENT_NAMES[i];
    const evRes = eventResults[i];
    const calRes = calendarResults[i];

    // Parse indicators
    // API statuses: APPROVED (confirmed sales), RESERVED (held/pending), PENDING_VERIFICATION, CANCELLED (if any)
    let sold = 0, revenue = 0, purchases = 0, creditCard = 0, pix = 0;
    let reserved = 0, reservedRevenue = 0, cancelled = 0, cancelledRevenue = 0;
    if (evRes.ok && evRes.value?.indicators) {
      for (const ind of evRes.value.indicators) {
        if (ind.indicator === 'SALES_INDICATORS' && ind.value?.status) {
          const s = ind.value.status;
          // APPROVED: confirmed, paid orders
          if (s.APPROVED) {
            sold      = s.APPROVED.primaryQuantity || 0;
            revenue   = s.APPROVED.primaryAmount   || 0;
            purchases = s.APPROVED.purchases       || 0;
          }
          // RESERVED: held/reserved orders (may be completed or cancelled)
          if (s.RESERVED) {
            reserved        = s.RESERVED.primaryQuantity || 0;
            reservedRevenue = s.RESERVED.primaryAmount   || 0;
          }
          // CANCELLED or REFUNDED: cancelled orders
          if (s.CANCELLED) {
            cancelled        = s.CANCELLED.primaryQuantity || 0;
            cancelledRevenue = s.CANCELLED.primaryAmount   || 0;
          }
          if (s.REFUNDED) {
            cancelled        += s.REFUNDED.primaryQuantity || 0;
            cancelledRevenue += s.REFUNDED.primaryAmount   || 0;
          }
        }
        if (ind.indicator === 'SALES_BY_PAYMENT_METHODS' && ind.value?.paymentTypes) {
          const pt = ind.value.paymentTypes;
          creditCard = pt.CREDIT_CARD?.primaryQuantity || 0;
          pix        = pt.PIX?.primaryQuantity         || 0;
        }
      }
    }

    // Parse calendar (show-level data)
    // API response: { report: [ { date: '2026-09-04T12:00', tks, subTotal, totalServiceCharge, sector } ] }
    const showCount = { count: 0 };
    heatmap[name] = {};
    if (calRes.ok && calRes.value) {
      const calData = Array.isArray(calRes.value) ? calRes.value
                    : (calRes.value.report || calRes.value.data || []);
      for (const show of calData) {
        const date    = (show.date || show.showDate || '').substring(0, 10);
        const time    = (show.date || show.showTime || show.time || '').substring(11, 16);
        const tickets = show.tks || show.ticketsSold || show.sold || show.quantity || 0;
        const sub     = show.subTotal || show.subtotal || show.revenue || (tickets * 220);
        const tax     = show.totalServiceCharge || show.serviceCharge || show.tax || (sub * 0.1);
        if (!tickets) continue;

        rawShows.push({ evId: id, local: name, date, time, tks: tickets, subtotal: sub, taxa: tax });
        showCount.count++;

        if (FESTIVAL_DATES.includes(date)) {
          byDate[date] = (byDate[date] || 0) + tickets;
          heatmap[name][date] = (heatmap[name][date] || 0) + tickets;
        }
        const timeKey = time.substring(0, 5);
        if (timeKey) byTime[timeKey] = (byTime[timeKey] || 0) + tickets;
      }
    }

    events.push({ id, name, sold, revenue, purchases, creditCard, pix, shows: showCount.count,
                  reserved, reservedRevenue, cancelled, cancelledRevenue });
  });

  // Build sorted by-time array
  const byTimeArr = Object.entries(byTime)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([time, tks]) => ({ time, tks }));

  const byDateArr = FESTIVAL_DATES.map((date, i) => ({
    date, label: DATE_LABELS[i], tks: byDate[date] || 0
  }));

  return { events, rawShows, byDate: byDateArr, byTime: byTimeArr, heatmap,
           totalSold:            events.reduce((s, e) => s + e.sold, 0),
           totalRevenue:         events.reduce((s, e) => s + e.revenue, 0),
           totalReserved:        events.reduce((s, e) => s + e.reserved, 0),
           totalReservedRevenue: events.reduce((s, e) => s + e.reservedRevenue, 0),
           totalCancelled:       events.reduce((s, e) => s + e.cancelled, 0),
           totalCancelledRevenue:events.reduce((s, e) => s + e.cancelledRevenue, 0) };
}

// ─────────────────────────────────────────────
// DATA REFRESH
// ─────────────────────────────────────────────
async function refreshData() {
  if (!state.token) { state.error = 'Token não configurado. Use o bookmarklet para sincronizar.'; return; }
  if (state.refreshing) return;
  state.refreshing = true;
  state.error = null;
  console.log(`[${new Date().toISOString()}] Iniciando refresh de dados...`);

  // Global safety timeout: abort entire refresh after 3 minutes
  const globalTimeout = setTimeout(() => {
    if (state.refreshing) {
      state.refreshing = false;
      state.error = 'Timeout: refresh demorou mais de 3 minutos. Token pode ter expirado — use o bookmarklet para sincronizar.';
      console.error('[refresh timeout] Abortado após 3 minutos.');
    }
  }, 3 * 60 * 1000);

  try {
    const indicatorTasks  = EVENT_IDS.map(id => () => fetchIndicators(id, state.token));
    const calendarTasks   = EVENT_IDS.map(id => () => fetchCalendar(id, state.token));

    const [eventResults, calendarResults] = await Promise.all([
      pool(indicatorTasks, 6),
      pool(calendarTasks, 6)
    ]);

    // Detect widespread auth failures (token provavelmente expirado)
    const failures = eventResults.filter(r => !r.ok);
    if (failures.length > EVENT_IDS.length * 0.5) {
      const sample = failures[0]?.error || '';
      state.error = `Token expirado ou inválido (${failures.length}/${EVENT_IDS.length} eventos falharam: ${sample}). Use o bookmarklet para sincronizar.`;
      console.error('[refresh]', state.error);
      return;
    }

    state.data        = aggregateData(eventResults, calendarResults);
    state.lastRefresh = new Date();
    console.log(`[${new Date().toISOString()}] Dados atualizados. Total vendido: ${state.data.totalSold} ingressos`);
  } catch (err) {
    state.error = err.message;
    console.error('[refresh error]', err.message);
  } finally {
    state.refreshing = false;
    clearTimeout(globalTimeout);
  }
}

// Auto-refresh every 5 minutes
cron.schedule('*/5 * * * *', () => {
  if (state.token) refreshData();
});

// ─────────────────────────────────────────────
// EXPRESS APP
// ─────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Serve static JS files (dashboard.js) — no auth required since no secrets in JS
app.use('/js', express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 } // 8h session
}));

// ── Auth middleware ──────────────────────────
function requireAuth(req, res, next) {
  if (req.session.user) return next();
  res.redirect('/login');
}

// ── Login page ──────────────────────────────
app.get('/login', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashboard Rock in Rio — Login</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0a0c10;color:#e8eaf0;font-family:'Segoe UI',system-ui,sans-serif;
       min-height:100vh;display:flex;align-items:center;justify-content:center}
  .card{background:#131720;border:1px solid #252d3d;border-radius:16px;padding:40px;width:100%;max-width:380px}
  .badge{background:#e63946;color:#fff;font-size:10px;font-weight:800;letter-spacing:2px;
         text-transform:uppercase;padding:5px 10px;border-radius:4px;display:inline-block;margin-bottom:16px}
  h1{font-size:20px;font-weight:700;margin-bottom:4px}
  p{font-size:13px;color:#7a8499;margin-bottom:28px}
  label{font-size:12px;font-weight:600;letter-spacing:0.5px;color:#7a8499;text-transform:uppercase;display:block;margin-bottom:6px}
  input{width:100%;background:#0a0c10;border:1px solid #252d3d;border-radius:8px;padding:12px 14px;
        color:#e8eaf0;font-size:14px;margin-bottom:16px;outline:none;transition:.2s}
  input:focus{border-color:#e63946}
  .btn{width:100%;background:#e63946;color:#fff;border:none;border-radius:8px;padding:13px;
       font-size:14px;font-weight:700;cursor:pointer;transition:.2s}
  .btn:hover{background:#c62d3a}
  .err{background:#3d1515;border:1px solid #e63946;border-radius:8px;padding:12px 14px;
       font-size:13px;color:#ff8a8a;margin-bottom:16px}
</style>
</head>
<body>
<div class="card">
  <div class="badge">Rock in Rio 2026</div>
  <h1>Primeira Classe</h1>
  <p>Dashboard de Vendas — Acesso Restrito</p>
  ${req.query.error ? '<div class="err">Usuário ou senha incorretos.</div>' : ''}
  <form method="POST" action="/login">
    <label>Usuário</label>
    <input name="username" type="text" autocomplete="username" required autofocus>
    <label>Senha</label>
    <input name="password" type="password" autocomplete="current-password" required>
    <button class="btn" type="submit">Entrar</button>
  </form>
</div>
</body></html>`);
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (USERS[username] && USERS[username] === password) {
    req.session.user = username;
    return res.redirect('/');
  }
  res.redirect('/login?error=1');
});

app.post('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// ── Admin: sync token from bookmarklet ──────
// CORS headers helper for sync-token (allows calls from any origin, e.g. Ticketmaster dashboard)
function corsForSyncToken(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

app.options('/admin/sync-token', (req, res) => {
  corsForSyncToken(req, res);
  res.sendStatus(204);
});

app.post('/admin/sync-token', (req, res) => {
  corsForSyncToken(req, res);
  const { token, adminKey } = req.body;
  if (adminKey !== ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  if (!token) return res.status(400).json({ error: 'Token required' });

  const bearer = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
  state.token      = bearer;
  state.tokenSetAt = new Date();
  console.log(`[${new Date().toISOString()}] Token sincronizado via bookmarklet.`);

  // Trigger immediate refresh
  refreshData();
  res.json({ ok: true, message: 'Token sincronizado! Dados sendo atualizados...' });
});

// ── API: data endpoint ───────────────────────
app.get('/api/data', requireAuth, (req, res) => {
  res.json({
    data: state.data,
    lastRefresh: state.lastRefresh,
    tokenSetAt: state.tokenSetAt,
    refreshing: state.refreshing,
    error: state.error,
    tokenExpiry: state.tokenSetAt
      ? new Date(state.tokenSetAt.getTime() + 12 * 60 * 60 * 1000).toISOString()
      : null
  });
});

app.post('/api/refresh', requireAuth, async (req, res) => {
  if (state.refreshing) return res.json({ ok: false, message: 'Já está atualizando...' });
  refreshData(); // fire and don't wait
  res.json({ ok: true, message: 'Atualização iniciada...' });
});

// ── Debug: raw API response for one event ────
app.get('/api/debug/:eventId', async (req, res) => {
  const { adminKey } = req.query;
  if (adminKey !== ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  if (!state.token) return res.status(400).json({ error: 'Token not set' });
  try {
    const raw = await fetchIndicators(req.params.eventId, state.token);
    const cal = await fetchCalendar(req.params.eventId, state.token);
    res.json({ indicators: raw, calendar: cal });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Dashboard (main page) ────────────────────
app.get('/', requireAuth, (req, res) => {
  res.send(getDashboardHTML(req.session.user));
});

// ─────────────────────────────────────────────
// DASHBOARD HTML
// ─────────────────────────────────────────────
function getDashboardHTML(username) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Primeira Classe Rock in Rio — Dashboard de Vendas</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>
<style>
  :root {
    --bg:#0a0c10;--surface:#131720;--surface2:#1c2232;--border:#252d3d;
    --accent:#e63946;--accent2:#f4a261;--gold:#ffd700;--text:#e8eaf0;
    --muted:#7a8499;--green:#2ec27e;--blue:#5b8dee;--purple:#9b59b6;--teal:#1abc9c;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,-apple-system,sans-serif;min-height:100vh}

  /* ── HEADER ── */
  header{background:linear-gradient(135deg,#0d1117 0%,#1a0a0f 50%,#0d1117 100%);
    border-bottom:1px solid var(--border);padding:20px 40px;
    display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px}
  .header-left{display:flex;align-items:center;gap:16px}
  .logo-badge{background:var(--accent);color:#fff;font-weight:800;font-size:11px;
    letter-spacing:2px;text-transform:uppercase;padding:6px 12px;border-radius:4px}
  header h1{font-size:20px;font-weight:700}
  header p{font-size:12px;color:var(--muted);margin-top:2px}
  .header-right{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .btn{border:none;padding:10px 18px;border-radius:8px;font-size:13px;font-weight:600;
    cursor:pointer;display:flex;align-items:center;gap:6px;transition:.2s}
  .btn-primary{background:var(--accent);color:#fff}
  .btn-primary:hover{background:#c62d3a;transform:translateY(-1px)}
  .btn-secondary{background:var(--surface2);color:var(--text);border:1px solid var(--border)}
  .btn-secondary:hover{background:var(--border)}
  .btn svg{width:14px;height:14px}

  /* ── STATUS BAR ── */
  #status-bar{background:var(--surface);border-bottom:1px solid var(--border);
    padding:8px 40px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;font-size:12px}
  .status-dot{width:8px;height:8px;border-radius:50%;background:var(--muted);flex-shrink:0}
  .status-dot.green{background:var(--green)}
  .status-dot.yellow{background:var(--gold);animation:pulse 1.5s infinite}
  .status-dot.red{background:var(--accent)}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  #status-text{color:var(--muted)}
  #token-warning{color:var(--gold);font-weight:600;display:none}

  /* ── SECTION HEADINGS ── */
  .section-heading{padding:28px 40px 0;display:flex;align-items:center;gap:12px}
  .section-heading h2{font-size:17px;font-weight:700}
  .section-divider{flex:1;height:1px;background:var(--border)}

  /* ── KPI CARDS ── */
  .kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;padding:20px 40px 0}
  .kpi-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px 20px;position:relative;overflow:hidden}
  .kpi-card::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;border-radius:12px 12px 0 0}
  .kpi-card.red::before{background:var(--accent)} .kpi-card.gold::before{background:var(--gold)}
  .kpi-card.blue::before{background:var(--blue)}  .kpi-card.green::before{background:var(--green)}
  .kpi-card.purple::before{background:var(--purple)} .kpi-card.teal::before{background:var(--teal)}
  .kpi-label{font-size:10px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:var(--muted);margin-bottom:8px}
  .kpi-value{font-size:26px;font-weight:800;line-height:1}
  .kpi-sub{font-size:11px;color:var(--muted);margin-top:5px}

  /* ── CHARTS ── */
  .main-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;padding:20px 40px}
  .chart-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px;overflow:hidden}
  .chart-card.full{grid-column:1/-1}
  .chart-title{font-size:10px;font-weight:700;letter-spacing:1px;color:var(--muted);text-transform:uppercase;margin-bottom:4px}
  .chart-subtitle{font-size:16px;font-weight:700;margin-bottom:16px}

  /* ── HEATMAP ── */
  .heatmap-wrap{overflow-x:auto}
  .heatmap-table{border-collapse:collapse;min-width:100%}
  .heatmap-table th{padding:8px 12px;font-size:10px;font-weight:600;color:var(--muted);text-align:center;white-space:nowrap}
  .heatmap-table th.event-col{text-align:left;min-width:170px}
  .heatmap-table td{padding:5px 8px;font-size:11px;text-align:center;border:1px solid var(--border)}
  .heatmap-table td.event-name{text-align:left;font-weight:600;white-space:nowrap;background:var(--surface2)}
  .hm-cell{border-radius:4px;padding:3px 8px;font-weight:700;font-size:11px;display:inline-block;min-width:30px}

  /* ── EVENTS TABLE ── */
  .table-section{padding:0 40px 40px}
  .table-controls{display:flex;gap:12px;margin-bottom:14px;flex-wrap:wrap}
  .search-input{background:var(--surface);border:1px solid var(--border);border-radius:8px;
    padding:9px 14px;color:var(--text);font-size:13px;outline:none;flex:1;min-width:200px;transition:.2s}
  .search-input:focus{border-color:var(--accent)}
  .events-table{width:100%;border-collapse:collapse}
  .events-table th{padding:10px 14px;font-size:10px;font-weight:700;letter-spacing:.8px;
    text-transform:uppercase;color:var(--muted);text-align:left;border-bottom:1px solid var(--border);cursor:pointer;white-space:nowrap}
  .events-table th:hover{color:var(--text)}
  .events-table td{padding:10px 14px;font-size:13px;border-bottom:1px solid var(--border)}
  .events-table tr:hover td{background:var(--surface2)}
  .badge-sold{background:#1a2a1a;color:var(--green);font-size:11px;font-weight:700;
    padding:3px 8px;border-radius:4px;display:inline-block}

  /* ── LOADING OVERLAY ── */
  #loading{position:fixed;inset:0;background:rgba(10,12,16,.85);display:flex;flex-direction:column;
    align-items:center;justify-content:center;gap:16px;z-index:9999;font-size:14px;color:var(--muted)}
  #loading.hidden{display:none}
  .spinner{width:40px;height:40px;border:3px solid var(--border);border-top-color:var(--accent);
    border-radius:50%;animation:spin .8s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}

  /* ── MODAL HISTÓRICO ── */
  .modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:1000;display:flex;align-items:flex-start;justify-content:center;padding:40px 20px;overflow-y:auto}
  .modal-overlay.hidden{display:none}
  .modal-box{background:var(--surface);border:1px solid var(--border);border-radius:16px;width:100%;max-width:900px;padding:32px;position:relative}
  .modal-close{position:absolute;top:16px;right:16px;background:var(--surface2);border:1px solid var(--border);color:var(--text);border-radius:8px;width:32px;height:32px;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center}
  .modal-close:hover{background:var(--border)}
  .hist-table{width:100%;border-collapse:collapse;margin-top:16px;font-size:13px}
  .hist-table th{padding:9px 12px;font-size:10px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--muted);text-align:right;border-bottom:2px solid var(--border);white-space:nowrap}
  .hist-table th:first-child{text-align:center}
  .hist-table td{padding:9px 12px;text-align:right;border-bottom:1px solid var(--border)}
  .hist-table td:first-child{text-align:center;font-weight:800;font-size:15px}
  .hist-table tr:hover td{background:var(--surface2)}
  .hist-table tr.current-year td{background:#1a1f10;border-left:3px solid var(--green)}
  .hist-table tr.current-year td:first-child{color:var(--green)}
  .hist-section-header{background:var(--surface2);font-weight:700!important;color:var(--text)!important;font-size:11px!important;letter-spacing:1px;text-transform:uppercase!important;padding:6px 12px!important}
  .growth-badge{font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;margin-left:6px;display:inline-block}
  .growth-pos{background:#1a2a1a;color:var(--green)}
  .growth-neg{background:#2a1a1a;color:var(--accent)}

  /* ── PROJEÇÃO ── */
  .proj-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;padding:20px 40px 0}
  .proj-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px 20px;position:relative;overflow:hidden}
  .proj-card::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;border-radius:12px 12px 0 0}
  .proj-card.conservador::before{background:#5b8dee}
  .proj-card.tendencia::before{background:#2ec27e}
  .proj-card.otimista::before{background:#ffd700}
  .proj-card.velocidade::before{background:#9b59b6}
  .proj-label{font-size:10px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:var(--muted);margin-bottom:6px}
  .proj-value{font-size:24px;font-weight:800;line-height:1.1}
  .proj-sub{font-size:11px;color:var(--muted);margin-top:5px}
  .proj-scenario{font-size:11px;font-weight:600;margin-top:8px;padding:4px 8px;border-radius:4px;display:inline-block}
  .proj-scenario.conservador{background:#0d1a2a;color:#5b8dee}
  .proj-scenario.tendencia{background:#0d2a1a;color:#2ec27e}
  .proj-scenario.otimista{background:#2a2a0d;color:#ffd700}
  .progress-wrap{background:var(--surface2);border-radius:6px;height:10px;overflow:hidden;margin-top:8px}
  .progress-fill{height:100%;border-radius:6px;transition:width .6s ease}
  .proj-settings{display:flex;align-items:center;gap:12px;padding:12px 40px 0;flex-wrap:wrap}
  .proj-input{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:6px 12px;color:var(--text);font-size:13px;width:80px;text-align:center;outline:none}
  .proj-input:focus{border-color:var(--accent)}
  .proj-input-label{font-size:12px;color:var(--muted)}

  /* ── RANKING ── */
  .ranking-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;padding:20px 40px}
  .rank-table{width:100%;border-collapse:collapse}
  .rank-table tr{border-bottom:1px solid var(--border)}
  .rank-table tr:last-child{border-bottom:none}
  .rank-table tr:hover td{background:var(--surface2)}
  .rank-pos{padding:8px 6px;font-size:13px;width:36px;text-align:center;font-weight:800;color:var(--muted)}
  .rank-pos.top{color:var(--gold)}
  .rank-name{padding:8px 8px;font-size:13px;font-weight:600;white-space:nowrap;max-width:180px;overflow:hidden;text-overflow:ellipsis}
  .rank-bar-td{padding:6px 8px;width:100%}
  .rank-bar-wrap{background:var(--surface2);border-radius:4px;height:8px;overflow:hidden}
  .rank-bar-fill{height:100%;background:var(--accent);border-radius:4px}
  .rank-bar-time{background:var(--green)}
  .rank-bar-blue{background:var(--blue)}
  .rank-val{padding:8px 6px;font-size:12px;font-weight:700;color:var(--text);white-space:nowrap;text-align:right;min-width:44px}
  .rank-sub{font-size:10px;color:var(--muted)}

  @media(max-width:768px){
    header,.kpi-grid,.main-grid,.table-section,.section-heading,.ranking-grid{padding-left:16px;padding-right:16px}
    .main-grid{grid-template-columns:1fr} .chart-card.full{grid-column:1}
    .ranking-grid{grid-template-columns:1fr}
    #status-bar{padding-left:16px;padding-right:16px}
  }
</style>
</head>
<body>

<div id="loading">
  <div class="spinner"></div>
  <span>Carregando dados da Ticketmaster...</span>
</div>

<header>
  <div class="header-left">
    <div class="logo-badge">Rock in Rio 2026</div>
    <div>
      <h1>Primeira Classe — Dashboard de Vendas</h1>
      <p>${EVENT_IDS.length} locais · Setembro 2026 · Logado como <strong>${username}</strong></p>
    </div>
  </div>
  <div class="header-right">
    <button class="btn btn-secondary" onclick="doRefresh()" id="refresh-btn">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
        <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
      </svg>
      Atualizar Dados
    </button>
    <button class="btn btn-secondary" onclick="openHistorico()" id="hist-btn" style="border-color:#ffd700;color:#ffd700">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
      </svg>
      Comparativo Histórico
    </button>
    <button class="btn btn-primary" onclick="exportXLS()" id="export-btn">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
        <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
      Exportar XLS
    </button>
    <form method="POST" action="/logout" style="margin:0">
      <button class="btn btn-secondary" type="submit">Sair</button>
    </form>
  </div>
</header>

<div id="status-bar">
  <span class="status-dot" id="status-dot"></span>
  <span id="status-text">Conectando...</span>
  <span id="token-warning">⚠️ Token expirando em breve — clique no bookmarklet no painel da Ticketmaster</span>
  <span style="margin-left:auto;display:flex;align-items:center;gap:8px;font-size:11px;">
    <a id="bookmarklet-link"
       href="javascript:(function(){var u=localStorage.getItem('u');if(!u){alert('Faça login na Ticketmaster primeiro');return;}var t=JSON.parse(u).authToken;fetch('https://rock-in-rio-dashboard-production.up.railway.app/admin/sync-token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:t,adminKey:'rir-admin-2026'})}).then(r=>r.json()).then(d=>alert(d.message||'OK!')).catch(e=>alert('Erro: '+e));})();"
       style="background:#1c2e1c;color:#2ec27e;border:1px solid #2ec27e;padding:4px 10px;border-radius:5px;text-decoration:none;font-weight:600;cursor:grab;white-space:nowrap;"
       title="Arraste este link para sua barra de favoritos do Chrome">
      🔖 Arraste para Favoritos — Sync Token
    </a>
    <span style="color:var(--muted);">← arraste para a barra de favoritos</span>
  </span>
</div>

<!-- MODAL COMPARATIVO HISTÓRICO -->
<div class="modal-overlay hidden" id="hist-modal" onclick="if(event.target===this)closeHistorico()">
  <div class="modal-box">
    <button class="modal-close" onclick="closeHistorico()">×</button>
    <div style="margin-bottom:20px">
      <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);margin-bottom:4px">Série Histórica</div>
      <h2 style="font-size:22px;font-weight:800">Comparativo de Edições — Primeira Classe</h2>
      <p style="font-size:12px;color:var(--muted);margin-top:4px">Snapshot na mesma janela de antecedência ao 1º dia do festival · 2026 = dados ao vivo</p>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:24px">
      <div class="chart-card">
        <div class="chart-title">Ingressos Vendidos por Edição</div>
        <canvas id="histTicketsChart" height="200"></canvas>
      </div>
      <div class="chart-card">
        <div class="chart-title">Receita Total (R$) por Edição</div>
        <canvas id="histRevenueChart" height="200"></canvas>
      </div>
    </div>
    <div id="hist-table-container"></div>
  </div>
</div>

<div id="app"></div>

<script src="/js/dashboard.js"></script>
</body>
</html>`;
}

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🎸 Rock in Rio Dashboard rodando em http://localhost:${PORT}`);
  console.log(`\n⚙️  Variáveis de ambiente necessárias:`);
  console.log(`   USERS        = "usuario1:senha1,usuario2:senha2"`);
  console.log(`   ADMIN_KEY    = "chave-secreta-do-bookmarklet"`);
  console.log(`   SESSION_SECRET = "string-aleatória-longa"\n`);
});

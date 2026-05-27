'use strict';
const express = require('express');
const session = require('express-session');
const fetch   = require('node-fetch');
const cron    = require('node-cron');
const crypto  = require('crypto');

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

async function fetchIndicators(eventId, token) {
  const res = await fetch(`${TM_BASE}/eventConsoleWs/indicators/${eventId}`, {
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
  const res = await fetch(
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

  try {
    const indicatorTasks  = EVENT_IDS.map(id => () => fetchIndicators(id, state.token));
    const calendarTasks   = EVENT_IDS.map(id => () => fetchCalendar(id, state.token));

    const [eventResults, calendarResults] = await Promise.all([
      pool(indicatorTasks, 6),
      pool(calendarTasks, 6)
    ]);

    state.data        = aggregateData(eventResults, calendarResults);
    state.lastRefresh = new Date();
    console.log(`[${new Date().toISOString()}] Dados atualizados. Total vendido: ${state.data.totalSold} ingressos`);
  } catch (err) {
    state.error = err.message;
    console.error('[refresh error]', err.message);
  } finally {
    state.refreshing = false;
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

<script>
// ═══════════════════════════════════════════════════════════
// STATE & CHARTS
// ═══════════════════════════════════════════════════════════
let _data = null;
let _rawShows = [];
let _charts = {};
let _sortCol = 'sold', _sortDir = -1, _filter = '';

const fmt  = n => n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'k' : String(n);
const fmtR = n => 'R$ '+Number(n).toLocaleString('pt-BR',{minimumFractionDigits:0,maximumFractionDigits:0});

// ═══════════════════════════════════════════════════════════
// FETCH DATA FROM SERVER
// ═══════════════════════════════════════════════════════════
async function loadData() {
  try {
    const res = await fetch('/api/data');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();

    updateStatusBar(json);

    if (json.data) {
      _data     = json.data;
      _rawShows = json.data.rawShows || [];
      renderAll();
      document.getElementById('loading').classList.add('hidden');
    } else if (json.error) {
      showError(json.error);
    } else if (json.refreshing) {
      document.querySelector('#loading span').textContent = 'Buscando dados da Ticketmaster...';
      setTimeout(loadData, 3000);
    } else {
      showError('Nenhum dado disponível. Sincronize o token usando o bookmarklet.');
    }
  } catch(e) {
    showError('Erro ao carregar dados: ' + e.message);
  }
}

function updateStatusBar(json) {
  const dot  = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  const warn = document.getElementById('token-warning');

  if (json.refreshing) {
    dot.className  = 'status-dot yellow';
    text.textContent = 'Atualizando dados...';
  } else if (json.lastRefresh) {
    dot.className  = 'status-dot green';
    const lr = new Date(json.lastRefresh);
    text.textContent = 'Atualizado em ' + lr.toLocaleTimeString('pt-BR');
  } else if (json.error) {
    dot.className  = 'status-dot red';
    text.textContent = json.error;
  }

  if (json.tokenExpiry) {
    const expiresIn = new Date(json.tokenExpiry) - Date.now();
    warn.style.display = expiresIn < 2 * 60 * 60 * 1000 ? 'inline' : 'none';
  }
}

function showError(msg) {
  document.getElementById('loading').classList.add('hidden');
  document.getElementById('app').innerHTML = \`
    <div style="padding:60px 40px;text-align:center;color:var(--muted)">
      <div style="font-size:48px;margin-bottom:16px">⚠️</div>
      <div style="font-size:16px;font-weight:600;color:var(--text);margin-bottom:8px">Dados não disponíveis</div>
      <div style="font-size:13px">\${msg}</div>
      <div style="margin-top:24px;font-size:12px;color:#5a6475">
        Para atualizar: abra o painel da Ticketmaster e clique no bookmarklet "Sync RiR Dashboard"
      </div>
    </div>\`;
}

async function doRefresh() {
  const btn = document.getElementById('refresh-btn');
  btn.disabled = true;
  btn.innerHTML = '<span style="font-size:12px">Atualizando...</span>';
  await fetch('/api/refresh', { method: 'POST' });
  setTimeout(() => {
    loadData();
    btn.disabled = false;
    btn.innerHTML = \`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
      <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
    </svg>Atualizar Dados\`;
  }, 8000);
}

// ═══════════════════════════════════════════════════════════
// RENDER
// ═══════════════════════════════════════════════════════════
function renderAll() {
  if (!_data) return;
  const { events, byDate, byTime, heatmap, totalSold, totalRevenue,
          totalReserved, totalReservedRevenue, totalCancelled, totalCancelledRevenue } = _data;

  const totalTax       = _rawShows.reduce((s, r) => s + (r.taxa || 0), 0);
  const totalTickets   = events.reduce((s, e) => s + e.sold, 0);
  const totalEvents    = events.filter(e => e.sold > 0).length;
  const totalPurchases = events.reduce((s, e) => s + e.purchases, 0);
  const totalRes       = events.reduce((s, e) => s + (e.reserved || 0), 0);
  const totalCan       = events.reduce((s, e) => s + (e.cancelled || 0), 0);

  document.getElementById('app').innerHTML = \`
    <!-- KPIs -->
    <div class="section-heading"><h2>Visão Geral</h2><div class="section-divider"></div></div>
    <div class="kpi-grid">
      <div class="kpi-card red"><div class="kpi-label">Ingressos Vendidos</div>
        <div class="kpi-value">\${fmt(totalTickets)}</div>
        <div class="kpi-sub">em \${totalEvents} locais ativos</div></div>
      <div class="kpi-card gold"><div class="kpi-label">Receita (Subtotal)</div>
        <div class="kpi-value">\${fmtR(totalRevenue)}</div>
        <div class="kpi-sub">+ \${fmtR(totalTax)} em taxas</div></div>
      <div class="kpi-card blue"><div class="kpi-label">Total c/ Taxas</div>
        <div class="kpi-value">\${fmtR(totalRevenue + totalTax)}</div>
        <div class="kpi-sub">receita bruta total</div></div>
      <div class="kpi-card green"><div class="kpi-label">Compras Realizadas</div>
        <div class="kpi-value">\${fmt(totalPurchases)}</div>
        <div class="kpi-sub">pedidos únicos</div></div>
      <div class="kpi-card teal"><div class="kpi-label">Ticket Médio / Pedido</div>
        <div class="kpi-value">\${fmtR(totalPurchases ? totalRevenue / totalPurchases : 0)}</div>
        <div class="kpi-sub">\${totalPurchases ? (totalTickets/totalPurchases).toFixed(1) : 0} ingr./pedido</div></div>
      <div class="kpi-card purple"><div class="kpi-label">Locais</div>
        <div class="kpi-value">${EVENT_IDS.length}</div>
        <div class="kpi-sub">\${totalEvents} com vendas</div></div>
      <div class="kpi-card" style="border-top:3px solid #f4a261"><div class="kpi-label">Reservados</div>
        <div class="kpi-value" style="color:#f4a261">\${fmt(totalRes)}</div>
        <div class="kpi-sub">pedidos em aberto</div></div>
      <div class="kpi-card" style="border-top:3px solid #e63946"><div class="kpi-label">Cancelados</div>
        <div class="kpi-value" style="color:#e63946">\${fmt(totalCan)}</div>
        <div class="kpi-sub">pedidos cancelados</div></div>
    </div>

    <!-- PROJEÇÃO -->
    <div class="section-heading"><h2>Projeção de Vendas — 2026</h2><div class="section-divider"></div></div>
    <div class="proj-settings">
      <span class="proj-input-label">Dias desde abertura das vendas:</span>
      <input class="proj-input" type="number" id="proj-days-elapsed" value="90" min="1" max="365" oninput="renderProjection()">
      <span class="proj-input-label" id="proj-countdown"></span>
    </div>
    <div class="proj-grid" id="proj-cards"></div>
    <div style="padding:16px 40px 0">
      <div class="chart-card">
        <div class="chart-title">Projeção vs Histórico</div>
        <div class="chart-subtitle">Total de ingressos ao final de cada edição (projetado para 2026)</div>
        <canvas id="projChart" height="70"></canvas>
      </div>
    </div>

    <!-- RANKING -->
    <div class="section-heading"><h2>Ranking de Ocupação</h2><div class="section-divider"></div></div>
    <div class="ranking-grid">
      <div class="chart-card">
        <div class="chart-title">Locais</div>
        <div class="chart-subtitle">Por Ingressos Vendidos</div>
        <div id="ranking-locais"></div>
      </div>
      <div class="chart-card">
        <div class="chart-title">Horários de Saída</div>
        <div class="chart-subtitle">Por Volume de Ingressos</div>
        <div id="ranking-horarios"></div>
      </div>
    </div>

    <!-- CHARTS ROW 1 -->
    <div class="section-heading"><h2>Distribuição de Vendas</h2><div class="section-divider"></div></div>
    <div class="main-grid">
      <div class="chart-card full">
        <div class="chart-title">Ranking</div>
        <div class="chart-subtitle">Ingressos por Local</div>
        <canvas id="locaisChart" height="100"></canvas>
      </div>
      <div class="chart-card">
        <div class="chart-title">Cronograma</div>
        <div class="chart-subtitle">Vendas por Data do Festival</div>
        <canvas id="dateChart"></canvas>
      </div>
      <div class="chart-card">
        <div class="chart-title">Horários</div>
        <div class="chart-subtitle">Ingressos por Horário de Saída</div>
        <canvas id="timeChart"></canvas>
      </div>
    </div>

    <!-- HISTÓRICO DE EDIÇÕES -->
    <div class="section-heading"><h2>Série Histórica — Edições do Rock in Rio</h2><div class="section-divider"></div></div>
    <div class="main-grid">
      <div class="chart-card full">
        <div class="chart-title">Comparativo entre Edições</div>
        <div class="chart-subtitle" style="display:flex;align-items:center;gap:16px">
          Primeira Classe: Ingressos &amp; Receita por Ano
          <span style="font-size:11px;color:var(--muted);font-weight:400">⚡ 2026 = dados ao vivo</span>
        </div>
        <canvas id="historicoChart" height="80"></canvas>
      </div>
    </div>

    <!-- HEATMAP -->
    <div class="section-heading"><h2>Heatmap Local × Data</h2><div class="section-divider"></div></div>
    <div style="padding:20px 40px">
      <div class="chart-card"><div class="heatmap-wrap" id="heatmap-container"></div></div>
    </div>

    <!-- EVENTS TABLE -->
    <div class="section-heading"><h2>Tabela de Eventos</h2><div class="section-divider"></div></div>
    <div class="table-section">
      <div class="table-controls">
        <input class="search-input" id="search" placeholder="Buscar local..." oninput="filterTable(this.value)">
      </div>
      <div class="chart-card" style="overflow-x:auto">
        <table class="events-table" id="evTable">
          <thead><tr>
            <th onclick="sortTable('name')">Local ↕</th>
            <th onclick="sortTable('sold')">Ingressos ↕</th>
            <th onclick="sortTable('revenue')">Subtotal ↕</th>
            <th onclick="sortTable('purchases')">Compras ↕</th>
            <th onclick="sortTable('reserved')" style="color:#f4a261">Reservados ↕</th>
            <th onclick="sortTable('cancelled')" style="color:#e63946">Cancelados ↕</th>
            <th onclick="sortTable('shows')">Shows ↕</th>
          </tr></thead>
          <tbody id="evTbody"></tbody>
        </table>
      </div>
    </div>\`;

  renderCharts(events, byDate, byTime);
  renderHistoricoChart();
  renderHeatmap(events, byDate, heatmap);
  renderProjection();
  renderRanking(events, byTime);
  renderTable(events);
}

function renderCharts(events, byDate, byTime) {
  const C = (id, cfg) => {
    if (_charts[id]) _charts[id].destroy();
    _charts[id] = new Chart(document.getElementById(id), cfg);
  };

  const sorted = [...events].sort((a, b) => b.sold - a.sold).filter(e => e.sold > 0);
  C('locaisChart', {
    type: 'bar',
    data: {
      labels: sorted.map(e => e.name),
      datasets: [{ data: sorted.map(e => e.sold), backgroundColor: '#e63946cc', borderColor: '#e63946', borderWidth: 1, borderRadius: 4 }]
    },
    options: { responsive: true, plugins: { legend: { display: false } },
      scales: { x: { ticks: { color: '#7a8499', font: { size: 11 } }, grid: { color: '#252d3d' } },
                y: { ticks: { color: '#7a8499' }, grid: { color: '#252d3d' } } } }
  });

  C('dateChart', {
    type: 'bar',
    data: {
      labels: byDate.map(d => d.label),
      datasets: [{ data: byDate.map(d => d.tks), backgroundColor: '#5b8dee99', borderColor: '#5b8dee', borderWidth: 1, borderRadius: 6 }]
    },
    options: { responsive: true, plugins: { legend: { display: false } },
      scales: { x: { ticks: { color: '#7a8499' }, grid: { color: '#252d3d' } },
                y: { ticks: { color: '#7a8499' }, grid: { color: '#252d3d' } } } }
  });

  C('timeChart', {
    type: 'bar',
    data: {
      labels: byTime.map(t => t.time),
      datasets: [{ data: byTime.map(t => t.tks), backgroundColor: '#2ec27e88', borderColor: '#2ec27e', borderWidth: 1, borderRadius: 4 }]
    },
    options: { responsive: true, plugins: { legend: { display: false } },
      scales: { x: { ticks: { color: '#7a8499', font: { size: 10 } }, grid: { color: '#252d3d' } },
                y: { ticks: { color: '#7a8499' }, grid: { color: '#252d3d' } } } }
  });
}

function renderProjection() {
  if (!_data) return;
  const sold    = _data.totalSold    || 0;
  const revenue = _data.totalRevenue || 0;

  // Days remaining until first event (Sep 4, 2026)
  const eventDay     = new Date('2026-09-04T00:00:00');
  const today        = new Date();
  const daysLeft     = Math.max(0, Math.round((eventDay - today) / 86400000));
  const daysElapsed  = parseInt(document.getElementById('proj-days-elapsed')?.value || 90, 10) || 90;
  const totalDays    = daysElapsed + daysLeft;

  // Countdown display
  const cdEl = document.getElementById('proj-countdown');
  if (cdEl) cdEl.textContent = daysLeft + ' dias até o 1º evento (4 Set 2026)';

  // Current velocity
  const velocityTix = sold    / daysElapsed;          // tickets/dia
  const velocityRev = revenue / daysElapsed;          // R$/dia
  const avgTicketPrice = sold > 0 ? revenue / sold : 220;

  // Linear projection (current velocity)
  const projTrend   = Math.round(sold    + velocityTix * daysLeft);
  const projRevTrend = revenue + velocityRev * daysLeft;

  // Historical growth rates (2019→2022→2024)
  const last2  = HIST_DATA[HIST_DATA.length - 1]; // 2024: 157,738
  const last3  = HIST_DATA[HIST_DATA.length - 2]; // 2022: 143,518
  const last4  = HIST_DATA[HIST_DATA.length - 3]; // 2019: 140,852
  const grow24 = (last2.vendas - last3.vendas) / last3.vendas; // 2022→2024: +9.9%
  const grow22 = (last3.vendas - last4.vendas) / last4.vendas; // 2019→2022: +1.9%
  const avgGrow = (grow24 + grow22) / 2;                        // ~5.9%
  const minGrow = Math.min(grow24, grow22);                     // ~1.9%
  const maxGrow = Math.max(grow24 * 1.3, avgGrow * 1.5);       // optimistic

  const projConservador = Math.round(last2.vendas * (1 + minGrow));
  const projOtimista    = Math.round(last2.vendas * (1 + maxGrow));

  // Revenue projections
  const projRevConserv  = last2.total * (1 + minGrow) * (avgTicketPrice / (last2.total / last2.vendas));
  const projRevOtimista = last2.total * (1 + maxGrow) * (avgTicketPrice / (last2.total / last2.vendas));

  // Progress % toward projected final
  const pctConserv  = Math.min(100, (sold / projConservador * 100)).toFixed(1);
  const pctTrend    = Math.min(100, (sold / projTrend      * 100)).toFixed(1);
  const pctOtimista = Math.min(100, (sold / projOtimista   * 100)).toFixed(1);

  const fmtR = n => 'R$ ' + Number(n).toLocaleString('pt-BR', {minimumFractionDigits: 0, maximumFractionDigits: 0});
  const fmtN = n => Number(n).toLocaleString('pt-BR');

  // Render KPI cards
  document.getElementById('proj-cards').innerHTML = \`
    <div class="proj-card velocidade">
      <div class="proj-label">Velocidade Atual</div>
      <div class="proj-value" style="color:var(--purple)">\${velocityTix.toFixed(1)}</div>
      <div class="proj-sub">ingressos / dia</div>
      <div class="proj-sub">\${fmtR(velocityRev)} / dia</div>
      <div class="proj-sub" style="margin-top:8px">\${fmtN(sold)} vendidos · \${daysLeft} dias restantes</div>
    </div>
    <div class="proj-card conservador">
      <div class="proj-label">Projeção Conservadora</div>
      <div class="proj-value" style="color:var(--blue)">\${fmtN(projConservador)}</div>
      <div class="proj-sub">\${fmtR(last2.total * (1 + minGrow))}</div>
      <div class="proj-scenario conservador">+\${(minGrow*100).toFixed(1)}% vs 2024</div>
      <div class="proj-sub" style="margin-top:8px">\${pctConserv}% vendido</div>
      <div class="progress-wrap"><div class="progress-fill" style="width:\${pctConserv}%;background:var(--blue)"></div></div>
    </div>
    <div class="proj-card tendencia">
      <div class="proj-label">Projeção Tendência ⚡</div>
      <div class="proj-value" style="color:var(--green)">\${fmtN(projTrend)}</div>
      <div class="proj-sub">\${fmtR(projRevTrend)}</div>
      <div class="proj-scenario tendencia">\${projTrend > last2.vendas ? '+' : ''}\${((projTrend/last2.vendas-1)*100).toFixed(1)}% vs 2024</div>
      <div class="proj-sub" style="margin-top:8px">\${pctTrend}% vendido</div>
      <div class="progress-wrap"><div class="progress-fill" style="width:\${pctTrend}%;background:var(--green)"></div></div>
    </div>
    <div class="proj-card otimista">
      <div class="proj-label">Projeção Otimista</div>
      <div class="proj-value" style="color:var(--gold)">\${fmtN(projOtimista)}</div>
      <div class="proj-sub">\${fmtR(last2.total * (1 + maxGrow))}</div>
      <div class="proj-scenario otimista">+\${(maxGrow*100).toFixed(1)}% vs 2024</div>
      <div class="proj-sub" style="margin-top:8px">\${pctOtimista}% vendido</div>
      <div class="progress-wrap"><div class="progress-fill" style="width:\${pctOtimista}%;background:var(--gold)"></div></div>
    </div>\`;

  // Projection chart — historical finals + 2026 scenarios
  const histLabels = HIST_DATA.map(r => String(r.year));
  const histVals   = HIST_DATA.map(r => r.vendas);
  const histColors = HIST_DATA.map(() => 'rgba(91,141,238,0.6)');
  const histBorders= HIST_DATA.map(() => '#5b8dee');

  const allLabels = [...histLabels, '2026\nConserv.', '2026\nTendência', '2026\nOtimista'];
  const allVals   = [...histVals,   projConservador, projTrend, projOtimista];
  const allColors = [...histColors, 'rgba(91,141,238,0.4)', 'rgba(46,194,126,0.75)', 'rgba(255,215,0,0.75)'];
  const allBorders= [...histBorders,'#5b8dee',              '#2ec27e',               '#ffd700'];

  // Current sales bar overlay
  const currentOverlay = [...HIST_DATA.map(() => null), sold, sold, sold];

  if (_charts['projChart']) _charts['projChart'].destroy();
  _charts['projChart'] = new Chart(document.getElementById('projChart'), {
    type: 'bar',
    data: {
      labels: allLabels,
      datasets: [
        {
          label: 'Projeção Final',
          data: allVals,
          backgroundColor: allColors,
          borderColor: allBorders,
          borderWidth: 2,
          borderRadius: 6,
          order: 2
        },
        {
          label: 'Vendido até hoje',
          data: currentOverlay,
          backgroundColor: 'rgba(230,57,70,0.6)',
          borderColor: '#e63946',
          borderWidth: 2,
          borderRadius: 6,
          order: 1
        }
      ]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: true, labels: { color: '#7a8499', font: { size: 11 }, boxWidth: 12, padding: 16 } },
        tooltip: {
          callbacks: {
            label: ctx => ' ' + Number(ctx.raw).toLocaleString('pt-BR') + ' ingressos'
          }
        },
        annotation: {}
      },
      scales: {
        x: { ticks: { color: '#7a8499', font: { size: 11 } }, grid: { color: '#252d3d' } },
        y: {
          ticks: { color: '#7a8499', callback: v => Number(v).toLocaleString('pt-BR') },
          grid: { color: '#252d3d' }
        }
      }
    }
  });
}

function renderHistoricoChart() {
  const cur = _data ? { year: 2026, vendas: _data.totalSold || 0, total: _data.totalRevenue || 0 } : null;
  const rows = cur ? [...HIST_DATA, cur] : HIST_DATA;

  const labels  = rows.map(r => String(r.year));
  const tickets = rows.map(r => r.vendas);
  const revenue = rows.map(r => r.total);
  const is2026  = rows.map(r => r.year === 2026);

  const barColors   = is2026.map(c => c ? 'rgba(230,57,70,0.85)'  : 'rgba(91,141,238,0.75)');
  const barBorders  = is2026.map(c => c ? '#e63946' : '#5b8dee');

  if (_charts['historicoChart']) _charts['historicoChart'].destroy();
  _charts['historicoChart'] = new Chart(document.getElementById('historicoChart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Ingressos Vendidos',
          data: tickets,
          backgroundColor: barColors,
          borderColor: barBorders,
          borderWidth: 2,
          borderRadius: 6,
          yAxisID: 'yTickets',
          order: 2
        },
        {
          label: 'Receita Total (R$)',
          data: revenue,
          type: 'line',
          borderColor: '#ffd700',
          backgroundColor: 'rgba(255,215,0,0.10)',
          borderWidth: 3,
          pointRadius: rows.map(r => r.year === 2026 ? 8 : 5),
          pointBackgroundColor: is2026.map(c => c ? '#ffd700' : '#ffd70099'),
          pointBorderColor: '#ffd700',
          pointBorderWidth: 2,
          tension: 0.35,
          fill: true,
          yAxisID: 'yRevenue',
          order: 1
        }
      ]
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true,
          labels: { color: '#7a8499', font: { size: 12 }, boxWidth: 14, padding: 20 }
        },
        tooltip: {
          callbacks: {
            label: ctx => {
              if (ctx.dataset.label === 'Ingressos Vendidos')
                return \` \${Number(ctx.raw).toLocaleString('pt-BR')} ingressos\`;
              return \` R\$ \${Number(ctx.raw).toLocaleString('pt-BR', {minimumFractionDigits:0})}\`;
            },
            afterBody: (items) => {
              const i = items[0]?.dataIndex;
              if (i > 0) {
                const prev = rows[i-1], curr = rows[i];
                const pctT = ((curr.vendas - prev.vendas) / prev.vendas * 100).toFixed(1);
                const pctR = ((curr.total  - prev.total)  / prev.total  * 100).toFixed(1);
                return [
                  '  ingressos vs ' + prev.year + ': ' + (pctT >= 0 ? '+' : '') + pctT + '%',
                  '  receita vs '   + prev.year + ': ' + (pctR >= 0 ? '+' : '') + pctR + '%'
                ];
              }
              return [];
            }
          }
        }
      },
      scales: {
        x: {
          ticks: { color: '#e8eaf0', font: { size: 13, weight: '700' } },
          grid: { color: '#252d3d' }
        },
        yTickets: {
          type: 'linear',
          position: 'left',
          ticks: { color: '#5b8dee', callback: v => Number(v).toLocaleString('pt-BR') },
          grid: { color: '#252d3d' },
          title: { display: true, text: 'Ingressos', color: '#5b8dee', font: { size: 11 } }
        },
        yRevenue: {
          type: 'linear',
          position: 'right',
          ticks: { color: '#ffd700', callback: v => 'R$' + (v >= 1e6 ? (v/1e6).toFixed(1)+'M' : (v/1e3).toFixed(0)+'k') },
          grid: { drawOnChartArea: false },
          title: { display: true, text: 'Receita', color: '#ffd700', font: { size: 11 } }
        }
      }
    }
  });
}

function renderHeatmap(events, byDate, heatmap) {
  const FESTIVAL_DATES = ['2026-09-04','2026-09-05','2026-09-06','2026-09-07',
                          '2026-09-11','2026-09-12','2026-09-13'];
  const DATE_SHORT = ['04/Set','05/Set','06/Set','07/Set','11/Set','12/Set','13/Set'];
  const maxVal = Math.max(1, ...events.flatMap(e =>
    FESTIVAL_DATES.map(d => (heatmap[e.name]?.[d] || 0))));

  function hmColor(v) {
    if (!v) return 'transparent';
    const t = Math.min(v / maxVal, 1);
    const r = Math.round(230 * t), g = Math.round(57 + 100 * (1 - t));
    return \`rgba(\${r},\${g},70,\${0.2 + t * 0.7})\`;
  }

  const rows = events.filter(e => e.sold > 0).sort((a, b) => b.sold - a.sold);
  let html = '<table class="heatmap-table"><thead><tr>';
  html += '<th class="event-col">Local</th>';
  DATE_SHORT.forEach(d => { html += \`<th>\${d}</th>\`; });
  html += '</tr></thead><tbody>';
  rows.forEach(ev => {
    html += \`<tr><td class="event-name">\${ev.name}</td>\`;
    FESTIVAL_DATES.forEach(d => {
      const v = heatmap[ev.name]?.[d] || 0;
      const color = hmColor(v);
      html += \`<td><span class="hm-cell" style="background:\${color}">\${v || ''}</span></td>\`;
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  document.getElementById('heatmap-container').innerHTML = html;
}

function renderRanking(events, byTime) {
  // ── Ranking por Local ──────────────────────────────────────
  const sortedEvents = [...events].filter(e => e.sold > 0).sort((a, b) => b.sold - a.sold);
  const maxSold = sortedEvents[0]?.sold || 1;
  const totalSoldAll = sortedEvents.reduce((s, e) => s + e.sold, 0) || 1;

  const medals = ['🥇','🥈','🥉'];
  let htmlLocais = '<table class="rank-table">';
  sortedEvents.forEach((e, i) => {
    const pct = (e.sold / maxSold * 100).toFixed(1);
    const sharePct = (e.sold / totalSoldAll * 100).toFixed(1);
    const pos = medals[i] || (\`<span style="font-size:11px">#\${i+1}</span>\`);
    const posClass = i < 3 ? 'rank-pos top' : 'rank-pos';
    htmlLocais += \`<tr>
      <td class="\${posClass}">\${pos}</td>
      <td class="rank-name" title="\${e.name}">\${e.name}</td>
      <td class="rank-bar-td"><div class="rank-bar-wrap"><div class="rank-bar-fill" style="width:\${pct}%"></div></div></td>
      <td class="rank-val">\${e.sold}<br><span class="rank-sub">\${sharePct}%</span></td>
    </tr>\`;
  });
  htmlLocais += '</table>';
  document.getElementById('ranking-locais').innerHTML = htmlLocais;

  // ── Ranking por Horário ────────────────────────────────────
  const sortedTimes = [...byTime].filter(t => t.tks > 0).sort((a, b) => b.tks - a.tks);
  const maxTks = sortedTimes[0]?.tks || 1;
  const totalTksAll = sortedTimes.reduce((s, t) => s + t.tks, 0) || 1;

  let htmlHorarios = '<table class="rank-table">';
  sortedTimes.forEach((t, i) => {
    const pct = (t.tks / maxTks * 100).toFixed(1);
    const sharePct = (t.tks / totalTksAll * 100).toFixed(1);
    const pos = medals[i] || (\`<span style="font-size:11px">#\${i+1}</span>\`);
    const posClass = i < 3 ? 'rank-pos top' : 'rank-pos';
    htmlHorarios += \`<tr>
      <td class="\${posClass}">\${pos}</td>
      <td class="rank-name">\${t.time}</td>
      <td class="rank-bar-td"><div class="rank-bar-wrap"><div class="rank-bar-fill rank-bar-time" style="width:\${pct}%"></div></div></td>
      <td class="rank-val">\${t.tks}<br><span class="rank-sub">\${sharePct}%</span></td>
    </tr>\`;
  });
  htmlHorarios += '</table>';
  document.getElementById('ranking-horarios').innerHTML = htmlHorarios;
}

function renderTable(events) {
  const filtered = events.filter(e =>
    e.name.toLowerCase().includes(_filter.toLowerCase()) && e.sold > 0
  );
  const sorted = [...filtered].sort((a, b) => _sortDir * (a[_sortCol] < b[_sortCol] ? -1 : 1));
  const tbody = document.getElementById('evTbody');
  if (!tbody) return;
  tbody.innerHTML = sorted.map(e => \`
    <tr>
      <td><strong>\${e.name}</strong></td>
      <td><span class="badge-sold">\${e.sold}</span></td>
      <td>\${fmtR(e.revenue)}</td>
      <td>\${e.purchases}</td>
      <td style="color:\${e.reserved > 0 ? '#f4a261' : 'inherit'}">\${e.reserved || 0}</td>
      <td style="color:\${e.cancelled > 0 ? '#e63946' : 'inherit'}">\${e.cancelled || 0}</td>
      <td>\${e.shows}</td>
    </tr>\`).join('');
}

function sortTable(col) {
  if (_sortCol === col) _sortDir *= -1; else { _sortCol = col; _sortDir = -1; }
  renderTable(_data?.events || []);
}
function filterTable(v) { _filter = v; renderTable(_data?.events || []); }

// ═══════════════════════════════════════════════════════════
// COMPARATIVO HISTÓRICO
// ═══════════════════════════════════════════════════════════
const HIST_DATA = [
  { year: 2015, vendas: 121231, receita: 6749049.30,  midia: 0,          total: 6749049.30,  comissao: 0,          midiaRir: 0,        terreno: 0,         totalRir: 0           },
  { year: 2017, vendas: 100983, receita: 10098300.00, midia: 1250000.00, total: 11348300.00, comissao: 403932.00,  midiaRir: 625000.00, terreno: 0,         totalRir: 1028932.00  },
  { year: 2019, vendas: 140852, receita: 13168520.00, midia: 1486305.00, total: 14654825.00, comissao: 534740.00,  midiaRir: 395475.00, terreno: 387342.52, totalRir: 1317557.52  },
  { year: 2022, vendas: 143518, receita: 17930255.00, midia: 333400.00,  total: 18263655.00, comissao: 1793025.50, midiaRir: 83350.00,  terreno: 701170.00, totalRir: 2577545.50  },
  { year: 2024, vendas: 157738, receita: 24190432.00, midia: 1994926.00, total: 26185358.00, comissao: 2419043.20, midiaRir: 498731.55, terreno: 753945.73, totalRir: 3671720.48  },
];

let _histCharts = {};

function openHistorico() {
  const modal = document.getElementById('hist-modal');
  modal.classList.remove('hidden');
  renderHistorico();
}
function closeHistorico() {
  document.getElementById('hist-modal').classList.add('hidden');
}

function renderHistorico() {
  // Build current-year row from live data
  const cur = _data ? {
    year: 2026,
    vendas:  _data.totalSold    || 0,
    receita: _data.totalRevenue || 0,
    midia:   null,  // não disponível via API
    total:   _data.totalRevenue || 0,
    comissao: null, midiaRir: null, terreno: null, totalRir: null
  } : null;

  const rows = cur ? [...HIST_DATA, cur] : HIST_DATA;

  // ── Charts ──────────────────────────────────────────────
  const COLORS = ['#5b8dee','#f4a261','#2ec27e','#9b59b6','#1abc9c','#e63946'];
  const labels = rows.map(r => String(r.year));

  const C = (id, cfg) => {
    if (_histCharts[id]) _histCharts[id].destroy();
    _histCharts[id] = new Chart(document.getElementById(id), cfg);
  };

  C('histTicketsChart', {
    type: 'bar',
    data: {
      labels,
      datasets: [{ data: rows.map(r => r.vendas),
        backgroundColor: rows.map((r,i) => r.year===2026 ? '#e63946cc' : COLORS[i]+'99'),
        borderColor: rows.map((r,i) => r.year===2026 ? '#e63946' : COLORS[i]),
        borderWidth: 2, borderRadius: 6 }]
    },
    options: { responsive:true, plugins:{ legend:{display:false},
      tooltip:{ callbacks:{ label: ctx => ' ' + Number(ctx.raw).toLocaleString('pt-BR') + ' ingressos' } } },
      scales:{ x:{ticks:{color:'#7a8499'},grid:{color:'#252d3d'}}, y:{ticks:{color:'#7a8499'},grid:{color:'#252d3d'}} } }
  });

  C('histRevenueChart', {
    type: 'bar',
    data: {
      labels,
      datasets: [{ data: rows.map(r => r.total),
        backgroundColor: rows.map((r,i) => r.year===2026 ? '#ffd70099' : COLORS[i]+'99'),
        borderColor: rows.map((r,i) => r.year===2026 ? '#ffd700' : COLORS[i]),
        borderWidth: 2, borderRadius: 6 }]
    },
    options: { responsive:true, plugins:{ legend:{display:false},
      tooltip:{ callbacks:{ label: ctx => ' R$ ' + Number(ctx.raw).toLocaleString('pt-BR',{minimumFractionDigits:0}) } } },
      scales:{ x:{ticks:{color:'#7a8499'},grid:{color:'#252d3d'}}, y:{ticks:{color:'#7a8499',callback: v => 'R$'+fmt(v)},grid:{color:'#252d3d'}} } }
  });

  // ── Table ────────────────────────────────────────────────
  function growth(curr, prev) {
    if (!prev || !curr) return '';
    const pct = ((curr - prev) / prev * 100).toFixed(1);
    const cls = pct >= 0 ? 'growth-pos' : 'growth-neg';
    return \`<span class="growth-badge \${cls}">\${pct >= 0 ? '+' : ''}\${pct}%</span>\`;
  }
  function fmtN(v) { return v == null ? '<span style="color:#5a6475">—</span>' : Number(v).toLocaleString('pt-BR', {minimumFractionDigits:0, maximumFractionDigits:0}); }
  function fmtMoney(v) { return v == null ? '<span style="color:#5a6475">—</span>' : 'R$ ' + Number(v).toLocaleString('pt-BR', {minimumFractionDigits:0}); }

  let html = \`<div style="overflow-x:auto"><table class="hist-table">
    <thead><tr>
      <th>Ano</th>
      <th colspan="3" style="text-align:center;border-bottom:2px solid #5b8dee;color:#5b8dee">PRIMEIRA CLASSE</th>
      <th></th>
      <th colspan="4" style="text-align:center;border-bottom:2px solid #f4a261;color:#f4a261">ROCK IN RIO (comissões)</th>
    </tr><tr>
      <th></th>
      <th>Ingressos</th><th>Receita (R$)</th><th>Total c/ Mídia</th>
      <th></th>
      <th>Comissão</th><th>Mídia</th><th>Terreno</th><th>Total RiR</th>
    </tr></thead><tbody>\`;

  rows.forEach((r, i) => {
    const prev = rows[i - 1];
    const isCur = r.year === 2026;
    html += \`<tr class="\${isCur ? 'current-year' : ''}">
      <td>\${r.year}\${isCur ? ' ⚡' : ''}</td>
      <td>\${fmtN(r.vendas)}\${prev ? growth(r.vendas, prev.vendas) : ''}</td>
      <td>\${fmtMoney(r.receita)}</td>
      <td>\${fmtMoney(r.total)}\${prev ? growth(r.total, prev.total) : ''}</td>
      <td></td>
      <td>\${fmtMoney(r.comissao)}</td>
      <td>\${fmtMoney(r.midiaRir)}</td>
      <td>\${fmtMoney(r.terreno)}</td>
      <td>\${fmtMoney(r.totalRir)}</td>
    </tr>\`;
  });

  html += '</tbody></table></div>';
  document.getElementById('hist-table-container').innerHTML = html;
}

// ═══════════════════════════════════════════════════════════
// XLS EXPORT
// ═══════════════════════════════════════════════════════════
function exportXLS() {
  if (!_rawShows.length) { alert('Nenhum dado disponível para exportar.'); return; }
  if (typeof XLSX === 'undefined') { alert('SheetJS carregando, tente em breve.'); return; }

  const wsData = [['ID Evento','Local','Produto','Data Festival','Horário Saída','Ingressos','Subtotal (R$)','Taxa (R$)','Total (R$)']];
  _rawShows.forEach(r => wsData.push([
    r.evId, r.local, 'Primeira Classe Rock in Rio - ' + r.local,
    r.date, r.time, r.tks, r.subtotal, r.taxa, +(r.subtotal + r.taxa).toFixed(2)
  ]));
  const totS = _rawShows.reduce((s,r)=>s+r.subtotal,0);
  const totT = _rawShows.reduce((s,r)=>s+r.taxa,0);
  wsData.push(['','','','','TOTAL',_rawShows.reduce((s,r)=>s+r.tks,0),+totS.toFixed(2),+totT.toFixed(2),+(totS+totT).toFixed(2)]);

  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = [{wch:10},{wch:32},{wch:42},{wch:14},{wch:12},{wch:10},{wch:14},{wch:12},{wch:14}];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Shows Detalhados');

  const sum = [['Local','Ingressos','Subtotal (R$)','Taxa (R$)','Total (R$)']];
  const bl = {};
  _rawShows.forEach(r => { if(!bl[r.local]) bl[r.local]={t:0,s:0,x:0}; bl[r.local].t+=r.tks; bl[r.local].s+=r.subtotal; bl[r.local].x+=r.taxa; });
  Object.entries(bl).sort((a,b)=>b[1].t-a[1].t).forEach(([l,v])=>sum.push([l,v.t,+v.s.toFixed(2),+v.x.toFixed(2),+(v.s+v.x).toFixed(2)]));
  const ws2 = XLSX.utils.aoa_to_sheet(sum);
  ws2['!cols'] = [{wch:32},{wch:12},{wch:14},{wch:12},{wch:14}];
  XLSX.utils.book_append_sheet(wb, ws2, 'Resumo por Local');

  XLSX.writeFile(wb, \`primeira-classe-rock-in-rio-\${new Date().toISOString().slice(0,10)}.xlsx\`);
}

// ═══════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════
loadData();
// Poll for updates every 60 seconds
setInterval(async () => {
  try {
    const res = await fetch('/api/data');
    const json = await res.json();
    updateStatusBar(json);
    if (json.data && json.lastRefresh) {
      const lr = new Date(json.lastRefresh);
      if (!_data || lr > new Date(0)) {
        _data = json.data;
        _rawShows = json.data.rawShows || [];
        renderAll();
      }
    }
  } catch(e) {}
}, 60000);
</script>
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

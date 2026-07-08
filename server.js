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
const PORT           = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// Users who can view the dashboard: "user1:pass1,user2:pass2"
const USERS = Object.fromEntries(
  (process.env.USERS || 'vinicius:RiR2026!')
    .split(',')
    .map(pair => {
      const idx = pair.trim().indexOf(':');
      if (idx < 0) return null;
      return [pair.trim().substring(0, idx), pair.trim().substring(idx + 1)];
    })
    .filter(Boolean)
);

// ─────────────────────────────────────────────
// CROWDER API CONFIG
// ─────────────────────────────────────────────
const CROWDER_BASE    = 'https://data.getcrowder.com';
// NOTA (2026-06-26): a Ticketmaster trocou a API e forneceu uma chave nova,
// mas essa chave nova não está trazendo o histórico anterior à sua criação
// (só mostra vendas recentes, a partir de hoje). A chave antiga continua
// ativa e tem todo o histórico. Solução temporária: buscar dados das DUAS
// chaves em refreshData() e mesclar (removendo duplicados por id), até a
// Ticketmaster confirmar que a chave nova já traz o histórico completo.
let CROWDER_API_KEY_OLD = process.env.CROWDER_API_KEY_OLD ||
  '0b666073629dd36b18cb760355b4daf7105a7a9cd1d338cd05f9723e971b78c9';
let CROWDER_API_KEY_NEW = process.env.CROWDER_API_KEY_NEW ||
  'fb2c661b2d309f7e6e0a83a02e0cfe54ab8fcdb15561d8457cc490f1679e2e15';
// Mantido por compatibilidade com código/endpoints que ainda referenciam uma
// única chave (ex: /health/rawapi) — aponta para a chave antiga (histórico).
let CROWDER_API_KEY = CROWDER_API_KEY_OLD;
// Filter: only include movements whose event name contains this string.
// Set to '' (empty) to include all events from the organizer.
const EVENT_NAME_FILTER = process.env.EVENT_NAME_FILTER || 'Rock in Rio';

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
let state = {
  data: null,           // Aggregated dashboard data
  lastRefresh: null,    // Date of last successful data fetch
  refreshing: false,
  error: null
};

// ─────────────────────────────────────────────
// CROWDER DATA AGGREGATION
// ─────────────────────────────────────────────
function aggregateCrowderData(movements, catalogShows = []) {
  const FESTIVAL_DATES = ['2026-09-04','2026-09-05','2026-09-06','2026-09-07',
                          '2026-09-11','2026-09-12','2026-09-13'];
  const DATE_LABELS    = ['Sex 04/Set','Sáb 05/Set','Dom 06/Set','Seg 07/Set',
                          'Sex 11/Set','Sáb 12/Set','Dom 13/Set'];

  // Filter only TICKET movements, optionally restricted to a specific event name
  const tickets = movements.filter(m =>
    m.concept === 'TICKET' &&
    (!EVENT_NAME_FILTER || (m.event && m.event.name && m.event.name.includes(EVENT_NAME_FILTER)))
  );

  const showMap = {};
  let totalSold = 0, totalRevenue = 0;
  let totalCancelled = 0, totalCancelledRevenue = 0;
  const byDate = {}, byTime = {}, salesByDate = {};
  FESTIVAL_DATES.forEach(d => { byDate[d] = 0; });

  for (const m of tickets) {
    const show   = m.tickets && m.tickets[0] ? m.tickets[0].show   : null;
    const sector = m.tickets && m.tickets[0] ? m.tickets[0].sector : null;
    const key    = `${show ? show.id : 'noshow'}_${m.product ? m.product.id : 'noprod'}`;

    if (!showMap[key]) {
      const startDate = show ? (show.startDate || '') : '';
      showMap[key] = {
        showId:      show ? show.id : null,
        productId:   m.product ? m.product.id : null,
        eventId:     m.event ? m.event.id : null,
        eventName:   m.event ? m.event.name : '',
        showName:    show ? show.name : '',
        productName: m.product ? m.product.name : '',
        sectorName:  sector ? sector.name : (m.product ? m.product.name : ''),
        startDate,
        date:        startDate.substring(0, 10),
        time:        startDate.substring(11, 16),
        tks: 0, subtotal: 0,
        cancelled: 0, cancelledRevenue: 0
      };
    }

    const entry = showMap[key];
    entry.tks      += m.ticketCount || 0;
    entry.subtotal += m.amount      || 0;

    if (m.operation === 'REFUND') {
      entry.cancelled        += Math.abs(m.ticketCount || 0);
      entry.cancelledRevenue += Math.abs(m.amount      || 0);
      totalCancelled         += Math.abs(m.ticketCount || 0);
      totalCancelledRevenue  += Math.abs(m.amount      || 0);
    }

    totalSold    += m.ticketCount || 0;
    totalRevenue += m.amount      || 0;

    // Accumulate by festival date/time (only positive movements)
    if ((m.ticketCount || 0) > 0) {
      const d = entry.date, t = entry.time;
      if (FESTIVAL_DATES.includes(d)) byDate[d] = (byDate[d] || 0) + (m.ticketCount || 0);
      if (t) byTime[t] = (byTime[t] || 0) + (m.ticketCount || 0);
    }

    // Accumulate by actual SALE date (purchase date, for day-by-day report)
    const saleDate = (m.date || '').substring(0, 10);
    if (saleDate) {
      if (!salesByDate[saleDate]) salesByDate[saleDate] = { tks: 0, revenue: 0 };
      salesByDate[saleDate].tks     += m.ticketCount || 0;
      salesByDate[saleDate].revenue += m.amount      || 0;
    }
  }

  // Build rawShows (dashboard-compatible format) — only shows with sales
  const rawShows = Object.values(showMap).map(s => ({
    evId:        s.showId,
    local:       s.showName || s.eventName,
    date:        s.date,
    time:        s.time,
    tks:         s.tks,
    subtotal:    s.subtotal,
    taxa:        s.subtotal * 0.10,
    // extra fields for richer display
    eventId:     s.eventId,
    eventName:   s.eventName,
    productName: s.productName,
    sectorName:  s.sectorName,
    cancelled:   s.cancelled,
    cancelledRevenue: s.cancelledRevenue
  }));

  // Build allShows: rawShows + catalog shows that had zero sales
  // Try to normalize catalog entries into the same shape
  const soldKeys = new Set(Object.keys(showMap)); // "showId_productId"
  const catalogExtra = catalogShows
    .filter(c => {
      // Determine the key to check if this show already has sales
      const sid = c.id || c.showId || c.show_id || null;
      const pid = (c.product && c.product.id) || c.productId || null;
      const k = `${sid}_${pid}`;
      return !soldKeys.has(k);
    })
    .map(c => {
      const startDate = c.startDate || c.start_date || c.date || '';
      const evName = (c.event && c.event.name) || c.eventName || c.event_name || '';
      return {
        evId:        c.id || c.showId || null,
        local:       c.name || c.showName || evName,
        date:        startDate.substring(0, 10),
        time:        startDate.substring(11, 16),
        tks:         0,
        subtotal:    0,
        taxa:        0,
        eventId:     (c.event && c.event.id) || c.eventId || null,
        eventName:   evName,
        productName: (c.product && c.product.name) || c.productName || '',
        sectorName:  (c.sector && c.sector.name) || c.sectorName || '',
        cancelled:   0,
        cancelledRevenue: 0
      };
    })
    .filter(c =>
      !EVENT_NAME_FILTER ||
      (c.eventName && c.eventName.includes(EVENT_NAME_FILTER)) ||
      (c.local && c.local.includes(EVENT_NAME_FILTER))
    );

  const allShows = [...rawShows, ...catalogExtra]
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

  // Aggregate per event for the events[] array used by the dashboard table
  const eventsMap = {};
  for (const s of rawShows) {
    const k = s.eventId || s.eventName || s.local;
    if (!eventsMap[k]) eventsMap[k] = {
      id: s.eventId, name: s.eventName || s.local,
      sold: 0, revenue: 0, cancelled: 0, cancelledRevenue: 0,
      reserved: 0, reservedRevenue: 0, purchases: 0, creditCard: 0, pix: 0, shows: 0
    };
    eventsMap[k].sold             += s.tks;
    eventsMap[k].revenue          += s.subtotal;
    eventsMap[k].cancelled        += s.cancelled        || 0;
    eventsMap[k].cancelledRevenue += s.cancelledRevenue || 0;
    eventsMap[k].shows++;
  }
  const events = Object.values(eventsMap);

  const byTimeArr = Object.entries(byTime)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([time, tks]) => ({ time, tks }));

  const byDateArr = FESTIVAL_DATES.map((date, i) => ({
    date, label: DATE_LABELS[i], tks: byDate[date] || 0
  }));

  // Build salesByDate sorted array for the day-by-day comparative export
  const salesByDateArr = Object.entries(salesByDate)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => ({ date, tks: v.tks, revenue: v.revenue }));

  return {
    rawShows, allShows, events, byDate: byDateArr, byTime: byTimeArr, heatmap: {},
    salesByDate: salesByDateArr,
    totalSold, totalRevenue,
    totalCancelled, totalCancelledRevenue,
    totalReserved: 0, totalReservedRevenue: 0
  };
}

// ─────────────────────────────────────────────
// DATA REFRESH (Crowder API with pagination)
// ─────────────────────────────────────────────
async function refreshData() {
  if (state.refreshing) return;
  state.refreshing = true;
  state.error = null;
  console.log(`[${new Date().toISOString()}] Iniciando refresh (Crowder API)...`);

  const globalTimeout = setTimeout(() => {
    if (state.refreshing) {
      state.refreshing = false;
      state.error = 'Timeout: refresh demorou mais de 3 minutos.';
      console.error('[refresh timeout] Abortado após 3 minutos.');
    }
  }, 3 * 60 * 1000);

  // Paginate through /activity/organizer fully for a single API key
  async function fetchAllMovements(apiKey, label) {
    const movements = [];
    let lastUpdate = 0, lastMovementId = 1, hasMore = true, pages = 0;
    while (hasMore) {
      const url = `${CROWDER_BASE}/activity/organizer?lastUpdate=${lastUpdate}&lastMovementId=${lastMovementId}`;
      const res = await fetch(url, { headers: { 'ApiKey': apiKey } });
      if (!res.ok) throw new Error(`Crowder API (${label}) HTTP ${res.status}: ${await res.text()}`);

      const json = await res.json();
      const batch = json.movements || [];
      movements.push(...batch);

      hasMore = json.hasMore === true;
      if (hasMore && batch.length > 0) {
        lastUpdate      = json.lastUpdate      || batch[batch.length - 1].lastUpdate;
        lastMovementId  = json.lastMovementId  || batch[batch.length - 1].id;
      }
      pages++;
      if (pages > 2000) { console.warn(`[refresh] (${label}) Safety limit: 2000 páginas`); break; }
    }
    console.log(`[refresh] (${label}) ${movements.length} movements em ${pages} página(s)`);
    return movements;
  }

  // Fetch the show catalog for a single API key
  async function fetchCatalog(apiKey, label) {
    try {
      const catRes = await fetch(`${CROWDER_BASE}/shows/organizer`, {
        headers: { 'ApiKey': apiKey }
      });
      if (!catRes.ok) {
        console.warn(`[refresh] (${label}) Catálogo shows: HTTP ${catRes.status}`);
        return [];
      }
      const catJson = await catRes.json();
      const raw = Array.isArray(catJson) ? catJson
                : (catJson.shows || catJson.data || catJson.results || []);
      const filtered = raw.filter(s =>
        !EVENT_NAME_FILTER ||
        (s.eventName && s.eventName.includes(EVENT_NAME_FILTER)) ||
        (s.event && s.event.name && s.event.name.includes(EVENT_NAME_FILTER)) ||
        (s.name && s.name.includes(EVENT_NAME_FILTER))
      );
      console.log(`[refresh] (${label}) Catálogo: ${filtered.length} shows`);
      return filtered;
    } catch (e) {
      console.warn(`[refresh] (${label}) Falha ao buscar catálogo de shows:`, e.message);
      return [];
    }
  }

  try {
    // ── Busca das DUAS chaves (antiga = histórico, nova = vendas recentes) ──
    // Solução temporária até a Ticketmaster confirmar que a chave nova já
    // traz o histórico completo. Mescla por id de movimento, sem duplicar.
    const keys = [
      { key: CROWDER_API_KEY_OLD, label: 'chave antiga' },
      { key: CROWDER_API_KEY_NEW, label: 'chave nova' }
    ].filter(k => k.key);

    const movementsByKey = await Promise.all(
      keys.map(k => fetchAllMovements(k.key, k.label).catch(e => {
        console.warn(`[refresh] (${k.label}) falhou:`, e.message);
        return [];
      }))
    );

    const seenIds = new Set();
    const allMovements = [];
    for (const batch of movementsByKey) {
      for (const m of batch) {
        const dedupKey = m.id != null ? m.id : JSON.stringify(m);
        if (seenIds.has(dedupKey)) continue;
        seenIds.add(dedupKey);
        allMovements.push(m);
      }
    }
    console.log(`[refresh] Total mesclado (sem duplicados): ${allMovements.length} movements`);

    // Catálogo de shows — mescla das duas chaves, dedup por showId/productId
    const catalogsByKey = await Promise.all(
      keys.map(k => fetchCatalog(k.key, k.label))
    );
    const seenCatalog = new Set();
    const catalogShows = [];
    for (const batch of catalogsByKey) {
      for (const c of batch) {
        const sid = c.id || c.showId || c.show_id || null;
        const pid = (c.product && c.product.id) || c.productId || null;
        const dedupKey = `${sid}_${pid}`;
        if (seenCatalog.has(dedupKey)) continue;
        seenCatalog.add(dedupKey);
        catalogShows.push(c);
      }
    }

    state.data        = aggregateCrowderData(allMovements, catalogShows);
    state.lastRefresh = new Date();
    console.log(`[${new Date().toISOString()}] Pronto. Total vendido: ${state.data.totalSold}`);

  } catch (err) {
    state.error = err.message;
    console.error('[refresh error]', err.message);
  } finally {
    state.refreshing = false;
    clearTimeout(globalTimeout);
  }
}

// Auto-refresh every 5 minutes
cron.schedule('*/5 * * * *', refreshData);

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

// ── Public: list loaded usernames (no passwords exposed) ────
app.get('/health/users', (req, res) => {
  res.json({ users: Object.keys(USERS), count: Object.keys(USERS).length });
});

// ── Debug: proxy Crowder shows catalog ──────
app.get('/api/debug/shows', requireAuth, async (req, res) => {
  try {
    const r = await fetch(`${CROWDER_BASE}/shows/organizer`, { headers: { 'ApiKey': CROWDER_API_KEY } });
    const text = await r.text();
    res.json({ status: r.status, body: text.substring(0, 5000) });
  } catch(e) {
    res.json({ error: e.message });
  }
});

// ── Public health check (no auth) ───────────
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    lastRefresh: state.lastRefresh,
    refreshing: state.refreshing,
    error: state.error,
    totalSold: state.data?.totalSold ?? null,
    totalRevenue: state.data?.totalRevenue ?? null,
    showCount: state.data?.rawShows?.length ?? null
  });
});

// ── Public: sales by date for spreadsheet export (no auth) ─
app.get('/health/salesbydate', (req, res) => {
  if (!state.data) return res.json({ ok: false, message: 'Sem dados ainda' });
  res.json({ ok: true, salesByDate: state.data.salesByDate || [] });
});

// ── Debug: check current Crowder API key status (auth required).
//    PII fields are stripped from any sample movement returned.
app.get('/health/rawapi', requireAuth, async (req, res) => {
  function redact(m) {
    if (!m || typeof m !== 'object') return m;
    const clone = JSON.parse(JSON.stringify(m));
    delete clone.purchase; delete clone.customer; delete clone.buyer;
    delete clone.payment; delete clone.card;
    if (clone.tickets) {
      clone.tickets = clone.tickets.map(t => {
        const tc = { ...t };
        delete tc.holder; delete tc.owner; delete tc.customer; delete tc.buyer;
        return tc;
      });
    }
    const piiKeys = ['name','firstName','lastName','document','cpf','email','gender','age','city','region','phone','cardBrand','cardNumber','last4','bin'];
    (function strip(obj) {
      if (!obj || typeof obj !== 'object') return;
      for (const k of Object.keys(obj)) {
        if (piiKeys.some(p => k.toLowerCase().includes(p.toLowerCase()))) {
          obj[k] = '[REDACTED]';
        } else if (typeof obj[k] === 'object') {
          strip(obj[k]);
        }
      }
    })(clone);
    return clone;
  }

  try {
    const url = `${CROWDER_BASE}/activity/organizer?lastUpdate=0&lastMovementId=1`;
    const r = await fetch(url, { headers: { 'ApiKey': CROWDER_API_KEY } });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    res.json({
      status: r.status,
      ok: r.ok,
      hasMore: json?.hasMore,
      lastUpdate: json?.lastUpdate,
      lastMovementId: json?.lastMovementId,
      movementsCount: json?.movements?.length ?? null,
      firstMovementDate: json?.movements?.[0]?.date ?? null,
      sampleMovement: redact(json?.movements?.[0] ?? null)
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ── Public debug: list unique events (no auth) ─
app.get('/health/events', (req, res) => {
  if (!state.data) return res.json({ ok: false, message: 'Sem dados ainda' });
  // Summarize unique events from rawShows
  const evMap = {};
  for (const s of state.data.rawShows) {
    const k = s.eventId || s.eventName || s.local;
    if (!evMap[k]) evMap[k] = { eventId: s.eventId, eventName: s.eventName, tks: 0, revenue: 0, shows: 0 };
    evMap[k].tks     += s.tks;
    evMap[k].revenue += s.subtotal;
    evMap[k].shows++;
  }
  res.json(Object.values(evMap).sort((a,b) => b.tks - a.tks));
});

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

// ── API: data endpoint ───────────────────────
app.get('/api/data', requireAuth, (req, res) => {
  res.json({
    data:        state.data,
    lastRefresh: state.lastRefresh,
    refreshing:  state.refreshing,
    error:       state.error
  });
});

app.post('/api/refresh', requireAuth, async (req, res) => {
  if (state.refreshing) return res.json({ ok: false, message: 'Já está atualizando...' });
  refreshData(); // fire and don't wait
  res.json({ ok: true, message: 'Atualização iniciada...' });
});

// ── Debug: force refresh ─────────────────────
app.get('/api/debug/refresh', requireAuth, async (req, res) => {
  try {
    await refreshData();
    res.json({ ok: true, totalSold: state.data?.totalSold, error: state.error });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: update Crowder API key at runtime ─
app.post('/admin/update-api-key', (req, res) => {
  const secret = req.headers['x-admin-secret'] || req.body?.adminSecret;
  if (!secret || secret !== (process.env.ADMIN_SECRET || 'rir-admin-2026')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { apiKey } = req.body || {};
  if (!apiKey || typeof apiKey !== 'string' || apiKey.length < 10) {
    return res.status(400).json({ error: 'apiKey inválida' });
  }
  CROWDER_API_KEY = apiKey;
  res.json({ ok: true, message: 'API key atualizada. Atualizando dados...' });
  refreshData();
});

// ── Dashboard (main page) ────────────────────
app.get('/', requireAuth, (req, res) => {
  res.send(getDashboardHTML(req.session.user));
});

// ── Sub-page: Tempo de Vendas ─────────────────
app.get('/tempo', requireAuth, (req, res) => {
  res.send(getTempoHTML(req.session.user));
});

// ── Sub-page: Produtos & Setores ─────────────
app.get('/perfil', requireAuth, (req, res) => {
  res.send(getPerfilHTML(req.session.user));
});

// ── Sub-page: Análise por Local ───────────────
app.get('/locais', requireAuth, (req, res) => {
  res.send(getLocaisHTML(req.session.user));
});

// ── Sub-page: Lista de Eventos ─────────────
app.get('/eventos', requireAuth, (req, res) => {
  res.send(getEventosHTML(req.session.user));
});

// ── Sub-page: Eventos Lotados ────────────────
app.get('/lotados', requireAuth, (req, res) => {
  res.send(getLotadosHTML(req.session.user));
});

// ─────────────────────────────────────────────
// SHARED CSS VARIABLES (dark theme)
// ─────────────────────────────────────────────
const SHARED_CSS_VARS = `
  :root {
    --bg:#0a0c10;--surface:#131720;--surface2:#1c2232;--border:#252d3d;
    --accent:#e63946;--accent2:#f4a261;--gold:#ffd700;--text:#e8eaf0;
    --muted:#7a8499;--green:#2ec27e;--blue:#5b8dee;--purple:#9b59b6;--teal:#1abc9c;
    --orange:#e8871a;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,-apple-system,sans-serif;min-height:100vh}
`;

const SHARED_HEADER_CSS = `
  header{background:linear-gradient(135deg,#0d1117 0%,#1a0a0f 50%,#0d1117 100%);
    border-bottom:1px solid var(--border);padding:18px 32px;
    display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px}
  .header-left{display:flex;align-items:center;gap:16px}
  .logo-badge{background:var(--accent);color:#fff;font-weight:800;font-size:11px;
    letter-spacing:2px;text-transform:uppercase;padding:6px 12px;border-radius:4px}
  header h1{font-size:18px;font-weight:700}
  header p{font-size:12px;color:var(--muted);margin-top:2px}
  .header-right{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .btn{border:none;padding:9px 16px;border-radius:8px;font-size:13px;font-weight:600;
    cursor:pointer;display:flex;align-items:center;gap:6px;transition:.2s;text-decoration:none}
  .btn-primary{background:var(--accent);color:#fff}
  .btn-primary:hover{background:#c62d3a;transform:translateY(-1px)}
  .btn-secondary{background:var(--surface2);color:var(--text);border:1px solid var(--border)}
  .btn-secondary:hover{background:var(--border)}
  .btn-back{background:var(--surface2);color:var(--muted);border:1px solid var(--border);font-size:12px}
  .btn-back:hover{color:var(--text);background:var(--border)}
  .btn svg{width:14px;height:14px}
  #status-bar{background:var(--surface);border-bottom:1px solid var(--border);
    padding:7px 32px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;font-size:12px}
  .status-dot{width:8px;height:8px;border-radius:50%;background:var(--muted);flex-shrink:0}
  .status-dot.green{background:var(--green)}
  .status-dot.yellow{background:var(--gold);animation:pulse 1.5s infinite}
  .status-dot.red{background:var(--accent)}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  #status-text{color:var(--muted)}
  #loading{position:fixed;inset:0;background:rgba(10,12,16,.88);display:flex;flex-direction:column;
    align-items:center;justify-content:center;gap:14px;z-index:9999;font-size:14px;color:var(--muted)}
  #loading.hidden{display:none}
  .spinner{width:38px;height:38px;border:3px solid var(--border);border-top-color:var(--accent);
    border-radius:50%;animation:spin .8s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .section-heading{padding:24px 32px 0;display:flex;align-items:center;gap:12px}
  .section-heading h2{font-size:16px;font-weight:700}
  .section-divider{flex:1;height:1px;background:var(--border)}
  .kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;padding:16px 32px 0}
  .kpi-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px 18px;position:relative;overflow:hidden}
  .kpi-card::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;border-radius:12px 12px 0 0}
  .kpi-card.red::before{background:var(--accent)} .kpi-card.gold::before{background:var(--gold)}
  .kpi-card.blue::before{background:var(--blue)}  .kpi-card.green::before{background:var(--green)}
  .kpi-card.purple::before{background:var(--purple)} .kpi-card.teal::before{background:var(--teal)}
  .kpi-label{font-size:10px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:var(--muted);margin-bottom:8px}
  .kpi-value{font-size:24px;font-weight:800;line-height:1}
  .kpi-sub{font-size:11px;color:var(--muted);margin-top:5px}
  .main-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;padding:18px 32px}
  .chart-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px;overflow:hidden}
  .chart-card.full{grid-column:1/-1}
  .chart-title{font-size:10px;font-weight:700;letter-spacing:1px;color:var(--muted);text-transform:uppercase;margin-bottom:4px}
  .chart-subtitle{font-size:15px;font-weight:700;margin-bottom:14px}
  @media(max-width:768px){
    header,.kpi-grid,.main-grid,.section-heading{padding-left:16px;padding-right:16px}
    .main-grid{grid-template-columns:1fr} .chart-card.full{grid-column:1}
    #status-bar{padding-left:16px;padding-right:16px}
  }
`;

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
${SHARED_CSS_VARS}
${SHARED_HEADER_CSS}
  :root {
    --bg:#0a0c10;--surface:#131720;--surface2:#1c2232;--border:#252d3d;
    --accent:#e63946;--accent2:#f4a261;--gold:#ffd700;--text:#e8eaf0;
    --muted:#7a8499;--green:#2ec27e;--blue:#5b8dee;--purple:#9b59b6;--teal:#1abc9c;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  /* ── HEATMAP ── */
  .heatmap-wrap{overflow-x:auto}
  .heatmap-table{border-collapse:collapse;min-width:100%}
  .heatmap-table th{padding:8px 12px;font-size:10px;font-weight:600;color:var(--muted);text-align:center;white-space:nowrap}
  .heatmap-table th.event-col{text-align:left;min-width:170px}
  .heatmap-table td{padding:5px 8px;font-size:11px;text-align:center;border:1px solid var(--border)}
  .heatmap-table td.event-name{text-align:left;font-weight:600;white-space:nowrap;background:var(--surface2)}
  .hm-cell{border-radius:4px;padding:3px 8px;font-weight:700;font-size:11px;display:inline-block;min-width:30px}
  /* ── EVENTS TABLE ── */
  .table-section{padding:0 32px 40px}
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
  .proj-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;padding:16px 32px 0}
  .proj-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px 18px;position:relative;overflow:hidden}
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
  .proj-settings{display:flex;align-items:center;gap:12px;padding:10px 32px 0;flex-wrap:wrap}
  .proj-input{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:6px 12px;color:var(--text);font-size:13px;width:80px;text-align:center;outline:none}
  .proj-input:focus{border-color:var(--accent)}
  .proj-input-label{font-size:12px;color:var(--muted)}
  /* ── RANKING ── */
  .ranking-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;padding:18px 32px}
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
  /* ── NAV CARDS ── */
  .nav-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;padding:20px 32px 0}
  .nav-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px 22px;
    text-decoration:none;color:var(--text);display:flex;align-items:center;gap:16px;transition:.2s;cursor:pointer}
  .nav-card:hover{border-color:var(--accent);background:var(--surface2);transform:translateY(-2px)}
  .nav-card-icon{font-size:28px;flex-shrink:0}
  .nav-card-title{font-size:14px;font-weight:700;margin-bottom:3px}
  .nav-card-desc{font-size:12px;color:var(--muted)}
  .nav-card-arrow{margin-left:auto;color:var(--muted);font-size:18px}
  @media(max-width:768px){
    header,.kpi-grid,.main-grid,.table-section,.section-heading,.ranking-grid,.nav-cards,.proj-grid,.proj-settings{padding-left:16px;padding-right:16px}
    .main-grid{grid-template-columns:1fr} .chart-card.full{grid-column:1}
    .ranking-grid{grid-template-columns:1fr}
    #status-bar{padding-left:16px;padding-right:16px}
  }
</style>
</head>
<body>

<div id="loading">
  <div class="spinner"></div>
  <span>Carregando dados do Crowder...</span>
</div>

<header>
  <div class="header-left">
    <div class="logo-badge">Rock in Rio 2026</div>
    <div>
      <h1>Primeira Classe — Dashboard de Vendas</h1>
      <p>Setembro 2026 · Logado como <strong>${username}</strong></p>
    </div>
  </div>
  <div class="header-right">
    <button class="btn btn-secondary" onclick="doRefresh()" id="refresh-btn">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
        <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
      </svg>
      Atualizar
    </button>
    <button class="btn btn-secondary" onclick="openHistorico()" id="hist-btn" style="border-color:#ffd700;color:#ffd700">📊 Histórico</button>
    <button class="btn" onclick="exportComparativo()" id="export-comp-btn" style="background:#2ec27e;color:#fff">↓ Comparativo</button>
    <button class="btn btn-primary" onclick="exportXLS()" id="export-btn">↓ XLS</button>
    <form method="POST" action="/logout" style="margin:0">
      <button class="btn btn-secondary" type="submit">Sair</button>
    </form>
  </div>
</header>

<div id="status-bar">
  <span class="status-dot" id="status-dot"></span>
  <span id="status-text">Conectando...</span>
</div>

<!-- NAV CARDS -->
<div class="nav-cards">
  <a href="/locais" class="nav-card" style="border-color:#e8871a44">
    <div class="nav-card-icon">📍</div>
    <div><div class="nav-card-title">Análise por Local</div><div class="nav-card-desc">Receita, ingressos, horários e lotação por ponto</div></div>
    <div class="nav-card-arrow">›</div>
  </a>
  <a href="/tempo" class="nav-card">
    <div class="nav-card-icon">📅</div>
    <div><div class="nav-card-title">Tempo de Vendas</div><div class="nav-card-desc">Análise por semana e dia da semana</div></div>
    <div class="nav-card-arrow">›</div>
  </a>
  <a href="/perfil" class="nav-card">
    <div class="nav-card-icon">🎟️</div>
    <div><div class="nav-card-title">Produtos & Setores</div><div class="nav-card-desc">Breakdown por setor, produto e show</div></div>
    <div class="nav-card-arrow">›</div>
  </a>
  <a href="/eventos" class="nav-card">
    <div class="nav-card-icon">🗓️</div>
    <div><div class="nav-card-title">Lista de Eventos</div><div class="nav-card-desc">Todos os shows com status de ocupação</div></div>
    <div class="nav-card-arrow">›</div>
  </a>
  <a href="/lotados" class="nav-card" style="border-color:#e6394644">
    <div class="nav-card-icon">🚨</div>
    <div><div class="nav-card-title">Eventos Lotados</div><div class="nav-card-desc">Horários esgotados e novos horários</div></div>
    <div class="nav-card-arrow">›</div>
  </a>
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
// TEMPO DE VENDAS PAGE
// ─────────────────────────────────────────────
function getTempoHTML(username) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tempo de Vendas — Rock in Rio 2026</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<style>
${SHARED_CSS_VARS}
${SHARED_HEADER_CSS}
  .content{padding:20px 32px 40px}
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:20px}
  .kpi{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;text-align:center}
  .kpi-icon{font-size:22px;margin-bottom:6px}
  .kpi-label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:4px;font-weight:700}
  .kpi-val{font-size:22px;font-weight:800;color:var(--orange)}
  .kpi-sub{font-size:11px;color:var(--muted);margin-top:3px}
  .kpi.blue .kpi-val{color:var(--blue)}.kpi.green .kpi-val{color:var(--green)}.kpi.gold .kpi-val{color:var(--gold)}.kpi.pink .kpi-val{color:#FF6B9D}
  .section{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px;margin-bottom:18px}
  .section-title{font-size:13px;font-weight:700;color:var(--orange);margin-bottom:14px;padding-bottom:8px;border-bottom:1px solid var(--border)}
  .charts-row{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:18px}
  .charts-row-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;margin-bottom:18px}
  .chart-wrap{position:relative;height:300px}
  .chart-wrap-tall{position:relative;height:380px}
  .table-scroll{max-height:400px;overflow-y:auto}
  .rank-table{width:100%;border-collapse:collapse;font-size:13px}
  .rank-table th{background:var(--surface2);color:var(--orange);padding:8px 12px;text-align:left;border-bottom:2px solid var(--border);font-size:11px;text-transform:uppercase}
  .rank-table td{padding:7px 12px;border-bottom:1px solid var(--border)}
  .rank-table tr:hover td{background:var(--surface2)}
  .num{color:var(--orange);font-weight:700}
  .bar-cell{display:flex;align-items:center;gap:6px}
  .bar-inline{height:10px;border-radius:3px;background:var(--orange);min-width:2px}
  @media(max-width:768px){.content{padding:16px}.charts-row,.charts-row-3{grid-template-columns:1fr}}
</style>
</head>
<body>
<div id="loading"><div class="spinner"></div><span>Carregando dados...</span></div>
<header>
  <div class="header-left">
    <a href="/" class="btn btn-back" style="text-decoration:none">← Voltar</a>
    <div class="logo-badge">Rock in Rio 2026</div>
    <div><h1>Tempo de Vendas</h1><p>Análise temporal das vendas de Primeira Classe</p></div>
  </div>
  <div class="header-right">
    <button class="btn btn-secondary" onclick="loadData()">↻ Atualizar</button>
    <form method="POST" action="/logout" style="margin:0"><button class="btn btn-secondary" type="submit">Sair</button></form>
  </div>
</header>
<div id="status-bar"><span class="status-dot" id="status-dot"></span><span id="status-text">Conectando...</span></div>
<div class="content">
  <div class="kpis">
    <div class="kpi gold"><div class="kpi-icon">📅</div><div class="kpi-label">Melhor Semana</div><div class="kpi-val" id="kpi-semana" style="font-size:14px">—</div><div class="kpi-sub" id="kpi-semana-n">—</div></div>
    <div class="kpi blue"><div class="kpi-icon">📆</div><div class="kpi-label">Melhor Dia da Semana</div><div class="kpi-val" id="kpi-dia">—</div><div class="kpi-sub" id="kpi-dia-n">—</div></div>
    <div class="kpi green"><div class="kpi-icon">🎫</div><div class="kpi-label">Total Ingressos</div><div class="kpi-val" id="kpi-total">—</div><div class="kpi-sub">registros</div></div>
    <div class="kpi pink"><div class="kpi-icon">⏳</div><div class="kpi-label">Dias até o Festival</div><div class="kpi-val" id="kpi-dias">—</div><div class="kpi-sub">até 04/09/2026</div></div>
  </div>

  <div class="section">
    <div class="section-title">📅 Vendas por Semana</div>
    <div class="chart-wrap-tall"><canvas id="chart-semanas"></canvas></div>
  </div>

  <div class="charts-row">
    <div class="section">
      <div class="section-title">📆 Vendas por Dia da Semana</div>
      <div class="chart-wrap"><canvas id="chart-diasemana"></canvas></div>
    </div>
    <div class="section">
      <div class="section-title">📈 Acumulado de Vendas</div>
      <div class="chart-wrap"><canvas id="chart-acumulado"></canvas></div>
    </div>
  </div>

  <div class="charts-row-3">
    <div class="section">
      <div class="section-title">🏆 Top Semanas</div>
      <div class="table-scroll"><table class="rank-table" id="tbl-semanas"><thead><tr><th>#</th><th>Semana</th><th>Ingressos</th></tr></thead><tbody></tbody></table></div>
    </div>
    <div class="section">
      <div class="section-title">🏆 Top Dias da Semana</div>
      <div class="table-scroll"><table class="rank-table" id="tbl-dias"><thead><tr><th>#</th><th>Dia</th><th>Ingressos</th></tr></thead><tbody></tbody></table></div>
    </div>
    <div class="section">
      <div class="section-title">📅 Últimos 10 Dias</div>
      <div class="table-scroll"><table class="rank-table" id="tbl-recent"><thead><tr><th>Data</th><th>Ingressos</th><th>Receita</th></tr></thead><tbody></tbody></table></div>
    </div>
  </div>
</div>
<script>
const DIAS = ['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];
const DIAS_C = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
const fmt = n => Number(n||0).toLocaleString('pt-BR');
const fmtR = n => 'R$ ' + Number(n||0).toLocaleString('pt-BR',{minimumFractionDigits:0,maximumFractionDigits:0});
let charts = {};
function mk(id, cfg){ if(charts[id])charts[id].destroy(); const c=document.getElementById(id); if(c)charts[id]=new Chart(c,cfg); }

function render(salesByDate) {
  const FESTIVAL = new Date('2026-09-04');
  // Sort by date
  const rows = [...salesByDate].sort((a,b)=>a.date.localeCompare(b.date)).filter(r=>r.tks>0);
  const total = rows.reduce((s,r)=>s+r.tks,0);
  const diasRestantes = Math.max(0, Math.ceil((FESTIVAL - new Date()) / 86400000));
  document.getElementById('kpi-total').textContent = fmt(total);
  document.getElementById('kpi-dias').textContent = diasRestantes;

  // Group by week
  const semMap = {};
  const diaMap = {}; DIAS.forEach(d=>diaMap[d]=0);
  rows.forEach(r => {
    const d = new Date(r.date+'T12:00:00');
    // week key: Monday of that week
    const dow = d.getDay();
    const diff = dow===0 ? -6 : 1-dow;
    const mon = new Date(d); mon.setDate(d.getDate()+diff);
    const key = mon.toISOString().substring(0,10);
    semMap[key] = (semMap[key]||0) + r.tks;
    diaMap[DIAS[d.getDay()]] += r.tks;
  });

  const semEntries = Object.entries(semMap).sort((a,b)=>a[0].localeCompare(b[0]));
  const semLabels = semEntries.map(([k])=>{const d=new Date(k+'T12:00:00');return d.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'});});
  const semVals = semEntries.map(([,v])=>v);
  const maxSem = Math.max(...semVals,1);

  // KPIs
  const bestSem = semEntries.sort((a,b)=>b[1]-a[1])[0];
  if(bestSem){ document.getElementById('kpi-semana').textContent = new Date(bestSem[0]+'T12:00:00').toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric'}); document.getElementById('kpi-semana-n').textContent = fmt(bestSem[1])+' ingressos'; }
  const bestDia = Object.entries(diaMap).sort((a,b)=>b[1]-a[1])[0];
  if(bestDia){ document.getElementById('kpi-dia').textContent = bestDia[0]; document.getElementById('kpi-dia-n').textContent = fmt(bestDia[1])+' ingressos'; }

  // Re-sort semEntries for chart
  const semSorted = Object.entries(semMap).sort((a,b)=>a[0].localeCompare(b[0]));
  const sLabels = semSorted.map(([k])=>{const d=new Date(k+'T12:00:00');return d.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'});});
  const sVals = semSorted.map(([,v])=>v);
  const maxS = Math.max(...sVals,1);
  const axisOpts = (color)=>({color:color||'#7a8499',grid:{color:'#252d3d'}});
  mk('chart-semanas',{type:'bar',data:{labels:sLabels,datasets:[{label:'Ingressos',data:sVals,backgroundColor:sVals.map(v=>v===maxS?'#ffd700':'#e8871a'),borderRadius:4}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>fmt(c.raw)+' ingressos'}}},scales:{x:{ticks:axisOpts(),grid:{color:'#252d3d'}},y:{ticks:{...axisOpts(),callback:v=>fmt(v)},grid:{color:'#252d3d'}}}}});

  const dVals = DIAS.map(d=>diaMap[d]||0);
  const maxD = Math.max(...dVals,1);
  mk('chart-diasemana',{type:'bar',data:{labels:DIAS_C,datasets:[{label:'Ingressos',data:dVals,backgroundColor:dVals.map(v=>v===maxD?'#ffd700':'#5b8dee'),borderRadius:4}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{ticks:axisOpts(),grid:{color:'#252d3d'}},y:{ticks:{...axisOpts(),callback:v=>fmt(v)},grid:{color:'#252d3d'}}}}});

  // Cumulative
  let cum=0;
  const cumLabels=[], cumVals=[];
  rows.forEach(r=>{cum+=r.tks; cumLabels.push(r.date.substring(5)); cumVals.push(cum);});
  mk('chart-acumulado',{type:'line',data:{labels:cumLabels,datasets:[{label:'Acumulado',data:cumVals,borderColor:'#2ec27e',backgroundColor:'rgba(46,194,126,.15)',fill:true,tension:.3,pointRadius:3,pointBackgroundColor:'#2ec27e'}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{ticks:{...axisOpts(),maxTicksLimit:8},grid:{color:'#252d3d'}},y:{ticks:{...axisOpts(),callback:v=>fmt(v)},grid:{color:'#252d3d'}}}}});

  // Rankings
  const rankSem = Object.entries(semMap).sort((a,b)=>b[1]-a[1]);
  document.querySelector('#tbl-semanas tbody').innerHTML = rankSem.slice(0,10).map(([k,n],i)=>
    \`<tr><td style="color:var(--muted)">\${i+1}</td><td style="font-size:12px">\${new Date(k+'T12:00:00').toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric'})}</td><td class="num">\${fmt(n)}</td></tr>\`).join('');
  const rankDias = DIAS.map(d=>[d,diaMap[d]||0]).sort((a,b)=>b[1]-a[1]);
  document.querySelector('#tbl-dias tbody').innerHTML = rankDias.map(([d,n],i)=>
    \`<tr><td style="color:var(--muted)">\${i+1}</td><td>\${d}</td><td class="num">\${fmt(n)}</td></tr>\`).join('');
  document.querySelector('#tbl-recent tbody').innerHTML = [...rows].slice(-10).reverse().map(r=>
    \`<tr><td style="font-size:12px">\${r.date}</td><td class="num">\${fmt(r.tks)}</td><td style="color:var(--muted);font-size:12px">\${fmtR(r.revenue)}</td></tr>\`).join('');
}

async function loadData() {
  try {
    const res = await fetch('/api/data');
    const json = await res.json();
    const d = json.data;
    if(!d) throw new Error('Sem dados');
    render(d.salesByDate||[]);
    const dot = document.getElementById('status-dot'); dot.className='status-dot green';
    document.getElementById('status-text').textContent = 'Dados ao vivo · Atualizado: '+(json.lastRefresh?new Date(json.lastRefresh).toLocaleString('pt-BR'):'—');
    document.getElementById('loading').classList.add('hidden');
  } catch(e) {
    document.getElementById('status-dot').className='status-dot red';
    document.getElementById('status-text').textContent='Erro: '+e.message;
    document.getElementById('loading').classList.add('hidden');
  }
}
document.addEventListener('DOMContentLoaded', loadData);
</script>
</body></html>`;
}

// ─────────────────────────────────────────────
// PRODUTOS & SETORES PAGE
// ─────────────────────────────────────────────
function getPerfilHTML(username) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Produtos & Setores — Rock in Rio 2026</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<style>
${SHARED_CSS_VARS}
${SHARED_HEADER_CSS}
  .content{padding:20px 32px 40px}
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:20px}
  .kpi{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;text-align:center}
  .kpi-icon{font-size:22px;margin-bottom:6px}
  .kpi-label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:4px;font-weight:700}
  .kpi-val{font-size:22px;font-weight:800;color:var(--accent)}
  .kpi-sub{font-size:11px;color:var(--muted);margin-top:3px}
  .kpi.blue .kpi-val{color:var(--blue)}.kpi.green .kpi-val{color:var(--green)}.kpi.gold .kpi-val{color:var(--gold)}
  .section{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px;margin-bottom:18px}
  .section-title{font-size:13px;font-weight:700;color:var(--accent);margin-bottom:14px;padding-bottom:8px;border-bottom:1px solid var(--border)}
  .charts-row{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:18px}
  .charts-row-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;margin-bottom:18px}
  .chart-wrap{position:relative;height:300px}
  .chart-wrap-sm{position:relative;height:240px}
  .chart-wrap-tall{position:relative;height:380px}
  .table-scroll{max-height:380px;overflow-y:auto}
  .data-table{width:100%;border-collapse:collapse;font-size:13px}
  .data-table th{background:var(--surface2);padding:9px 12px;text-align:left;border-bottom:2px solid var(--border);font-size:11px;text-transform:uppercase;color:var(--muted)}
  .data-table td{padding:8px 12px;border-bottom:1px solid var(--border)}
  .data-table tr:hover td{background:var(--surface2)}
  .num{color:var(--green);font-weight:700}
  .rev{color:var(--muted);font-size:12px}
  @media(max-width:768px){.content{padding:16px}.charts-row,.charts-row-3{grid-template-columns:1fr}}
</style>
</head>
<body>
<div id="loading"><div class="spinner"></div><span>Carregando dados...</span></div>
<header>
  <div class="header-left">
    <a href="/" class="btn btn-back" style="text-decoration:none">← Voltar</a>
    <div class="logo-badge">Rock in Rio 2026</div>
    <div><h1>Produtos & Setores</h1><p>Breakdown de vendas por setor, produto e data do show</p></div>
  </div>
  <div class="header-right">
    <button class="btn btn-secondary" onclick="loadData()">↻ Atualizar</button>
    <form method="POST" action="/logout" style="margin:0"><button class="btn btn-secondary" type="submit">Sair</button></form>
  </div>
</header>
<div id="status-bar"><span class="status-dot" id="status-dot"></span><span id="status-text">Conectando...</span></div>
<div class="content">
  <div class="kpis">
    <div class="kpi"><div class="kpi-icon">🎫</div><div class="kpi-label">Total Vendido</div><div class="kpi-val" id="kpi-total">—</div><div class="kpi-sub">ingressos</div></div>
    <div class="kpi green"><div class="kpi-icon">💰</div><div class="kpi-label">Receita Total</div><div class="kpi-val" id="kpi-receita" style="font-size:16px">—</div></div>
    <div class="kpi gold"><div class="kpi-icon">🏆</div><div class="kpi-label">Top Setor</div><div class="kpi-val" id="kpi-top-setor" style="font-size:15px">—</div><div class="kpi-sub" id="kpi-top-setor-n">—</div></div>
    <div class="kpi blue"><div class="kpi-icon">🎪</div><div class="kpi-label">Top Show</div><div class="kpi-val" id="kpi-top-show" style="font-size:13px">—</div><div class="kpi-sub" id="kpi-top-show-n">—</div></div>
  </div>

  <div class="charts-row">
    <div class="section">
      <div class="section-title">🎪 Ingressos por Show / Data</div>
      <div class="chart-wrap-tall"><canvas id="chart-shows"></canvas></div>
    </div>
    <div class="section">
      <div class="section-title">🎟️ Ingressos por Setor</div>
      <div class="chart-wrap-tall"><canvas id="chart-setores"></canvas></div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">📦 Top Produtos</div>
    <div class="chart-wrap" style="height:260px"><canvas id="chart-produtos"></canvas></div>
  </div>

  <div class="section">
    <div class="section-title">📋 Detalhamento por Produto</div>
    <div class="table-scroll">
      <table class="data-table" id="tbl-produtos">
        <thead><tr><th>#</th><th>Produto / Setor</th><th>Show</th><th>Ingressos</th><th>Receita</th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
  </div>
</div>
<script>
const fmt = n => Number(n||0).toLocaleString('pt-BR');
const fmtR = n => 'R$ '+Number(n||0).toLocaleString('pt-BR',{minimumFractionDigits:0,maximumFractionDigits:0});
let charts = {};
function mk(id,cfg){if(charts[id])charts[id].destroy();const c=document.getElementById(id);if(c)charts[id]=new Chart(c,cfg);}
const PALETTE = ['#e63946','#5b8dee','#2ec27e','#ffd700','#f4a261','#9b59b6','#1abc9c','#e67e22','#3498db','#e74c3c','#2ecc71','#f39c12'];

function render(rawShows) {
  const shows = rawShows.filter(s=>s.tks>0);
  const totalTks = shows.reduce((s,r)=>s+r.tks,0);
  const totalRev = shows.reduce((s,r)=>s+(r.subtotal||0),0);
  document.getElementById('kpi-total').textContent = fmt(totalTks);
  document.getElementById('kpi-receita').textContent = fmtR(totalRev);

  // By show/date
  const showMap = {};
  shows.forEach(s=>{
    const k = (s.showName||s.local||'Outro')+' ('+( s.date||'?')+')';
    if(!showMap[k])showMap[k]={tks:0,rev:0};
    showMap[k].tks+=s.tks; showMap[k].rev+=(s.subtotal||0);
  });
  const showEntries = Object.entries(showMap).sort((a,b)=>b[1].tks-a[1].tks);
  const topShow = showEntries[0];
  if(topShow){document.getElementById('kpi-top-show').textContent=topShow[0].substring(0,22);document.getElementById('kpi-top-show-n').textContent=fmt(topShow[1].tks)+' ing.';}

  const showLabels = showEntries.slice(0,12).map(([k])=>k.length>28?k.substring(0,28)+'…':k);
  const showVals = showEntries.slice(0,12).map(([,v])=>v.tks);
  mk('chart-shows',{type:'bar',data:{labels:showLabels,datasets:[{data:showVals,backgroundColor:PALETTE,borderRadius:4}]},options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>fmt(c.raw)+' ingressos'}}},scales:{x:{ticks:{color:'#7a8499',callback:v=>fmt(v)},grid:{color:'#252d3d'}},y:{ticks:{color:'#e8eaf0',font:{size:11}},grid:{color:'#252d3d'}}}}});

  // By setor
  const setorMap = {};
  shows.forEach(s=>{const k=s.sectorName||s.productName||'Outro';if(!setorMap[k])setorMap[k]=0;setorMap[k]+=s.tks;});
  const setorEntries = Object.entries(setorMap).sort((a,b)=>b[1]-a[1]);
  const topSetor = setorEntries[0];
  if(topSetor){document.getElementById('kpi-top-setor').textContent=topSetor[0].substring(0,18);document.getElementById('kpi-top-setor-n').textContent=fmt(topSetor[1])+' ingressos';}
  mk('chart-setores',{type:'doughnut',data:{labels:setorEntries.map(([k])=>k.length>22?k.substring(0,22)+'…':k),datasets:[{data:setorEntries.map(([,v])=>v),backgroundColor:PALETTE,borderWidth:2,borderColor:'#131720'}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'right',labels:{color:'#e8eaf0',font:{size:11},boxWidth:14}},tooltip:{callbacks:{label:c=>fmt(c.raw)+' ingressos'}}}}});

  // By product
  const prodMap = {};
  shows.forEach(s=>{const k=s.productName||s.sectorName||'Outro';if(!prodMap[k])prodMap[k]={tks:0,rev:0};prodMap[k].tks+=s.tks;prodMap[k].rev+=(s.subtotal||0);});
  const prodEntries = Object.entries(prodMap).sort((a,b)=>b[1].tks-a[1].tks);
  const pLabels = prodEntries.slice(0,10).map(([k])=>k.length>30?k.substring(0,30)+'…':k);
  const pVals = prodEntries.slice(0,10).map(([,v])=>v.tks);
  const maxP = Math.max(...pVals,1);
  mk('chart-produtos',{type:'bar',data:{labels:pLabels,datasets:[{data:pVals,backgroundColor:pVals.map(v=>v===maxP?'#ffd700':'#5b8dee'),borderRadius:4}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>fmt(c.raw)+' ingressos'}}},scales:{x:{ticks:{color:'#7a8499',font:{size:10},maxRotation:30},grid:{color:'#252d3d'}},y:{ticks:{color:'#7a8499',callback:v=>fmt(v)},grid:{color:'#252d3d'}}}}});

  // Table
  document.querySelector('#tbl-produtos tbody').innerHTML = shows
    .sort((a,b)=>b.tks-a.tks)
    .map((s,i)=>\`<tr><td style="color:var(--muted)">\${i+1}</td><td style="font-weight:600">\${(s.productName||s.sectorName||'—').substring(0,30)}</td><td style="color:var(--muted);font-size:12px">\${(s.showName||s.local||'—').substring(0,25)}</td><td class="num">\${fmt(s.tks)}</td><td class="rev">\${fmtR(s.subtotal||0)}</td></tr>\`)
    .join('');
}

async function loadData() {
  try {
    const res = await fetch('/api/data');
    const json = await res.json();
    const d = json.data;
    if(!d) throw new Error('Sem dados');
    render(d.rawShows||[]);
    document.getElementById('status-dot').className='status-dot green';
    document.getElementById('status-text').textContent='Dados ao vivo · '+(json.lastRefresh?new Date(json.lastRefresh).toLocaleString('pt-BR'):'—');
    document.getElementById('loading').classList.add('hidden');
  } catch(e) {
    document.getElementById('status-dot').className='status-dot red';
    document.getElementById('status-text').textContent='Erro: '+e.message;
    document.getElementById('loading').classList.add('hidden');
  }
}
document.addEventListener('DOMContentLoaded', loadData);
</script>
</body></html>`;
}

// ─────────────────────────────────────────────
// LISTA DE EVENTOS PAGE
// ─────────────────────────────────────────────
function getEventosHTML(username) {
  // Capacidades conhecidas por produto/setor (ingressos disponíveis)
  // Ajuste conforme necessário
  const CAPACIDADES = {
    'Primeira Classe - Sexta': 500,
    'Primeira Classe - Sábado': 500,
    'Primeira Classe - Domingo': 500,
    'Primeira Classe - Segunda': 500,
    'Primeira Classe - Quinta': 500,
    'Primeira Classe - Sexta 2': 500,
    'Primeira Classe - Sábado 2': 500,
  };
  const DEFAULT_CAP = 46; // capacidade padrão por produto/horário

  const FESTIVAL_DATES = ['2026-09-04','2026-09-05','2026-09-06','2026-09-07',
                          '2026-09-11','2026-09-12','2026-09-13'];
  const DATE_LABELS = {
    '2026-09-04': 'Sexta-feira, 04 de Setembro',
    '2026-09-05': 'Sábado, 05 de Setembro',
    '2026-09-06': 'Domingo, 06 de Setembro',
    '2026-09-07': 'Segunda-feira, 07 de Setembro',
    '2026-09-11': 'Sexta-feira, 11 de Setembro',
    '2026-09-12': 'Sábado, 12 de Setembro',
    '2026-09-13': 'Domingo, 13 de Setembro',
  };

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Lista de Eventos — Rock in Rio 2026</title>
<style>
${SHARED_CSS_VARS}
${SHARED_HEADER_CSS}
  .page-wrap{padding:20px 32px 48px}
  .day-section{margin-bottom:32px}
  .day-header{display:flex;align-items:center;gap:14px;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid var(--border)}
  .day-badge{background:var(--accent);color:#fff;font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;padding:5px 12px;border-radius:6px;flex-shrink:0}
  .day-title{font-size:17px;font-weight:700}
  .day-stats{margin-left:auto;font-size:12px;color:var(--muted);text-align:right}
  .day-stats strong{color:var(--text)}

  .events-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
  .event-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px 18px;position:relative;overflow:hidden;transition:.2s}
  .event-card:hover{border-color:var(--border);transform:translateY(-1px)}
  .event-card.alert-critical{border-color:#e63946;box-shadow:0 0 0 1px #e6394633}
  .event-card.alert-warning{border-color:#f4a261;box-shadow:0 0 0 1px #f4a26133}
  .event-card.alert-ok{border-color:var(--border)}

  .event-header{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:12px}
  .event-name{font-size:13px;font-weight:700;line-height:1.3;flex:1}
  .alert-badge{font-size:10px;font-weight:800;letter-spacing:.8px;text-transform:uppercase;padding:3px 8px;border-radius:4px;flex-shrink:0;white-space:nowrap}
  .alert-badge.critical{background:#e6394622;color:#e63946;border:1px solid #e6394644}
  .alert-badge.warning{background:#f4a26122;color:#f4a261;border:1px solid #f4a26144}
  .alert-badge.ok{background:#2ec27e22;color:#2ec27e;border:1px solid #2ec27e44}
  .alert-badge.no-data{background:var(--surface2);color:var(--muted);border:1px solid var(--border)}

  .event-meta{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--muted);margin-bottom:12px}
  .meta-sep{color:var(--border)}

  .progress-wrap{margin-bottom:10px}
  .progress-label{display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-bottom:5px}
  .progress-label strong{color:var(--text);font-size:12px}
  .progress-bar{height:6px;background:var(--surface2);border-radius:3px;overflow:hidden}
  .progress-fill{height:100%;border-radius:3px;transition:width .4s ease}
  .progress-fill.critical{background:var(--accent)}
  .progress-fill.warning{background:var(--accent2)}
  .progress-fill.ok{background:var(--green)}
  .progress-fill.no-data{background:var(--muted)}

  .event-stats{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  .stat-item{background:var(--surface2);border-radius:8px;padding:8px 10px}
  .stat-label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:2px}
  .stat-value{font-size:15px;font-weight:700}
  .stat-value.red{color:var(--accent)}
  .stat-value.green{color:var(--green)}
  .stat-value.muted{color:var(--muted)}

  .summary-bar{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 20px;
    display:flex;gap:24px;flex-wrap:wrap;align-items:center;margin-bottom:24px}
  .summary-item{display:flex;flex-direction:column;gap:2px}
  .summary-label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px}
  .summary-value{font-size:18px;font-weight:800}
  .summary-sep{width:1px;background:var(--border);align-self:stretch}

  .legend{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:20px}
  .legend-item{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted)}
  .legend-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}

  .no-data-msg{text-align:center;padding:60px 20px;color:var(--muted);font-size:14px}

  @media(max-width:768px){
    .page-wrap{padding:16px 16px 40px}
    .events-grid{grid-template-columns:1fr}
    .summary-bar{gap:16px}
  }
</style>
</head>
<body>
<div id="loading"><div class="spinner"></div><span>Carregando eventos...</span></div>

<header>
  <div class="header-left">
    <div class="logo-badge">RiR 2026</div>
    <div><h1>Lista de Eventos</h1><p>Ocupação e disponibilidade por show</p></div>
  </div>
  <div class="header-right">
    <a href="/" class="btn btn-back">← Voltar ao Dashboard</a>
  </div>
</header>
<div id="status-bar">
  <div id="status-dot" class="status-dot"></div>
  <span id="status-text">Carregando...</span>
</div>

<div class="page-wrap" id="app">
  <!-- preenchido por JS -->
</div>

<script>
const DEFAULT_CAP = 46;
const CAPS = ${JSON.stringify(CAPACIDADES)};

const FESTIVAL_DATES = ${JSON.stringify(FESTIVAL_DATES)};
const DATE_LABELS = ${JSON.stringify(DATE_LABELS)};

function fmt(n) { return (n||0).toLocaleString('pt-BR'); }
function fmtR(n) { return 'R$ '+(n||0).toLocaleString('pt-BR',{minimumFractionDigits:0,maximumFractionDigits:0}); }
function fmtPct(pct) { return pct.toFixed(1)+'%'; }

function getCapacity(show) {
  // Try to match by show name / product name
  for (const [k,v] of Object.entries(CAPS)) {
    if ((show.local||'').toLowerCase().includes(k.toLowerCase()) ||
        (show.productName||'').toLowerCase().includes(k.toLowerCase())) return v;
  }
  return DEFAULT_CAP;
}

function alertLevel(sold, cap) {
  if (!cap) return 'no-data';
  const pct = sold / cap * 100;
  if (pct >= 90) return 'critical';
  if (pct >= 80) return 'warning';
  return 'ok';
}
function alertLabel(level) {
  if (level === 'critical') return '🚨 LOTAÇÃO CRÍTICA';
  if (level === 'warning')  return '⚠️ QUASE ESGOTADO';
  if (level === 'ok')       return '✓ DISPONÍVEL';
  return '— SEM CAPACIDADE';
}

function render(rawShows) {
  if (!rawShows || rawShows.length === 0) {
    document.getElementById('app').innerHTML = '<div class="no-data-msg">Nenhum evento encontrado.</div>';
    return;
  }

  // Group by festival date
  const byDate = {};
  FESTIVAL_DATES.forEach(d => { byDate[d] = []; });
  const other = [];

  for (const s of rawShows) {
    if (s.tks <= 0) continue; // skip zeroed/refunded
    if (byDate[s.date] !== undefined) byDate[s.date].push(s);
    else other.push(s);
  }

  // Sort shows within each day by time then name
  for (const d of FESTIVAL_DATES) {
    byDate[d].sort((a,b) => (a.time||'').localeCompare(b.time||'') || (a.local||'').localeCompare(b.local||''));
  }

  // Global summary
  const totalShows = rawShows.filter(s=>s.tks>0).length;
  const totalSold  = rawShows.reduce((s,r)=>s+(r.tks||0),0);
  const alertCount = rawShows.filter(s=>{
    const level = alertLevel(s.tks, getCapacity(s));
    return level==='critical'||level==='warning';
  }).length;
  const totalCap = totalShows * DEFAULT_CAP;

  let html = \`
  <div class="summary-bar">
    <div class="summary-item"><div class="summary-label">Total de Produtos</div><div class="summary-value">\${fmt(totalShows)}</div></div>
    <div class="summary-sep"></div>
    <div class="summary-item"><div class="summary-label">Ingressos Vendidos</div><div class="summary-value" style="color:var(--green)">\${fmt(totalSold)}</div></div>
    <div class="summary-sep"></div>
    <div class="summary-item"><div class="summary-label">Alertas de Ocupação</div><div class="summary-value" style="color:\${alertCount>0?'var(--accent)':'var(--muted)'}">\${alertCount}</div></div>
  </div>
  <div class="legend">
    <div class="legend-item"><div class="legend-dot" style="background:var(--accent)"></div>≥ 90% — Lotação crítica</div>
    <div class="legend-item"><div class="legend-dot" style="background:var(--accent2)"></div>≥ 80% — Quase esgotado</div>
    <div class="legend-item"><div class="legend-dot" style="background:var(--green)"></div>< 80% — Disponível</div>
  </div>\`;

  for (const d of FESTIVAL_DATES) {
    const shows = byDate[d];
    if (shows.length === 0) continue;

    const daySold = shows.reduce((s,r)=>s+(r.tks||0),0);
    const dayAlerts = shows.filter(s=>{const l=alertLevel(s.tks,getCapacity(s));return l==='critical'||l==='warning';}).length;

    html += \`<div class="day-section">
    <div class="day-header">
      <div class="day-badge">\${d.split('-')[2]+'/'+d.split('-')[1]}</div>
      <div class="day-title">\${DATE_LABELS[d]||d}</div>
      <div class="day-stats"><strong>\${fmt(daySold)}</strong> vendidos\${dayAlerts>0?' &nbsp;·&nbsp; <span style="color:var(--accent)">'+dayAlerts+' alerta'+(dayAlerts>1?'s':'')+'</span>':''}</div>
    </div>
    <div class="events-grid">\`;

    for (const s of shows) {
      const cap   = getCapacity(s);
      const sold  = s.tks || 0;
      const pct   = cap ? Math.min(sold / cap * 100, 100) : null;
      const level = alertLevel(sold, cap);
      const avail = cap ? Math.max(cap - sold, 0) : null;

      html += \`<div class="event-card alert-\${level}">
        <div class="event-header">
          <div class="event-name">\${s.productName || s.local || s.sectorName || '—'}</div>
          <div class="alert-badge \${level}">\${alertLabel(level)}</div>
        </div>
        <div class="event-meta">
          <span>🕐 \${s.time||'—'}</span>
          <span class="meta-sep">·</span>
          <span>\${s.sectorName||s.local||'—'}</span>
        </div>
        \${cap ? \`<div class="progress-wrap">
          <div class="progress-label">
            <span>Ocupação</span>
            <strong>\${fmtPct(pct)}</strong>
          </div>
          <div class="progress-bar">
            <div class="progress-fill \${level}" style="width:\${pct}%"></div>
          </div>
        </div>\` : ''}
        <div class="event-stats">
          <div class="stat-item">
            <div class="stat-label">Vendidos</div>
            <div class="stat-value green">\${fmt(sold)}</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">Disponíveis</div>
            <div class="stat-value \${avail===null?'muted':avail===0?'red':''}">\${avail===null?'N/D':fmt(avail)}</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">Cancelados</div>
            <div class="stat-value \${(s.cancelled||0)>0?'red':'muted'}">\${fmt(s.cancelled||0)}</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">Receita</div>
            <div class="stat-value">\${fmtR(s.subtotal||0)}</div>
          </div>
        </div>
      </div>\`;
    }

    html += '</div></div>';
  }

  document.getElementById('app').innerHTML = html;
}

async function loadData() {
  try {
    const res  = await fetch('/api/data');
    const json = await res.json();
    const d    = json.data;
    if (!d) throw new Error('Sem dados');
    render(d.rawShows || []);
    document.getElementById('status-dot').className = 'status-dot green';
    document.getElementById('status-text').textContent = 'Dados ao vivo · ' + (json.lastRefresh ? new Date(json.lastRefresh).toLocaleString('pt-BR') : '—');
    document.getElementById('loading').classList.add('hidden');
  } catch(e) {
    document.getElementById('status-dot').className = 'status-dot red';
    document.getElementById('status-text').textContent = 'Erro: ' + e.message;
    document.getElementById('loading').classList.add('hidden');
  }
}
document.addEventListener('DOMContentLoaded', loadData);
</script>
</body></html>`;
}

// ─────────────────────────────────────────────
// SUB-PAGE: EVENTOS LOTADOS
// ─────────────────────────────────────────────
function getLotadosHTML(username) {
  const FESTIVAL_DATES = ['2026-09-04','2026-09-05','2026-09-06','2026-09-07',
                          '2026-09-11','2026-09-12','2026-09-13'];
  const DATE_LABELS = {
    '2026-09-04':'Sex 04/Set','2026-09-05':'Sáb 05/Set','2026-09-06':'Dom 06/Set',
    '2026-09-07':'Seg 07/Set','2026-09-11':'Sex 11/Set','2026-09-12':'Sáb 12/Set',
    '2026-09-13':'Dom 13/Set'
  };
  const CAP = 46;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Eventos Lotados — Rock in Rio 2026</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"><\/script>
<style>
${SHARED_CSS_VARS}
${SHARED_HEADER_CSS}
  .page-wrap{padding:20px 32px 48px}
  .section-title{font-size:18px;font-weight:800;margin-bottom:6px;display:flex;align-items:center;gap:10px}
  .section-sub{font-size:13px;color:var(--muted);margin-bottom:20px}
  .summary-bar{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 20px;
    display:flex;gap:24px;flex-wrap:wrap;align-items:center;margin-bottom:24px}
  .summary-item{display:flex;flex-direction:column;gap:2px}
  .summary-label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px}
  .summary-value{font-size:20px;font-weight:800}
  .summary-sep{width:1px;background:var(--border);align-self:stretch}

  .lotados-table{width:100%;border-collapse:collapse;margin-bottom:32px;font-size:13px}
  .lotados-table th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:var(--muted);
    padding:8px 12px;border-bottom:1px solid var(--border);white-space:nowrap}
  .lotados-table td{padding:10px 12px;border-bottom:1px solid #1e2535;vertical-align:middle}
  .lotados-table tr:hover td{background:var(--surface2)}
  .tag-date{background:var(--surface2);border:1px solid var(--border);border-radius:5px;padding:2px 8px;font-size:11px;font-weight:700;white-space:nowrap}
  .tag-time{font-family:monospace;font-size:13px;font-weight:700;color:var(--text)}
  .tag-new{font-family:monospace;font-size:13px;font-weight:700;color:#2ec27e}
  .badge-lotado{background:#e6394622;color:#e63946;border:1px solid #e6394644;border-radius:4px;
    font-size:10px;font-weight:800;letter-spacing:.8px;padding:2px 7px;text-transform:uppercase}
  .btn-aceitar{background:#2ec27e22;color:#2ec27e;border:1px solid #2ec27e55;border-radius:7px;
    font-size:12px;font-weight:700;padding:6px 16px;cursor:pointer;transition:.2s;white-space:nowrap}
  .btn-aceitar:hover{background:#2ec27e33;border-color:#2ec27e}
  .btn-aceitar.aceito{background:#2ec27e;color:#000;border-color:#2ec27e;cursor:default}
  .btn-aceitar.aceito:hover{background:#2ec27e}
  .btn-negar{background:#e6394622;color:#e63946;border:1px solid #e6394655;border-radius:7px;
    font-size:12px;font-weight:700;padding:6px 14px;cursor:pointer;transition:.2s;white-space:nowrap}
  .btn-negar:hover{background:#e6394633;border-color:#e63946}

  .aceitos-section{background:var(--surface);border:1px solid #2ec27e44;border-radius:14px;padding:24px;margin-top:8px}
  .aceitos-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:10px}
  .aceitos-title{font-size:16px;font-weight:800;color:#2ec27e;display:flex;align-items:center;gap:8px}
  .aceitos-actions{display:flex;gap:10px;flex-wrap:wrap}
  .btn-export{background:#5b8dee22;color:#5b8dee;border:1px solid #5b8dee55;border-radius:8px;
    font-size:13px;font-weight:700;padding:8px 20px;cursor:pointer;transition:.2s}
  .btn-export:hover{background:#5b8dee33}
  .btn-limpar{background:var(--surface2);color:var(--muted);border:1px solid var(--border);border-radius:8px;
    font-size:13px;font-weight:600;padding:8px 16px;cursor:pointer;transition:.2s}
  .btn-limpar:hover{color:var(--accent);border-color:var(--accent)}
  .aceitos-table{width:100%;border-collapse:collapse;font-size:13px}
  .aceitos-table th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:var(--muted);
    padding:8px 12px;border-bottom:1px solid #2ec27e33}
  .aceitos-table td{padding:10px 12px;border-bottom:1px solid #1e2535;vertical-align:middle}
  .aceitos-table tr:last-child td{border-bottom:none}
  .empty-msg{text-align:center;padding:32px;color:var(--muted);font-size:13px}
  .no-data-msg{text-align:center;padding:60px 20px;color:var(--muted);font-size:14px}

  @media(max-width:768px){
    .page-wrap{padding:16px 16px 40px}
    .lotados-table,.aceitos-table{font-size:12px}
    .lotados-table th,.lotados-table td,.aceitos-table th,.aceitos-table td{padding:8px 8px}
  }
</style>
</head>
<body>
<div id="loading"><div class="spinner"></div><span>Carregando eventos lotados...</span></div>

<header>
  <div class="header-left">
    <div class="logo-badge">RiR 2026</div>
    <div><h1>Eventos Lotados</h1><p>Horários esgotados e sugestão de novos horários</p></div>
  </div>
  <div class="header-right">
    <a href="/" class="btn btn-back">← Voltar ao Dashboard</a>
  </div>
</header>
<div id="status-bar">
  <div id="status-dot" class="status-dot"></div>
  <span id="status-text">Carregando...</span>
</div>

<div class="page-wrap" id="app"></div>

<script>
const CAP = ${CAP};
const FESTIVAL_DATES = ${JSON.stringify(FESTIVAL_DATES)};
const DATE_LABELS = ${JSON.stringify(DATE_LABELS)};
const LS_KEY = 'rir2026_novos_horarios';
const LS_KEY_NEG = 'rir2026_negados';

function addMinutes(t, mins) {
  const [h, m] = t.split(':').map(Number);
  const tot = h * 60 + m + mins;
  return String(Math.floor(tot/60)).padStart(2,'0') + ':' + String(tot % 60).padStart(2,'0');
}

function getAceitos() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; }
}
function saveAceitos(arr) {
  localStorage.setItem(LS_KEY, JSON.stringify(arr));
}

function isAceito(local, date, novoHorario) {
  return getAceitos().some(a => a.local === local && a.date === date && a.novoHorario === novoHorario);
}

function getNegados() {
  try { return JSON.parse(localStorage.getItem(LS_KEY_NEG) || '[]'); } catch { return []; }
}
function saveNegados(arr) { localStorage.setItem(LS_KEY_NEG, JSON.stringify(arr)); }

function negar(local, date, horarioOriginal, rowId) {
  const negados = getNegados();
  if (!negados.some(n => n.local === local && n.date === date && n.horarioOriginal === horarioOriginal)) {
    negados.push({ local, date, horarioOriginal, negadoEm: new Date().toISOString() });
    saveNegados(negados);
  }
  const row = document.getElementById(rowId);
  if (row) {
    row.style.transition = 'opacity 0.3s';
    row.style.opacity = '0';
    setTimeout(() => { row.remove(); updateLotadosCount(); }, 300);
  }
}

function aceitar(local, eventName, date, horarioOriginal, novoHorario, btnId) {
  const aceitos = getAceitos();
  if (!aceitos.some(a => a.local === local && a.date === date && a.horarioOriginal === horarioOriginal)) {
    aceitos.push({ local, eventName, date, horarioOriginal, novoHorario, aceitoEm: new Date().toISOString() });
    saveAceitos(aceitos);
  }
  // Remove the row from the sold-out table immediately
  const btn = document.getElementById(btnId);
  if (btn) {
    const row = btn.closest('tr');
    if (row) {
      row.style.transition = 'opacity 0.3s';
      row.style.opacity = '0';
      setTimeout(() => { row.remove(); updateLotadosCount(); }, 300);
    }
  }
  renderAceitos();
}

function updateLotadosCount() {
  const remaining = document.querySelectorAll('.lotados-table tbody tr').length;
  const valEl = document.querySelector('.summary-value[style*="accent"]');
  if (valEl) valEl.textContent = remaining;
  if (remaining === 0) {
    const tableWrap = document.querySelector('.lotados-table')?.closest('div');
    if (tableWrap) tableWrap.innerHTML = '<div class="no-data-msg" style="padding:24px">🎉 Todos os horários lotados já possuem novo horário aceito!</div>';
  }
}

function renderAceitos() {
  const aceitos = getAceitos();
  const container = document.getElementById('aceitos-container');
  if (!container) return;
  const count = document.getElementById('aceitos-count');
  if (count) count.textContent = aceitos.length;

  if (aceitos.length === 0) {
    container.innerHTML = '<div class="empty-msg">Nenhum novo horário aceito ainda. Clique em "Aceitar" nos eventos lotados acima.</div>';
    return;
  }

  let html = '<table class="aceitos-table"><thead><tr>' +
    '<th>Local de Embarque</th><th>Data</th><th>Horário Original</th><th>Novo Horário</th><th>Aceito em</th>' +
    '</tr></thead><tbody>';
  for (const a of aceitos) {
    const dt = new Date(a.aceitoEm);
    const dtStr = dt.toLocaleDateString('pt-BR') + ' ' + dt.toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit'});
    const dateLabel = DATE_LABELS[a.date] || a.date;
    html += \`<tr>
      <td><strong>\${a.local}</strong></td>
      <td><span class="tag-date">\${dateLabel}</span></td>
      <td><span class="tag-time">\${a.horarioOriginal}</span></td>
      <td><span class="tag-new">🕐 \${a.novoHorario}</span></td>
      <td style="color:var(--muted);font-size:11px">\${dtStr}</td>
    </tr>\`;
  }
  html += '</tbody></table>';
  container.innerHTML = html;
}

function limparAceitos() {
  if (!confirm('Tem certeza que deseja limpar todos os novos horários aceitos?')) return;
  saveAceitos([]);
  renderAceitos();
  // Reset all buttons
  document.querySelectorAll('.btn-aceitar.aceito').forEach(btn => {
    btn.textContent = 'Aceitar';
    btn.classList.remove('aceito');
    btn.disabled = false;
  });
}

function exportarXLS() {
  const aceitos = getAceitos();
  if (aceitos.length === 0) { alert('Nenhum horário aceito para exportar.'); return; }
  if (typeof XLSX === 'undefined') { alert('SheetJS carregando, tente em breve.'); return; }

  const wsData = [['Local de Embarque', 'Nome Completo do Evento', 'Data Festival', 'Horário Original (Lotado)', 'Novo Horário Sugerido', 'Aceito em']];
  for (const a of aceitos) {
    wsData.push([a.local, a.eventName || a.local, a.date, a.horarioOriginal, a.novoHorario, new Date(a.aceitoEm).toLocaleString('pt-BR')]);
  }
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = [{wch:32},{wch:48},{wch:14},{wch:22},{wch:20},{wch:20}];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Novos Horários');
  XLSX.writeFile(wb, 'novos-horarios-rock-in-rio-' + new Date().toISOString().slice(0,10) + '.xlsx');
}

// Extract the true boarding location name from a rawShow entry
function getLocalEmbarque(s) {
  const PREFIX_EVENT = 'Primeira Classe Rock in Rio - ';
  const PREFIX_EMBAR = 'EMBARQUE: ';
  if (s.sectorName && s.sectorName.startsWith(PREFIX_EMBAR))
    return s.sectorName.replace(PREFIX_EMBAR, '').trim();
  if (s.productName && s.productName.startsWith(PREFIX_EMBAR))
    return s.productName.replace(PREFIX_EMBAR, '').trim();
  if (s.eventName && s.eventName.startsWith(PREFIX_EVENT))
    return s.eventName.replace(PREFIX_EVENT, '').trim();
  return s.local || s.eventName || '—';
}

function render(rawShows) {
  // Build set of all existing slots keyed by "localEmbarque|date|time"
  const existingSlots = new Set(rawShows.map(s => \`\${getLocalEmbarque(s)}|\${s.date}|\${s.time}\`));

  // Build neighbor map: "localEmbarque|date" → sorted array of {time, tks}
  const neighborMap = {};
  for (const s of rawShows) {
    if (!s.date || !s.time) continue;
    const le = getLocalEmbarque(s);
    const nk = \`\${le}|\${s.date}\`;
    if (!neighborMap[nk]) neighborMap[nk] = [];
    neighborMap[nk].push({ time: s.time, tks: s.tks || 0 });
  }
  for (const k in neighborMap) neighborMap[k].sort((a,b) => a.time.localeCompare(b.time));

  // Returns suggested new time and offset used; avoids existing slots
  function suggestTime(localEmbarque, date, origTime) {
    for (const mins of [10, 5, 15, 20]) {
      const candidate = addMinutes(origTime, mins);
      if (!existingSlots.has(\`\${localEmbarque}|\${date}|\${candidate}\`)) {
        return { time: candidate, mins };
      }
    }
    return { time: addMinutes(origTime, 10), mins: 10 }; // fallback
  }

  // Build sets of already-accepted and denied slots: "localEmbarque|date|horarioOriginal"
  const aceitosSet = new Set(getAceitos().map(a => \`\${a.local}|\${a.date}|\${a.horarioOriginal}\`));
  const negadosSet = new Set(getNegados().map(n => \`\${n.local}|\${n.date}|\${n.horarioOriginal}\`));

  // Find sold-out slots: tks >= CAP, excluding accepted or denied
  const lotados = rawShows.filter(s => {
    if ((s.tks || 0) < CAP || !s.date || !s.time) return false;
    const key = \`\${getLocalEmbarque(s)}|\${s.date}|\${s.time}\`;
    return !aceitosSet.has(key) && !negadosSet.has(key);
  });

  // Sort: localEmbarque (A→Z) → date → time
  lotados.sort((a, b) => getLocalEmbarque(a).localeCompare(getLocalEmbarque(b), 'pt-BR') || (a.date||'').localeCompare(b.date||'') || (a.time||'').localeCompare(b.time||''));

  let html = '';

  // Summary bar
  const uniqueLocais = new Set(lotados.map(s => getLocalEmbarque(s)));
  html += \`<div class="summary-bar">
    <div class="summary-item">
      <div class="summary-label">Eventos Lotados</div>
      <div class="summary-value" style="color:var(--accent)">\${lotados.length}</div>
    </div>
    <div class="summary-sep"></div>
    <div class="summary-item">
      <div class="summary-label">Ingressos Esgotados</div>
      <div class="summary-value">\${lotados.reduce((s,r)=>s+(r.tks||0),0).toLocaleString('pt-BR')}</div>
    </div>
    <div class="summary-sep"></div>
    <div class="summary-item">
      <div class="summary-label">Locais Afetados</div>
      <div class="summary-value">\${uniqueLocais.size}</div>
    </div>
  </div>\`;

  if (lotados.length === 0) {
    html += '<div class="no-data-msg">🎉 Nenhum evento com lotação esgotada no momento.</div>';
    document.getElementById('app').innerHTML = html;
    document.getElementById('loading').classList.add('hidden');
    return;
  }

  // Sold-out table
  html += \`<div class="section-title">🚨 Horários Esgotados</div>
  <div class="section-sub">Eventos com \${CAP} de \${CAP} ingressos vendidos — capacidade máxima atingida</div>
  <div style="overflow-x:auto">
  <table class="lotados-table">
    <thead><tr>
      <th>Local de Embarque</th><th>Data</th><th>Horário Lotado</th><th>Vendidos</th><th>Horários Vizinhos</th><th>Novo Horário Sugerido</th><th>Ação</th>
    </tr></thead><tbody>\`;

  lotados.forEach((s, i) => {
    const localEmbarque = getLocalEmbarque(s);
    // Find previous and next slots for this local+date
    const neighborKey = \`\${localEmbarque}|\${s.date}\`;
    const neighbors = neighborMap[neighborKey] || [];
    const nIdx = neighbors.findIndex(n => n.time === s.time);
    const prev = nIdx > 0 ? neighbors[nIdx - 1] : null;
    const next = nIdx >= 0 && nIdx < neighbors.length - 1 ? neighbors[nIdx + 1] : null;
    const prevHtml = prev
      ? \`<div style="font-size:11px;white-space:nowrap">← \${prev.time} &nbsp;<b style="color:var(--text)">\${prev.tks}</b> <span style="color:var(--muted)">ing.</span></div>\`
      : \`<div style="color:#555;font-size:11px">← sem anterior</div>\`;
    const nextHtml = next
      ? \`<div style="font-size:11px;white-space:nowrap">→ \${next.time} &nbsp;<b style="color:var(--text)">\${next.tks}</b> <span style="color:var(--muted)">ing.</span></div>\`
      : \`<div style="color:#555;font-size:11px">→ sem próximo</div>\`;
    const { time: novoH, mins } = suggestTime(localEmbarque, s.date, s.time);
    const btnId = 'btn-' + i;
    const jaAceito = isAceito(localEmbarque, s.date, novoH);
    const dateLabel = DATE_LABELS[s.date] || s.date;
    const offsetLabel = mins === 10 ? '+10 min' : mins === 5 ? '+5 min (conflito em +10)' : \`+\${mins} min (conflito)\`;
    const localEsc = localEmbarque.replace(/'/g,"\\\\'");
    const eventEsc = (s.eventName||localEmbarque).replace(/'/g,"\\\\'");
    const rowId = 'row-' + i;
    html += \`<tr id="\${rowId}">
      <td><strong>\${localEmbarque}</strong></td>
      <td><span class="tag-date">\${dateLabel}</span></td>
      <td><span class="tag-time">\${s.time}</span> <span class="badge-lotado">Lotado</span></td>
      <td style="color:var(--accent);font-weight:800">\${s.tks}/\${CAP}</td>
      <td>\${prevHtml}\${nextHtml}</td>
      <td><span class="tag-new">🕐 \${novoH}</span> <span style="font-size:10px;color:var(--muted)">\${offsetLabel}</span></td>
      <td style="display:flex;gap:6px;align-items:center">
        <button class="btn-aceitar\${jaAceito?' aceito':''}" id="\${btnId}" \${jaAceito?'disabled':''}\
          onclick="aceitar('\${localEsc}','\${eventEsc}','\${s.date}','\${s.time}','\${novoH}','\${btnId}')">\
          \${jaAceito?'✓ Aceito':'Aceitar'}</button>
        <button class="btn-negar" onclick="negar('\${localEsc}','\${s.date}','\${s.time}','\${rowId}')">✕ Negar</button>
      </td>
    </tr>\`;
  });

  html += '</tbody></table></div>';

  // Accepted section
  html += \`<div class="aceitos-section">
    <div class="aceitos-header">
      <div class="aceitos-title">✅ Novos Horários Aceitos &nbsp;<span id="aceitos-count" style="background:#2ec27e;color:#000;border-radius:12px;padding:1px 10px;font-size:13px">0</span></div>
      <div class="aceitos-actions">
        <button class="btn-export" onclick="exportarXLS()">📥 Exportar XLS</button>
        <button class="btn-limpar" onclick="limparAceitos()">🗑️ Limpar Lista</button>
      </div>
    </div>
    <div id="aceitos-container"></div>
  </div>\`;

  document.getElementById('app').innerHTML = html;
  renderAceitos();
  document.getElementById('loading').classList.add('hidden');
}

async function loadData() {
  try {
    const res  = await fetch('/api/data');
    const json = await res.json();
    if (!json.data) throw new Error('Sem dados');
    render(json.data.rawShows || []);
    document.getElementById('status-dot').className = 'status-dot green';
    document.getElementById('status-text').textContent = 'Dados ao vivo · ' + (json.lastRefresh ? new Date(json.lastRefresh).toLocaleString('pt-BR') : '—');
  } catch(e) {
    document.getElementById('status-dot').className = 'status-dot red';
    document.getElementById('status-text').textContent = 'Erro: ' + e.message;
    document.getElementById('loading').classList.add('hidden');
  }
}
document.addEventListener('DOMContentLoaded', loadData);
<\/script>
</body></html>`;
}

// ─────────────────────────────────────────────
// ANÁLISE POR LOCAL PAGE
// ─────────────────────────────────────────────
function getLocaisHTML(username) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Análise por Local — Rock in Rio 2026</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"><\/script>
<style>
${SHARED_CSS_VARS}
${SHARED_HEADER_CSS}
  #loading{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:80vh;gap:14px}
  .spinner2{width:40px;height:40px;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin2 .9s linear infinite}
  @keyframes spin2{to{transform:rotate(360deg)}}
  .content{padding:20px 32px 40px}
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin-bottom:20px}
  .kpi{background:var(--surface);border:1px solid var(--border);border-top:3px solid var(--border);border-radius:12px;padding:16px;text-align:center}
  .kpi-label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:6px;font-weight:700}
  .kpi-val{font-size:24px;font-weight:800;line-height:1.1}
  .kpi-sub{font-size:11px;color:var(--muted);margin-top:4px}
  .kpi.gold{border-top-color:var(--gold)}.kpi.gold .kpi-val{color:var(--gold)}
  .kpi.red{border-top-color:var(--accent)}.kpi.red .kpi-val{color:var(--accent)}
  .kpi.blue{border-top-color:var(--blue)}.kpi.blue .kpi-val{color:var(--blue)}
  .kpi.teal{border-top-color:var(--teal)}.kpi.teal .kpi-val{color:var(--teal)}
  .kpi.green{border-top-color:var(--green)}.kpi.green .kpi-val{color:var(--green)}
  .kpi.orange{border-top-color:var(--orange)}.kpi.orange .kpi-val{color:var(--orange)}
  .section{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px;margin-bottom:18px}
  .section-title{font-size:13px;font-weight:700;color:var(--orange);margin-bottom:14px;padding-bottom:8px;border-bottom:1px solid var(--border)}
  .charts-row{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:18px}
  .chart-wrap{position:relative;height:320px}
  .chart-wrap-tall{position:relative;height:420px}
  .table-scroll{overflow-x:auto}
  .data-table{width:100%;border-collapse:collapse;font-size:12px}
  .data-table th{background:var(--surface2);color:var(--orange);padding:8px 10px;text-align:right;border-bottom:2px solid var(--border);font-size:10px;text-transform:uppercase;white-space:nowrap;position:sticky;top:0}
  .data-table th:first-child{text-align:left}
  .data-table td{padding:6px 10px;border-bottom:1px solid var(--border);text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .data-table td:first-child{text-align:left;color:var(--text);font-weight:600}
  .data-table tr:hover td{background:var(--surface2)}
  .data-table .total-row td{font-weight:700;color:var(--gold);border-top:2px solid var(--border);background:var(--surface2)}
  .rank-table{width:100%;border-collapse:collapse;font-size:13px}
  .rank-table th{background:var(--surface2);color:var(--orange);padding:8px 12px;text-align:left;border-bottom:2px solid var(--border);font-size:11px;text-transform:uppercase}
  .rank-table td{padding:8px 12px;border-bottom:1px solid var(--border)}
  .rank-table tr:hover td{background:var(--surface2)}
  .num{color:var(--orange);font-weight:700}
  .bar-cell{display:flex;align-items:center;gap:6px}
  .bar-inline{height:10px;border-radius:3px;background:var(--orange);min-width:2px;transition:width .3s}
  .zero{color:var(--muted)}
  @media(max-width:900px){.content{padding:16px}.charts-row{grid-template-columns:1fr}}
</style>
</head>
<body>
<div id="loading"><div class="spinner2"></div><span style="color:var(--muted)">Carregando dados...</span></div>
<header>
  <div class="header-left">
    <a href="/" style="text-decoration:none;border:1px solid var(--border);padding:7px 14px;border-radius:8px;color:var(--text);font-size:13px;font-weight:600">← Voltar</a>
    <div class="logo-badge">Rock in Rio 2026</div>
    <div><h1>Análise por Local</h1><p>Receita, ingressos, horários e lotação por ponto de embarque</p></div>
  </div>
  <div class="header-right">
    <span id="last-upd" style="font-size:11px;color:var(--muted)"></span>
    <button class="btn btn-primary" onclick="loadData()">↻ Atualizar</button>
    <form method="POST" action="/logout" style="margin:0"><button class="btn btn-secondary" type="submit">Sair</button></form>
  </div>
</header>
<div id="status-bar"><span class="status-dot" id="status-dot"></span><span id="status-text">Conectando...</span></div>
<div class="content" id="content" style="display:none">

  <div class="kpis">
    <div class="kpi gold"><div class="kpi-label">💰 Receita Total</div><div class="kpi-val" id="k-receita">—</div><div class="kpi-sub">em ingressos vendidos</div></div>
    <div class="kpi red"><div class="kpi-label">🎫 Ingressos Vendidos</div><div class="kpi-val" id="k-tks">—</div><div class="kpi-sub" id="k-tks-sub">locais ativos</div></div>
    <div class="kpi blue"><div class="kpi-label">📍 Pontos de Embarque</div><div class="kpi-val" id="k-locais">—</div><div class="kpi-sub" id="k-locais-sub">com vendas</div></div>
    <div class="kpi teal"><div class="kpi-label">💳 Ticket Médio</div><div class="kpi-val" id="k-medio">—</div><div class="kpi-sub">por ingresso</div></div>
    <div class="kpi green"><div class="kpi-label">🏆 Top Local</div><div class="kpi-val" id="k-top" style="font-size:14px;line-height:1.3">—</div><div class="kpi-sub" id="k-top-sub"></div></div>
    <div class="kpi orange"><div class="kpi-label">❌ Cancelados</div><div class="kpi-val" id="k-can">—</div><div class="kpi-sub">ingressos cancelados</div></div>
  </div>

  <div class="charts-row">
    <div class="section">
      <div class="section-title">🏅 Top 15 Locais — Receita (R$)</div>
      <div class="chart-wrap-tall"><canvas id="chart-receita"></canvas></div>
    </div>
    <div class="section">
      <div class="section-title">🏅 Top 15 Locais — Ingressos Vendidos</div>
      <div class="chart-wrap-tall"><canvas id="chart-ingressos"></canvas></div>
    </div>
  </div>

  <div class="charts-row">
    <div class="section">
      <div class="section-title">📅 Vendas por Dia (Data da Compra)</div>
      <div class="chart-wrap"><canvas id="chart-timeline"></canvas></div>
    </div>
    <div class="section">
      <div class="section-title">🕐 Ranking de Horários de Partida</div>
      <div style="max-height:320px;overflow-y:auto">
        <table class="rank-table" id="tbl-horarios">
          <thead><tr><th>#</th><th>Horário</th><th>Ingressos</th><th style="width:120px">Barra</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">📊 Lotação por Data de Show — Ingressos por Ponto de Embarque</div>
    <div class="table-scroll" id="tbl-lotacao-wrap" style="max-height:500px;overflow-y:auto"></div>
  </div>

</div>
<script>
const FEST_DATES  = ['2026-09-04','2026-09-05','2026-09-06','2026-09-07','2026-09-11','2026-09-12','2026-09-13'];
const FEST_LABELS = ['04/Set (Sex)','05/Set (Sáb)','06/Set (Dom)','07/Set (Seg)','11/Set (Sex)','12/Set (Sáb)','13/Set (Dom)'];
const PREFIX1 = 'Primeira Classe Rock in Rio - ';
const PREFIX2 = 'Primeira Classe Rock in Rio | ';
const fmt  = n => Number(n||0).toLocaleString('pt-BR');
const fmtR = n => 'R$\\u00a0'+Number(n||0).toLocaleString('pt-BR',{minimumFractionDigits:0,maximumFractionDigits:0});
const COLORS = ['#e8871a','#5b8dee','#2ec27e','#9b59b6','#1abc9c','#ffd700','#e63946','#f4a261','#FF6B9D','#4ecdc4','#45b7d1','#96ceb4','#ff9f43','#54a0ff','#5f27cd'];
const axO = {color:'#7a8499',grid:{color:'#252d3d'}};
let charts = {};
function mk(id,cfg){ if(charts[id])charts[id].destroy(); const c=document.getElementById(id); if(c)charts[id]=new Chart(c,cfg); }

function normLocal(s){
  if(!s) return '—';
  if(s.startsWith(PREFIX1)) return s.slice(PREFIX1.length);
  if(s.startsWith(PREFIX2)){ const r=s.slice(PREFIX2.length); const p=r.indexOf(' | '); return (p!==-1?r.slice(0,p):r).trim(); }
  return s;
}

function render(d){
  const raw = d.rawShows || [];
  const sbd = (d.salesByDate || []).sort((a,b)=>a.date.localeCompare(b.date)).filter(r=>r.tks>0);

  // Aggregate by local
  const locMap = {};
  for(const r of raw){
    const loc = normLocal(r.local||r.eventName||'');
    if(!loc||loc==='—') continue;
    if(!locMap[loc]) locMap[loc]={receita:0,tks:0,cancelled:0};
    locMap[loc].receita   += r.subtotal||0;
    locMap[loc].tks       += r.tks||0;
    locMap[loc].cancelled += r.cancelled||0;
  }
  const byTks  = Object.entries(locMap).sort((a,b)=>b[1].tks-a[1].tks);
  const byRec  = [...byTks].sort((a,b)=>b[1].receita-a[1].receita);
  const totTks = byTks.reduce((s,[,v])=>s+v.tks,0);
  const totRec = byTks.reduce((s,[,v])=>s+v.receita,0);
  const totCan = byTks.reduce((s,[,v])=>s+v.cancelled,0);
  const active = byTks.filter(([,v])=>v.tks>0);
  const top    = active[0]||['—',{tks:0,receita:0}];

  document.getElementById('k-receita').textContent = fmtR(totRec);
  document.getElementById('k-tks').textContent     = fmt(totTks);
  document.getElementById('k-tks-sub').textContent = active.length+' locais ativos';
  document.getElementById('k-locais').textContent  = byTks.length;
  document.getElementById('k-locais-sub').textContent = active.length+' com vendas';
  document.getElementById('k-medio').textContent   = totTks>0?fmtR(totRec/totTks):'—';
  document.getElementById('k-top').textContent     = top[0];
  document.getElementById('k-top-sub').textContent = fmt(top[1].tks)+' ing · '+fmtR(top[1].receita);
  document.getElementById('k-can').textContent     = fmt(totCan);

  // Top 15 receita
  const t15r = byRec.slice(0,15);
  mk('chart-receita',{type:'bar',data:{labels:t15r.map(([l])=>l.length>20?l.slice(0,19)+'…':l),datasets:[{label:'Receita',data:t15r.map(([,v])=>v.receita),backgroundColor:COLORS.slice(0,15),borderRadius:4}]},
    options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>fmtR(c.raw)}}},scales:{x:{ticks:{...axO,callback:v=>fmtR(v)},grid:{color:'#252d3d'}},y:{ticks:{...axO,font:{size:11}},grid:{color:'#252d3d'}}}}});

  // Top 15 ingressos
  const t15i = byTks.slice(0,15);
  mk('chart-ingressos',{type:'bar',data:{labels:t15i.map(([l])=>l.length>20?l.slice(0,19)+'…':l),datasets:[{label:'Ingressos',data:t15i.map(([,v])=>v.tks),backgroundColor:COLORS.slice(0,15),borderRadius:4}]},
    options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>fmt(c.raw)+' ingressos'}}},scales:{x:{ticks:{...axO,callback:v=>fmt(v)},grid:{color:'#252d3d'}},y:{ticks:{...axO,font:{size:11}},grid:{color:'#252d3d'}}}}});

  // Timeline
  mk('chart-timeline',{type:'line',data:{labels:sbd.map(r=>r.date.slice(5)),datasets:[{label:'Ingressos',data:sbd.map(r=>r.tks),borderColor:'#e8871a',backgroundColor:'rgba(232,135,26,.12)',fill:true,tension:.35,pointRadius:2,pointBackgroundColor:'#e8871a'}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>fmt(c.raw)+' ingressos'}}},scales:{x:{ticks:{...axO,maxTicksLimit:10},grid:{color:'#252d3d'}},y:{ticks:{...axO,callback:v=>fmt(v)},grid:{color:'#252d3d'}}}}});

  // Horários de partida
  const horMap = {};
  for(const r of raw){ if(r.time) horMap[r.time]=(horMap[r.time]||0)+(r.tks||0); }
  const horArr = Object.entries(horMap).sort((a,b)=>b[1]-a[1]);
  const maxH = horArr[0]?horArr[0][1]:1;
  document.querySelector('#tbl-horarios tbody').innerHTML = horArr.map(([t,n],i)=>
    \`<tr><td style="color:var(--muted);width:28px">\${i+1}</td><td style="font-weight:700;font-size:14px">\${t}</td><td class="num">\${fmt(n)}</td><td><div class="bar-cell"><div class="bar-inline" style="width:\${Math.max(4,Math.round(n/maxH*120))}px"></div><span style="font-size:11px;color:var(--muted)">\${Math.round(n/maxH*100)}%</span></div></td></tr>\`
  ).join('');

  // Lotação matrix
  const matMap = {};
  for(const r of raw){
    const loc = normLocal(r.local||r.eventName||'');
    if(!loc||loc==='—') continue;
    const dt = r.date||'';
    if(FEST_DATES.includes(dt)){
      if(!matMap[loc]) matMap[loc]={};
      matMap[loc][dt] = (matMap[loc][dt]||0)+(r.tks||0);
    }
  }
  const matLocs = Object.entries(matMap).sort((a,b)=>{
    const ta=FEST_DATES.reduce((s,d)=>s+(a[1][d]||0),0);
    const tb=FEST_DATES.reduce((s,d)=>s+(b[1][d]||0),0);
    return tb-ta;
  });
  const colTot = {};
  FEST_DATES.forEach(d=>{colTot[d]=matLocs.reduce((s,[,m])=>s+(m[d]||0),0);});
  const grandTot = FEST_DATES.reduce((s,d)=>s+(colTot[d]||0),0);

  const hdr = \`<tr><th>Ponto de Embarque</th>\${FEST_LABELS.map(l=>\`<th>\${l}</th>\`).join('')}<th>Total</th></tr>\`;
  const bodyRows = matLocs.map(([loc,m])=>{
    const tot = FEST_DATES.reduce((s,d)=>s+(m[d]||0),0);
    return \`<tr><td>\${loc}</td>\${FEST_DATES.map(d=>m[d]
      ?\`<td class="num">\${fmt(m[d])}</td>\`
      :\`<td class="zero">—</td>\`).join('')}<td class="num" style="color:var(--gold)">\${fmt(tot)}</td></tr>\`;
  }).join('');
  const totRow = \`<tr class="total-row"><td>TOTAL</td>\${FEST_DATES.map(d=>\`<td>\${fmt(colTot[d]||0)}</td>\`).join('')}<td>\${fmt(grandTot)}</td></tr>\`;
  document.getElementById('tbl-lotacao-wrap').innerHTML = \`<table class="data-table"><thead>\${hdr}</thead><tbody>\${bodyRows}\${totRow}</tbody></table>\`;
}

async function loadData(){
  try{
    const res  = await fetch('/api/data');
    const json = await res.json();
    if(!json.data) throw new Error('Sem dados');
    render(json.data);
    document.getElementById('loading').style.display='none';
    document.getElementById('content').style.display='block';
    document.getElementById('status-dot').className='status-dot green';
    const ts = json.lastRefresh ? new Date(json.lastRefresh).toLocaleString('pt-BR') : '—';
    document.getElementById('status-text').textContent = 'Dados ao vivo · '+ts;
    document.getElementById('last-upd').textContent    = 'Atualizado: '+ts;
  } catch(e){
    document.getElementById('loading').style.display='none';
    document.getElementById('content').style.display='block';
    document.getElementById('status-dot').className='status-dot red';
    document.getElementById('status-text').textContent = 'Erro: '+e.message;
  }
}
document.addEventListener('DOMContentLoaded', loadData);
<\/script>
</body></html>`;
}

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🎸 Rock in Rio Dashboard rodando em http://localhost:${PORT}`);
  console.log(`\n⚙️  Variáveis de ambiente:`);
  console.log(`   USERS          = "usuario1:senha1,usuario2:senha2"`);
  console.log(`   SESSION_SECRET = "string-aleatória-longa"`);
  console.log(`   CROWDER_API_KEY = (opcional, padrão em código)\n`);
  // Buscar dados imediatamente ao iniciar
  refreshData();
});


// ═══════════════════════════════════════════════════════════
// STATE & CHARTS
// ═══════════════════════════════════════════════════════════
let _data = null;
let _rawShows = [];
let _allShows = [];
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
      _allShows = json.data.allShows || _rawShows;
      document.getElementById('loading').classList.add('hidden');
      try {
        renderAll();
      } catch(renderErr) {
        console.error('renderAll error:', renderErr);
        document.getElementById('app').innerHTML += `
          <div style="padding:20px 40px;color:#f4a261;font-size:13px">
            ⚠️ Erro ao renderizar um componente: ${renderErr.message}. Os dados foram carregados com sucesso.
          </div>`;
      }
    } else if (json.error) {
      showError(json.error);
    } else if (json.refreshing) {
      document.querySelector('#loading span').textContent = 'Buscando dados...';
      setTimeout(loadData, 3000);
    } else {
      showError('Nenhum dado disponível. Aguarde a atualização automática.');
    }
  } catch(e) {
    showError('Erro ao carregar dados: ' + e.message);
  }
}

function updateStatusBar(json) {
  const dot  = document.getElementById('status-dot');
  const text = document.getElementById('status-text');

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
}

function showError(msg) {
  document.getElementById('loading').classList.add('hidden');
  document.getElementById('app').innerHTML = `
    <div style="padding:60px 40px;text-align:center;color:var(--muted)">
      <div style="font-size:48px;margin-bottom:16px">⚠️</div>
      <div style="font-size:16px;font-weight:600;color:var(--text);margin-bottom:8px">Dados não disponíveis</div>
      <div style="font-size:13px">${msg}</div>
      <div style="margin-top:24px;font-size:12px;color:#5a6475">
        Os dados são atualizados automaticamente a cada 5 minutos via API.
      </div>
    </div>`;
}

async function doRefresh() {
  const btn = document.getElementById('refresh-btn');
  btn.disabled = true;
  btn.innerHTML = '<span style="font-size:12px">Atualizando...</span>';
  await fetch('/api/refresh', { method: 'POST' });
  setTimeout(() => {
    loadData();
    btn.disabled = false;
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
      <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
    </svg>Atualizar Dados`;
  }, 8000);
}

// ═══════════════════════════════════════════════════════════
// RENDER
// ═══════════════════════════════════════════════════════════
function renderAll() {
  if (!_data) return;
  const { events, byDate, byTime, heatmap, totalSold, totalRevenue,
          totalReserved, totalReservedRevenue, totalCancelled, totalCancelledRevenue } = _data;

  const totalTickets   = events.reduce((s, e) => s + e.sold, 0);
  const totalEvents    = events.filter(e => e.sold > 0).length;
  const totalSalesDays = (_data.byDate || []).filter(d => d.tks > 0).length;
  const totalTax       = _rawShows.reduce((s, r) => s + (r.taxa || 0), 0);
  const ticketMedio    = totalTickets > 0 ? totalRevenue / totalTickets : 0;
  const totalRes       = events.reduce((s, e) => s + (e.reserved || 0), 0);
  const totalCan       = events.reduce((s, e) => s + (e.cancelled || 0), 0);
  const totalCanRev    = events.reduce((s, e) => s + (e.cancelledRevenue || 0), 0);

  document.getElementById('app').innerHTML = `
    <!-- KPIs -->
    <div class="section-heading"><h2>Visão Geral</h2><div class="section-divider"></div></div>
    <div class="kpi-grid">
      <div class="kpi-card red"><div class="kpi-label">Ingressos Vendidos</div>
        <div class="kpi-value">${fmt(totalTickets)}</div>
        <div class="kpi-sub">em ${totalEvents} locais ativos</div></div>
      <div class="kpi-card gold"><div class="kpi-label">Receita Bruta</div>
        <div class="kpi-value">${fmtR(totalRevenue)}</div>
        <div class="kpi-sub">valor dos ingressos</div></div>
      <div class="kpi-card blue"><div class="kpi-label">Total c/ Taxas (10%)</div>
        <div class="kpi-value">${fmtR(totalRevenue + totalTax)}</div>
        <div class="kpi-sub">+ ${fmtR(totalTax)} em taxas</div></div>
      <div class="kpi-card teal"><div class="kpi-label">Ticket Médio</div>
        <div class="kpi-value">${fmtR(ticketMedio)}</div>
        <div class="kpi-sub">por ingresso vendido</div></div>
      <div class="kpi-card green"><div class="kpi-label">Dias de Venda</div>
        <div class="kpi-value">${fmt(totalSalesDays)}</div>
        <div class="kpi-sub">dias com vendas registradas</div></div>
      <div class="kpi-card purple"><div class="kpi-label">Locais</div>
        <div class="kpi-value">36</div>
        <div class="kpi-sub">${totalEvents} com vendas</div></div>
      <div class="kpi-card" style="border-top:3px solid #f4a261"><div class="kpi-label">Reservados</div>
        <div class="kpi-value" style="color:#f4a261">${fmt(totalRes)}</div>
        <div class="kpi-sub">pedidos em aberto</div></div>
      <div class="kpi-card" style="border-top:3px solid #e63946"><div class="kpi-label">Cancelados</div>
        <div class="kpi-value" style="color:#e63946">${fmt(totalCan)}</div>
        <div class="kpi-sub">${fmtR(totalCanRev)} estornados</div></div>
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
            <th onclick="sortTable('shows')">Shows ↕</th>
            <th onclick="sortTable('reserved')" style="color:#f4a261">Reservados ↕</th>
            <th onclick="sortTable('cancelled')" style="color:#e63946">Cancelados ↕</th>
          </tr></thead>
          <tbody id="evTbody"></tbody>
        </table>
      </div>
    </div>`;

  renderCharts(events, byDate, byTime);
  renderHistoricoChart();
  renderHeatmap(events, byDate, _rawShows);
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

  // ── Projeção Tendência: velocidade atual + crescimento histórico ──
  // Combina a projeção linear (velocidade atual) com a âncora histórica (2024 × crescimento médio).
  // Quanto mais avançado o ciclo de vendas, maior o peso da velocidade observada;
  // no início do ciclo, o histórico domina para evitar projeções irreais.
  const salesProgress   = daysElapsed / (daysElapsed + daysLeft);  // 0 (início) → 1 (evento)
  const projVelocityRaw = Math.round(sold + velocityTix * daysLeft); // puramente linear
  const projHistBased   = Math.round(last2.vendas * (1 + avgGrow)); // âncora histórica ~167k
  const velWeight       = Math.pow(salesProgress, 0.7);             // cresce suavemente 0→1
  const projTrend       = Math.round(projHistBased * (1 - velWeight) + projVelocityRaw * velWeight);
  const projRevTrend    = projTrend * avgTicketPrice;

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
  document.getElementById('proj-cards').innerHTML = `
    <div class="proj-card velocidade">
      <div class="proj-label">Velocidade Atual</div>
      <div class="proj-value" style="color:var(--purple)">${velocityTix.toFixed(1)}</div>
      <div class="proj-sub">ingressos / dia</div>
      <div class="proj-sub">${fmtR(velocityRev)} / dia</div>
      <div class="proj-sub" style="margin-top:8px">${fmtN(sold)} vendidos · ${daysLeft} dias restantes</div>
    </div>
    <div class="proj-card conservador">
      <div class="proj-label">Projeção Conservadora</div>
      <div class="proj-value" style="color:var(--blue)">${fmtN(projConservador)}</div>
      <div class="proj-sub">${fmtR(last2.total * (1 + minGrow))}</div>
      <div class="proj-scenario conservador">+${(minGrow*100).toFixed(1)}% vs 2024</div>
      <div class="proj-sub" style="margin-top:8px">${pctConserv}% vendido</div>
      <div class="progress-wrap"><div class="progress-fill" style="width:${pctConserv}%;background:var(--blue)"></div></div>
    </div>
    <div class="proj-card tendencia">
      <div class="proj-label">Projeção Tendência ⚡</div>
      <div class="proj-value" style="color:var(--green)">${fmtN(projTrend)}</div>
      <div class="proj-sub">${fmtR(projRevTrend)}</div>
      <div class="proj-scenario tendencia">${projTrend > last2.vendas ? '+' : ''}${((projTrend/last2.vendas-1)*100).toFixed(1)}% vs 2024</div>
      <div class="proj-sub" style="margin-top:8px">${pctTrend}% vendido</div>
      <div class="progress-wrap"><div class="progress-fill" style="width:${pctTrend}%;background:var(--green)"></div></div>
      <div class="proj-sub" style="margin-top:6px;font-size:10px;color:#7a8499">velocidade atual + crescimento histórico (${(salesProgress*100).toFixed(0)}% do ciclo)</div>
    </div>
    <div class="proj-card otimista">
      <div class="proj-label">Projeção Otimista</div>
      <div class="proj-value" style="color:var(--gold)">${fmtN(projOtimista)}</div>
      <div class="proj-sub">${fmtR(last2.total * (1 + maxGrow))}</div>
      <div class="proj-scenario otimista">+${(maxGrow*100).toFixed(1)}% vs 2024</div>
      <div class="proj-sub" style="margin-top:8px">${pctOtimista}% vendido</div>
      <div class="progress-wrap"><div class="progress-fill" style="width:${pctOtimista}%;background:var(--gold)"></div></div>
    </div>`;

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
                return ` ${Number(ctx.raw).toLocaleString('pt-BR')} ingressos`;
              return ` R\$ ${Number(ctx.raw).toLocaleString('pt-BR', {minimumFractionDigits:0})}`;
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

function renderHeatmap(events, byDate, rawShows) {
  const FESTIVAL_DATES = ['2026-09-04','2026-09-05','2026-09-06','2026-09-07',
                          '2026-09-11','2026-09-12','2026-09-13'];
  const DATE_SHORT = ['04/Set','05/Set','06/Set','07/Set','11/Set','12/Set','13/Set'];

  // Build heatmap from rawShows: { eventName -> { date -> tks } }
  const heatmap = {};
  for (const s of rawShows) {
    if (!s.tks || s.tks <= 0) continue;
    const name = s.eventName || s.local || '';
    if (!heatmap[name]) heatmap[name] = {};
    heatmap[name][s.date] = (heatmap[name][s.date] || 0) + s.tks;
  }

  const maxVal = Math.max(1, ...Object.values(heatmap).flatMap(row =>
    FESTIVAL_DATES.map(d => row[d] || 0)));

  function hmColor(v) {
    if (!v) return 'transparent';
    const t = Math.min(v / maxVal, 1);
    const r = Math.round(230 * t), g = Math.round(57 + 100 * (1 - t));
    return `rgba(${r},${g},70,${0.2 + t * 0.7})`;
  }

  // Use event names from heatmap (those that have actual sales on festival dates)
  const eventNames = Object.keys(heatmap).filter(name =>
    FESTIVAL_DATES.some(d => heatmap[name][d] > 0)
  ).sort((a, b) => {
    const totA = FESTIVAL_DATES.reduce((s, d) => s + (heatmap[a][d] || 0), 0);
    const totB = FESTIVAL_DATES.reduce((s, d) => s + (heatmap[b][d] || 0), 0);
    return totB - totA;
  });

  if (eventNames.length === 0) {
    document.getElementById('heatmap-container').innerHTML =
      '<div style="padding:20px;color:var(--muted);text-align:center">Nenhum ingresso associado a datas do festival ainda.</div>';
    return;
  }

  let html = '<table class="heatmap-table"><thead><tr>';
  html += '<th class="event-col">Local</th>';
  DATE_SHORT.forEach(d => { html += `<th>${d}</th>`; });
  html += '</tr></thead><tbody>';
  eventNames.forEach(name => {
    const label = name.replace('Primeira Classe Rock in Rio - ', '');
    html += `<tr><td class="event-name">${label}</td>`;
    FESTIVAL_DATES.forEach(d => {
      const v = heatmap[name][d] || 0;
      const color = hmColor(v);
      html += `<td><span class="hm-cell" style="background:${color}">${v || ''}</span></td>`;
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
    const pos = medals[i] || (`<span style="font-size:11px">#${i+1}</span>`);
    const posClass = i < 3 ? 'rank-pos top' : 'rank-pos';
    htmlLocais += `<tr>
      <td class="${posClass}">${pos}</td>
      <td class="rank-name" title="${e.name}">${e.name}</td>
      <td class="rank-bar-td"><div class="rank-bar-wrap"><div class="rank-bar-fill" style="width:${pct}%"></div></div></td>
      <td class="rank-val">${e.sold}<br><span class="rank-sub">${sharePct}%</span></td>
    </tr>`;
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
    const pos = medals[i] || (`<span style="font-size:11px">#${i+1}</span>`);
    const posClass = i < 3 ? 'rank-pos top' : 'rank-pos';
    htmlHorarios += `<tr>
      <td class="${posClass}">${pos}</td>
      <td class="rank-name">${t.time}</td>
      <td class="rank-bar-td"><div class="rank-bar-wrap"><div class="rank-bar-fill rank-bar-time" style="width:${pct}%"></div></div></td>
      <td class="rank-val">${t.tks}<br><span class="rank-sub">${sharePct}%</span></td>
    </tr>`;
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
  tbody.innerHTML = sorted.map(e => `
    <tr>
      <td><strong>${e.name}</strong></td>
      <td><span class="badge-sold">${e.sold}</span></td>
      <td>${fmtR(e.revenue)}</td>
      <td style="color:${e.reserved > 0 ? '#f4a261' : 'inherit'}">${e.reserved || 0}</td>
      <td style="color:${e.cancelled > 0 ? '#e63946' : 'inherit'}">${e.cancelled || 0}</td>
    </tr>`).join('');
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

// Dados históricos de vendas acumuladas por contagem regressiva até o 1º show
/// ═══════════════════════════════════════════════════════════
// MASTER SCHEDULE — todos os 36 locais × 7 datas × horários
// Fonte: Horarios RiR2026.xlsx (aba HORARIOS)
// ═══════════════════════════════════════════════════════════
const MASTER_SCHEDULE = {"Botafogo Praia Shopping":{"2026-09-04":["11:00","12:00","12:30","13:00","13:30","14:00","14:30","15:00","15:30","16:00","16:30","17:00","18:00","19:00"],"2026-09-05":["11:00","12:00","12:30","13:00","13:30","14:00","14:30","15:00","15:30","16:00","16:30","17:00","18:00","19:00"],"2026-09-06":["11:00","12:00","12:30","13:00","13:30","14:00","14:30","15:00","15:30","16:00","16:30","17:00","18:00","19:00"],"2026-09-07":["11:00","12:00","12:30","13:00","13:30","14:00","14:30","15:00","15:30","16:00","16:30","17:00","18:00","19:00"],"2026-09-11":["11:00","12:00","12:30","13:00","13:30","14:00","14:30","15:00","15:30","16:00","16:30","17:00","18:00","19:00"],"2026-09-12":["11:00","12:00","12:30","13:00","13:30","14:00","14:30","15:00","15:30","16:00","16:30","17:00","18:00","19:00"],"2026-09-13":["11:00","12:00","12:30","13:00","13:30","14:00","14:30","15:00","15:30","16:00","16:30","17:00","18:00","19:00"]},"Shopping Rio Sul":{"2026-09-04":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-05":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-06":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-07":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-11":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-12":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-13":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"]},"Copacabana":{"2026-09-04":["11:00","12:00","12:30","13:00","13:30","14:00","14:30","15:00","15:30","16:00","16:30","17:00","18:00","19:00"],"2026-09-05":["11:00","12:00","12:30","13:00","13:30","14:00","14:30","15:00","15:30","16:00","16:30","17:00","18:00","19:00"],"2026-09-06":["11:00","12:00","12:30","13:00","13:30","14:00","14:30","15:00","15:30","16:00","16:30","17:00","18:00","19:00"],"2026-09-07":["11:00","12:00","12:30","13:00","13:30","14:00","14:30","15:00","15:30","16:00","16:30","17:00","18:00","19:00"],"2026-09-11":["11:00","12:00","12:30","13:00","13:30","14:00","14:30","15:00","15:30","16:00","16:30","17:00","18:00","19:00"],"2026-09-12":["11:00","12:00","12:30","13:00","13:30","14:00","14:30","15:00","15:30","16:00","16:30","17:00","18:00","19:00"],"2026-09-13":["11:00","12:00","12:30","13:00","13:30","14:00","14:30","15:00","15:30","16:00","16:30","17:00","18:00","19:00"]},"Copacabana - Posto 5":{"2026-09-04":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-05":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-06":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-07":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-11":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-12":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-13":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"]},"Ipanema":{"2026-09-04":["11:00","12:00","12:30","13:00","13:30","14:00","14:30","15:00","15:30","16:00","16:30","17:00","18:00","19:00"],"2026-09-05":["11:00","12:00","12:30","13:00","13:30","14:00","14:30","15:00","15:30","16:00","16:30","17:00","18:00","19:00"],"2026-09-06":["11:00","12:00","12:30","13:00","13:30","14:00","14:30","15:00","15:30","16:00","16:30","17:00","18:00","19:00"],"2026-09-07":["11:00","12:00","12:30","13:00","13:30","14:00","14:30","15:00","15:30","16:00","16:30","17:00","18:00","19:00"],"2026-09-11":["11:00","12:00","12:30","13:00","13:30","14:00","14:30","15:00","15:30","16:00","16:30","17:00","18:00","19:00"],"2026-09-12":["11:00","12:00","12:30","13:00","13:30","14:00","14:30","15:00","15:30","16:00","16:30","17:00","18:00","19:00"],"2026-09-13":["11:00","12:00","12:30","13:00","13:30","14:00","14:30","15:00","15:30","16:00","16:30","17:00","18:00","19:00"]},"Mix Rio FM - Bossa Nova Mall":{"2026-09-04":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-05":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-06":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-07":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-11":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-12":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-13":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"]},"RIO Galeão":{"2026-09-04":["12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-05":["12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-06":["12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-07":["12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-11":["12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-12":["12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-13":["12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"]},"Rio Design Barra":{"2026-09-04":["12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-05":["12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-06":["12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-07":["12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-11":["12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-12":["12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-13":["12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"]},"Norte Shopping":{"2026-09-04":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-05":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-06":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-07":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-11":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-12":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-13":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"]},"Nova América":{"2026-09-04":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-05":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-06":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-07":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-11":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-12":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-13":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"]},"Recreio Shopping":{"2026-09-04":["12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-05":["12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-06":["12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-07":["12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-11":["12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-12":["12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-13":["12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"]},"Carioca Shopping":{"2026-09-04":["11:00","13:00","15:00","17:00"],"2026-09-05":["11:00","13:00","15:00","17:00"],"2026-09-06":["11:00","13:00","15:00","17:00"],"2026-09-07":["11:00","13:00","15:00","17:00"],"2026-09-11":["11:00","13:00","15:00","17:00"],"2026-09-12":["11:00","13:00","15:00","17:00"],"2026-09-13":["11:00","13:00","15:00","17:00"]},"Tijuca":{"2026-09-04":["11:00","12:00","12:30","13:00","13:30","14:00","14:30","15:00","15:30","16:00","16:30","17:00","18:00","19:00"],"2026-09-05":["11:00","12:00","12:30","13:00","13:30","14:00","14:30","15:00","15:30","16:00","16:30","17:00","18:00","19:00"],"2026-09-06":["11:00","12:00","12:30","13:00","13:30","14:00","14:30","15:00","15:30","16:00","16:30","17:00","18:00","19:00"],"2026-09-07":["11:00","12:00","12:30","13:00","13:30","14:00","14:30","15:00","15:30","16:00","16:30","17:00","18:00","19:00"],"2026-09-11":["11:00","12:00","12:30","13:00","13:30","14:00","14:30","15:00","15:30","16:00","16:30","17:00","18:00","19:00"],"2026-09-12":["11:00","12:00","12:30","13:00","13:30","14:00","14:30","15:00","15:30","16:00","16:30","17:00","18:00","19:00"],"2026-09-13":["11:00","12:00","12:30","13:00","13:30","14:00","14:30","15:00","15:30","16:00","16:30","17:00","18:00","19:00"]},"Niterói  - São Francisco":{"2026-09-04":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00"],"2026-09-05":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00"],"2026-09-06":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00"],"2026-09-07":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00"],"2026-09-11":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00"],"2026-09-12":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00"],"2026-09-13":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00"]},"Plaza Shopping":{"2026-09-04":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00"],"2026-09-05":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00"],"2026-09-06":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00"],"2026-09-07":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00"],"2026-09-11":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00"],"2026-09-12":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00"],"2026-09-13":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00"]},"Lagoa":{"2026-09-04":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-05":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-06":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-07":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-11":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-12":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"],"2026-09-13":["11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"]},"Shopping Nova Iguaçú":{"2026-09-04":["11:00","13:00","15:00","17:00"],"2026-09-05":["11:00","13:00","15:00","17:00"],"2026-09-06":["11:00","13:00","15:00","17:00"],"2026-09-07":["11:00","13:00","15:00","17:00"],"2026-09-11":["11:00","13:00","15:00","17:00"],"2026-09-12":["11:00","13:00","15:00","17:00"],"2026-09-13":["11:00","13:00","15:00","17:00"]},"West Shopping":{"2026-09-04":["11:00","13:00","15:00","17:00"],"2026-09-05":["11:00","13:00","15:00","17:00"],"2026-09-06":["11:00","13:00","15:00","17:00"],"2026-09-07":["11:00","13:00","15:00","17:00"],"2026-09-11":["11:00","13:00","15:00","17:00"],"2026-09-12":["11:00","13:00","15:00","17:00"],"2026-09-13":["11:00","13:00","15:00","17:00"]},"São Gonçalo Shopping":{"2026-09-04":["11:00","13:00","15:00","17:00"],"2026-09-05":["11:00","13:00","15:00","17:00"],"2026-09-06":["11:00","13:00","15:00","17:00"],"2026-09-07":["11:00","13:00","15:00","17:00"],"2026-09-11":["11:00","13:00","15:00","17:00"],"2026-09-12":["11:00","13:00","15:00","17:00"],"2026-09-13":["11:00","13:00","15:00","17:00"]},"Petrópolis":{"2026-09-04":["11:00","12:00","13:00","15:00"],"2026-09-05":["11:00","12:00","13:00","15:00"],"2026-09-06":["11:00","12:00","13:00","15:00"],"2026-09-07":["11:00","12:00","13:00","15:00"],"2026-09-11":["11:00","12:00","13:00","15:00"],"2026-09-12":["11:00","12:00","13:00","15:00"],"2026-09-13":["11:00","12:00","13:00","15:00"]},"Resende":{"2026-09-04":["09:00"],"2026-09-05":["09:00"],"2026-09-06":["09:00"],"2026-09-07":["09:00"],"2026-09-11":["09:00"],"2026-09-12":["09:00"],"2026-09-13":["09:00"]},"Barra Mansa":{"2026-09-04":["09:45"],"2026-09-05":["09:45"],"2026-09-06":["09:45"],"2026-09-07":["09:45"],"2026-09-11":["09:45"],"2026-09-12":["09:45"],"2026-09-13":["09:45"]},"Volta Redonda":{"2026-09-04":["10:10"],"2026-09-05":["10:10"],"2026-09-06":["10:10"],"2026-09-07":["10:10"],"2026-09-11":["10:10"],"2026-09-12":["10:10"],"2026-09-13":["10:10"]},"Piraí":{"2026-09-04":["10:45"],"2026-09-05":["10:45"],"2026-09-06":["10:45"],"2026-09-07":["10:45"],"2026-09-11":["10:45"],"2026-09-12":["10:45"],"2026-09-13":["10:45"]},"Buzios":{"2026-09-04":["06:50"],"2026-09-05":["06:50"],"2026-09-06":["06:50"],"2026-09-07":["06:50"],"2026-09-11":["06:50"],"2026-09-12":["06:50"],"2026-09-13":["06:50"]},"Cabo Frio":{"2026-09-04":["07:40"],"2026-09-05":["07:40"],"2026-09-06":["07:40"],"2026-09-07":["07:40"],"2026-09-11":["07:40"],"2026-09-12":["07:40"],"2026-09-13":["07:40"]},"Piracicaba":{"2026-09-04":["01:30"],"2026-09-05":["01:30"],"2026-09-06":["01:30"],"2026-09-07":["01:30"],"2026-09-11":["01:30"],"2026-09-12":["01:30"],"2026-09-13":["01:30"]},"Campinas":{"2026-09-04":["03:00"],"2026-09-05":["03:00"],"2026-09-06":["03:00"],"2026-09-07":["03:00"],"2026-09-11":["03:00"],"2026-09-12":["03:00"],"2026-09-13":["03:00"]},"Sorocaba":{"2026-09-04":["02:00"],"2026-09-05":["02:00"],"2026-09-06":["02:00"],"2026-09-07":["02:00"],"2026-09-11":["02:00"],"2026-09-12":["02:00"],"2026-09-13":["02:00"]},"Belo Horizonte":{"2026-09-04":["03:00"],"2026-09-05":["03:00"],"2026-09-06":["03:00"],"2026-09-07":["03:00"],"2026-09-11":["03:00"],"2026-09-12":["03:00"],"2026-09-13":["03:00"]},"Poços de Caldas":{"2026-09-04":["02:00"],"2026-09-05":["02:00"],"2026-09-06":["02:00"],"2026-09-07":["02:00"],"2026-09-11":["02:00"],"2026-09-12":["02:00"],"2026-09-13":["02:00"]},"Itajuba":{"2026-09-04":["05:30"],"2026-09-05":["05:30"],"2026-09-06":["05:30"],"2026-09-07":["05:30"],"2026-09-11":["05:30"],"2026-09-12":["05:30"],"2026-09-13":["05:30"]},"Campos dos Goytacazes":{"2026-09-04":["06:30"],"2026-09-05":["06:30"],"2026-09-06":["06:30"],"2026-09-07":["06:30"],"2026-09-11":["06:30"],"2026-09-12":["06:30"],"2026-09-13":["06:30"]},"Macaé":{"2026-09-04":["07:20"],"2026-09-05":["07:20"],"2026-09-06":["07:20"],"2026-09-07":["07:20"],"2026-09-11":["07:20"],"2026-09-12":["07:20"],"2026-09-13":["07:20"]},"Nova Friburgo":{"2026-09-04":["07:30"],"2026-09-05":["07:30"],"2026-09-06":["07:30"],"2026-09-07":["07:30"],"2026-09-11":["07:30"],"2026-09-12":["07:30"],"2026-09-13":["07:30"]},"São Paulo":{"2026-09-04":["04:00"],"2026-09-05":["04:00"],"2026-09-06":["04:00"],"2026-09-07":["04:00"],"2026-09-11":["04:00"],"2026-09-12":["04:00"],"2026-09-13":["04:00"]}};

// Mapping: spreadsheet local name -> rawShows eventName suffix (after "Primeira Classe Rock in Rio - ")
const LOCAL_NAME_MAP = {"Botafogo Praia Shopping":"Botafogo Praia Shopping","Shopping Rio Sul":"Shopping Rio Sul","Copacabana":"Copacabana","Copacabana - Posto 5":"Copacabana - Posto 5","Ipanema":"Ipanema","Lagoa":"Lagoa","Recreio Shopping":"Recreio Shopping","West Shopping":"West Shopping","Nova América":"Nova América","Tijuca":"Tijuca","Carioca Shopping":"Carioca Shopping","Norte Shopping":"Norte Shopping","Mix Rio FM - Bossa Nova Mall":"Mix Rio FM - Bossa Nova Mall","RIO Galeão":"RIO Galeão","Rio Design Barra":"Rio Design Barra","Niterói  - São Francisco":"Niterói - São Francisco","Plaza Shopping":"Niterói Plaza Shopping","São Gonçalo Shopping":"São Gonçalo Shopping","Shopping Nova Iguaçú":"Shopping Nova Iguaçú","Petrópolis":"Petrópolis","Macaé":"Macaé","Cabo Frio":"Cabo Frio","Campinas":"Campinas","Resende":"Resende","Itajuba":"Itajubá","Belo Horizonte":"Belo Horizonte","Campos dos Goytacazes":"Campos dos Goytacazes","São Paulo":"Shopping Eldorado - São Paulo","Barra Mansa":"Barra Mansa","Buzios":"Buzios","Nova Friburgo":"Nova Friburgo","Piracicaba":"Piracicaba","Piraí":"Piraí","Poços de Caldas":"Poços de Caldas","Sorocaba":"Sorocaba","Volta Redonda":"Volta Redonda"};

// Colunas: [2015, 2017, 2019, 2022, 2024]  —  fonte: Comparativo de Vendas RiR.xlsx
const HIST_COUNTDOWN = {
  180:[0,0,0,0,0],
  179:[0,0,0,0,0],
  178:[0,0,0,37,0],
  177:[0,0,0,53,0],
  176:[0,0,0,73,0],
  175:[0,0,0,325,0],
  174:[0,0,0,532,0],
  173:[0,0,0,622,0],
  172:[0,0,0,695,0],
  171:[0,0,0,737,0],
  170:[0,0,0,786,0],
  169:[0,12558,835,0,0],
  168:[0,13329,1259,0,0],
  167:[0,13670,1551,0,0],
  166:[0,14036,1654,0,0],
  165:[0,14334,1774,0,0],
  164:[0,14609,1906,0,0],
  163:[0,14781,1994,0,0],
  162:[0,14987,2081,0,0],
  161:[0,15163,2214,0,0],
  160:[0,15383,2313,0,0],
  159:[0,15608,2397,0,0],
  158:[0,15849,2472,0,0],
  157:[0,16096,2556,0,0],
  156:[0,16351,2624,0,0],
  155:[0,16548,2701,0,0],
  154:[0,16764,2786,0,0],
  153:[0,16974,2862,0,0],
  152:[0,17218,2946,0,0],
  151:[0,17421,3019,0,0],
  150:[0,17608,3100,0,0],
  149:[0,17773,3170,0,0],
  148:[0,18012,3248,0,0],
  147:[0,18192,3325,0,0],
  146:[0,18379,3397,0,0],
  145:[0,18557,3462,0,0],
  144:[0,18742,3542,0,0],
  143:[0,18939,3624,0,0],
  142:[0,19138,3703,0,0],
  141:[0,19336,3789,0,0],
  140:[0,19521,3879,0,0],
  139:[0,19706,3949,0,0],
  138:[0,19882,4019,0,0],
  137:[0,20067,4098,0,0],
  136:[0,20252,4178,0,0],
  135:[0,20437,4262,0,0],
  134:[0,20602,4347,0,0],
  133:[0,20775,4433,0,0],
  132:[0,20952,4518,0,0],
  131:[0,21130,4611,0,0],
  130:[0,21332,4697,0,0],
  129:[0,21566,4788,0,0],
  128:[0,21804,4880,0,0],
  127:[0,22010,4970,0,0],
  126:[0,22218,5056,0,0],
  125:[0,22437,5141,0,0],
  124:[0,22659,5228,0,0],
  123:[0,22867,5315,0,0],
  122:[0,23063,5399,0,0],
  121:[0,23259,5494,0,0],
  120:[0,23455,5574,0,0],
  119:[0,23642,5654,0,0],
  118:[0,23820,5733,0,0],
  117:[0,23997,5812,0,0],
  116:[0,24177,5900,0,0],
  115:[0,24357,5996,0,0],
  114:[0,24533,6082,0,0],
  113:[0,24700,6174,0,0],
  112:[0,24876,6262,0,0],
  111:[0,25047,6352,0,0],
  110:[0,25215,6444,0,0],
  109:[0,25380,6535,0,0],
  108:[0,25543,6631,0,0],
  107:[0,0,23010,13119,8965],
  106:[0,0,23168,13248,9125],
  105:[0,0,23310,13379,9252],
  104:[0,0,23456,13506,9423],
  103:[0,0,23598,13629,9572],
  102:[0,0,23742,13752,9726],
  101:[0,0,23889,13881,9887],
  100:[0,0,24040,14014,10062],
  99:[0,0,24188,14148,10215],
  98:[0,0,24405,14326,19312],
  97:[0,0,24595,14489,19553],
  96:[0,0,24779,14655,19750],
  95:[0,0,24968,14821,19950],
  94:[0,0,25159,14989,20148],
  93:[0,0,25353,15159,20351],
  92:[0,0,25541,15333,20551],
  91:[0,0,25730,15512,20755],
  90:[0,0,25917,15693,20968],
  89:[0,0,26103,15871,21167],
  88:[0,0,26291,16051,21375],
  87:[0,0,26479,16227,21582],
  86:[0,0,26667,16407,21805],
  85:[0,0,26854,16584,22024],
  84:[0,0,27043,16761,22244],
  83:[0,0,27227,16939,22473],
  82:[0,0,27416,17117,22700],
  81:[0,0,27605,17295,22925],
  80:[0,0,27796,17478,23148],
  79:[0,0,27991,17659,23371],
  78:[0,0,28175,17843,23603],
  77:[0,0,28370,18025,23843],
  76:[0,0,28565,18210,24089],
  75:[0,0,28756,18397,24324],
  74:[0,0,28947,18583,24564],
  73:[0,0,29138,18769,24806],
  72:[0,0,29335,18954,25054],
  71:[0,0,29533,19144,25306],
  70:[0,0,29734,19338,25571],
  69:[0,0,29935,19530,25836],
  68:[0,0,30135,19722,26104],
  67:[0,0,30338,19916,26374],
  66:[0,0,30542,20112,26649],
  65:[0,0,30748,20308,26928],
  64:[0,0,30957,20504,27217],
  63:[0,0,31165,20703,27507],
  62:[0,0,31374,20901,27807],
  61:[0,0,31580,21104,28113],
  60:[0,0,31789,21304,28430],
  59:[0,0,31998,21510,28749],
  58:[0,0,32210,21715,29071],
  57:[0,0,32424,21920,29401],
  56:[0,0,32638,22127,29741],
  55:[0,0,32851,22338,30083],
  54:[0,0,33066,22548,30428],
  53:[0,0,33283,22759,30788],
  52:[0,0,33500,22974,31152],
  51:[0,0,33716,23191,31521],
  50:[0,0,33935,23412,31899],
  49:[0,0,34156,23633,32284],
  48:[0,0,34378,23856,32676],
  47:[0,0,34601,24083,33074],
  46:[0,0,34827,24312,33479],
  45:[0,0,35056,24542,33894],
  44:[0,0,35287,24774,34319],
  43:[0,0,35519,25013,34751],
  42:[0,0,35756,25253,35195],
  41:[0,0,35995,25496,35648],
  40:[0,0,36238,25740,36113],
  39:[0,0,36481,25989,36590],
  38:[0,0,36728,26237,37073],
  37:[0,0,36977,26491,37575],
  36:[0,0,37232,26749,38089],
  35:[0,0,37490,27013,38616],
  34:[0,0,37751,27281,39148],
  33:[0,0,38017,27555,39699],
  32:[0,0,38287,27834,40259],
  31:[0,0,38558,28115,40824],
  30:[0,0,38837,28401,41410],
  29:[0,0,39117,28692,42005],
  28:[0,0,39401,28989,42619],
  27:[0,0,39693,29294,43251],
  26:[0,0,39988,29601,43891],
  25:[0,0,40286,29915,44547],
  24:[0,0,40592,30232,45218],
  23:[0,0,40901,30557,45907],
  22:[0,0,41218,30887,46616],
  21:[0,0,41538,31218,47341],
  20:[0,0,41863,31556,48086],
  19:[0,0,42193,31900,48854],
  18:[0,0,42531,32251,49642],
  17:[0,0,42876,32608,50454],
  16:[0,0,43229,32975,51289],
  15:[0,0,43590,33352,52151],
  14:[0,0,43961,33738,53045],
  13:[0,0,44343,34130,53979],
  12:[0,0,44734,34533,54946],
  11:[0,0,45139,34951,55957],
  10:[0,0,45564,35382,57019],
  9:[0,0,46004,35828,58139],
  8:[0,0,46463,36290,59316],
  7:[0,0,46946,36768,60568],
  6:[0,0,47452,37270,61892],
  5:[82264,54528,78143,106633,123814],
  4:[85450,55823,82618,110301,131392],
  3:[88636,62842,87217,116105,138472],
  2:[89835,66573,92178,123617,145703],
  1:[91034,71406,97758,131487,152402],
  0:[92233,75121,104366,140779,159223],
  '-1':[93718,77305,109777,146022,164418],
  '-2':[95203,79079,113942,151738,168077],
  '-3':[96284,82590,117384,159711,171396],
  '-4':[97365,85381,119019,166626,174643],
  '-5':[100648,88250,125685,171420,178524],
  '-6':[102910,90822,130937,172796,181327],
  '-7':[105173,92489,135652,173514,183790],
  '-8':[107054,93218,139125,173878,185312],
  '-9':[107861,null,140660,174954,185316],
  '-10':[null,null,140852,175959,185316]
};

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
    return `<span class="growth-badge ${cls}">${pct >= 0 ? '+' : ''}${pct}%</span>`;
  }
  function fmtN(v) { return v == null ? '<span style="color:#5a6475">—</span>' : Number(v).toLocaleString('pt-BR', {minimumFractionDigits:0, maximumFractionDigits:0}); }
  function fmtMoney(v) { return v == null ? '<span style="color:#5a6475">—</span>' : 'R$ ' + Number(v).toLocaleString('pt-BR', {minimumFractionDigits:0}); }

  let html = `<div style="overflow-x:auto"><table class="hist-table">
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
    </tr></thead><tbody>`;

  rows.forEach((r, i) => {
    const prev = rows[i - 1];
    const isCur = r.year === 2026;
    html += `<tr class="${isCur ? 'current-year' : ''}">
      <td>${r.year}${isCur ? ' ⚡' : ''}</td>
      <td>${fmtN(r.vendas)}${prev ? growth(r.vendas, prev.vendas) : ''}</td>
      <td>${fmtMoney(r.receita)}</td>
      <td>${fmtMoney(r.total)}${prev ? growth(r.total, prev.total) : ''}</td>
      <td></td>
      <td>${fmtMoney(r.comissao)}</td>
      <td>${fmtMoney(r.midiaRir)}</td>
      <td>${fmtMoney(r.terreno)}</td>
      <td>${fmtMoney(r.totalRir)}</td>
    </tr>`;
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

  // Build lookup map from rawShows: key = "eventSuffix|date|time" -> show entry
  // eventSuffix = everything after "Primeira Classe Rock in Rio - " in eventName
  const PREFIX = 'Primeira Classe Rock in Rio - ';
  const showLookup = {};
  for (const r of _rawShows) {
    const suffix = r.eventName ? r.eventName.replace(PREFIX, '') : (r.local || '');
    const key = `${suffix}|${r.date}|${r.time}`;
    if (!showLookup[key]) showLookup[key] = r;
    else { // merge multiple products/sectors for same slot
      showLookup[key] = {
        ...showLookup[key],
        tks: showLookup[key].tks + r.tks,
        subtotal: showLookup[key].subtotal + r.subtotal,
        taxa: showLookup[key].taxa + r.taxa,
      };
    }
  }

  // Generate all rows from MASTER_SCHEDULE (all 1302 slots, including 0-sale ones)
  const wsData = [['Local','Nome Completo','Data Festival','Horário Saída','Ingressos Vendidos','Subtotal (R$)','Taxa (R$)','Total (R$)']];
  for (const [sheetLocal, dateMap] of Object.entries(MASTER_SCHEDULE)) {
    const rawSuffix = LOCAL_NAME_MAP[sheetLocal] || sheetLocal;
    const fullName = PREFIX + rawSuffix;
    for (const [date, times] of Object.entries(dateMap)) {
      for (const time of times) {
        const key = `${rawSuffix}|${date}|${time}`;
        const r = showLookup[key];
        const tks      = r ? r.tks      : 0;
        const subtotal = r ? r.subtotal : 0;
        const taxa     = r ? r.taxa     : 0;
        wsData.push([sheetLocal, fullName, date, time, tks, +subtotal.toFixed(2), +taxa.toFixed(2), +(subtotal+taxa).toFixed(2)]);
      }
    }
  }
  // Compute totals from the wsData rows already built (ensures consistency between tabs)
  let totTks = 0, totSub = 0, totTax = 0;
  for (let i = 1; i < wsData.length; i++) {
    totTks += wsData[i][4] || 0;
    totSub += wsData[i][5] || 0;
    totTax += wsData[i][6] || 0;
  }
  wsData.push(['','','','TOTAL', totTks, +totSub.toFixed(2), +totTax.toFixed(2), +(totSub+totTax).toFixed(2)]);

  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = [{wch:32},{wch:48},{wch:14},{wch:14},{wch:18},{wch:14},{wch:12},{wch:14}];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Shows Detalhados');

  // Build Resumo from wsData (same source as detailed tab — guaranteed to match)
  const sum = [['Local','Ingressos','Subtotal (R$)','Taxa (R$)','Total (R$)']];
  const bl = {};
  for (let i = 1; i < wsData.length - 1; i++) { // skip header and TOTAL row
    const row = wsData[i];
    const loc = row[0];
    if (!bl[loc]) bl[loc] = {t:0,s:0,x:0};
    bl[loc].t += row[4] || 0;
    bl[loc].s += row[5] || 0;
    bl[loc].x += row[6] || 0;
  }
  Object.entries(bl).sort((a,b)=>b[1].t-a[1].t).forEach(([l,v])=>sum.push([l,v.t,+v.s.toFixed(2),+v.x.toFixed(2),+(v.s+v.x).toFixed(2)]));
  // Add total row to Resumo
  sum.push(['TOTAL', totTks, +totSub.toFixed(2), +totTax.toFixed(2), +(totSub+totTax).toFixed(2)]);
  const ws2 = XLSX.utils.aoa_to_sheet(sum);
  ws2['!cols'] = [{wch:32},{wch:12},{wch:14},{wch:12},{wch:14}];
  XLSX.utils.book_append_sheet(wb, ws2, 'Resumo por Local');

  XLSX.writeFile(wb, `primeira-classe-rock-in-rio-${new Date().toISOString().slice(0,10)}.xlsx`);
}

// ═══════════════════════════════════════════════════════════
// EXPORT COMPARATIVO DIA A DIA
// ═══════════════════════════════════════════════════════════
function exportComparativo() {
  if (!_data) { alert('Nenhum dado disponível.'); return; }
  if (typeof XLSX === 'undefined') { alert('SheetJS carregando, tente em breve.'); return; }

  const wb = XLSX.utils.book_new();

  // ── Sheet 1: Comparativo Dia a Dia (todos os anos) ───────
  // Converter salesByDate 2026 para cumulative por contagem regressiva
  const FESTIVAL_2026 = new Date('2026-09-04T12:00:00');
  const salesByDate = (_data.salesByDate || []);
  // Build cumulative 2026 by countdown
  const cum2026 = {};
  let running = 0;
  // sort ascending
  const sorted = [...salesByDate].sort((a,b) => a.date.localeCompare(b.date));
  for (const row of sorted) {
    const d = new Date(row.date + 'T12:00:00');
    const cd = Math.round((FESTIVAL_2026 - d) / 86400000);
    running += row.tks;
    cum2026[cd] = Math.max(running, 0);
  }
  // Forward-fill: for each countdown from 180 down to -10
  const full2026 = {};
  let last = 0;
  for (let cd = 180; cd >= -10; cd--) {
    if (cum2026[cd] !== undefined) last = cum2026[cd];
    full2026[cd] = last > 0 ? last : null;
  }

  // Build comparison sheet
  const compRows = [
    ['# p/ Festival', '2015', '2017', '2019', '2022', '2024', '2026 (atual)']
  ];
  for (let cd = 180; cd >= -10; cd--) {
    const cdKey = cd < 0 ? String(cd) : cd;
    const hist = HIST_COUNTDOWN[cdKey] || [null,null,null,null,null];
    const v2026 = full2026[cd] || null;
    // Skip rows where all years are null/0
    const allZero = hist.every(v => !v) && !v2026;
    if (allZero) continue;
    const label = cd === 0 ? '0 (1º dia)' : cd < 0 ? `${cd} (${Math.abs(cd)}º dia)` : cd;
    compRows.push([label, hist[0]||null, hist[1]||null, hist[2]||null, hist[3]||null, hist[4]||null, v2026]);
  }
  const ws1 = XLSX.utils.aoa_to_sheet(compRows);
  ws1['!cols'] = [{wch:16},{wch:12},{wch:12},{wch:12},{wch:12},{wch:12},{wch:16}];
  XLSX.utils.book_append_sheet(wb, ws1, 'Comparativo Dia a Dia');

  // ── Sheet 2: Vendas Diárias 2026 (detalhe) ───────────────
  const diasRows = [
    ['Data de Venda', 'Dia da Semana', 'Vendas do Dia', 'Cancelamentos do Dia',
     'Líquido do Dia', 'Acumulado (Vendas)', 'Receita do Dia (R$)', 'Receita Acumulada (R$)',
     '# p/ Festival']
  ];
  const diasSemana = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  let cumTks = 0, cumRev = 0;
  for (const row of sorted.filter(d => d.tks !== 0)) {
    const dt = new Date(row.date + 'T12:00:00');
    const cd = Math.round((FESTIVAL_2026 - dt) / 86400000);
    const liq = row.tks;
    cumTks += liq;
    cumRev += row.revenue;
    diasRows.push([
      row.date, diasSemana[dt.getDay()],
      liq > 0 ? liq : 0,
      liq < 0 ? Math.abs(liq) : 0,
      liq, cumTks,
      +row.revenue.toFixed(2), +cumRev.toFixed(2),
      cd
    ]);
  }
  diasRows.push(['', 'TOTAL', '', '', cumTks, cumTks, +cumRev.toFixed(2), +cumRev.toFixed(2), '']);
  const ws2dia = XLSX.utils.aoa_to_sheet(diasRows);
  ws2dia['!cols'] = [{wch:14},{wch:14},{wch:16},{wch:22},{wch:14},{wch:18},{wch:20},{wch:22},{wch:14}];
  XLSX.utils.book_append_sheet(wb, ws2dia, 'Vendas Diárias 2026');

  // ── Sheet 3: Comparativo Histórico ──────────────────────
  const cur2026 = {
    year: 2026,
    vendas:   _data.totalSold    || 0,
    receita:  _data.totalRevenue || 0,
    midia:    null,
    total:    _data.totalRevenue || 0,
    comissao: null, midiaRir: null, terreno: null, totalRir: null
  };
  const allEditions = [...HIST_DATA, cur2026];

  const histRows = [
    // Header grupos
    ['', 'PRIMEIRA CLASSE', '', '', '', '', 'ROCK IN RIO', '', '', ''],
    ['Edição', 'Vendas', 'Receita (R$)', 'Mídia (R$)', 'Total Primeira Classe (R$)', '',
     'Comissão (R$)', 'Mídia RiR (R$)', 'Terreno (R$)', 'Total RiR (R$)']
  ];
  for (const r of allEditions) {
    const pct = r.year !== 2015 ? ((r.vendas - HIST_DATA[HIST_DATA.length-1].vendas) / HIST_DATA[HIST_DATA.length-1].vendas) : null;
    histRows.push([
      r.year === 2026 ? '2026 (atual)' : r.year,
      r.vendas,
      r.receita != null ? +r.receita.toFixed(2) : null,
      r.midia != null   ? +r.midia.toFixed(2) : '—',
      r.total != null   ? +r.total.toFixed(2)  : null,
      '',
      r.comissao != null ? +r.comissao.toFixed(2) : '—',
      r.midiaRir != null ? +r.midiaRir.toFixed(2) : '—',
      r.terreno  != null ? +r.terreno.toFixed(2)  : '—',
      r.totalRir != null ? +r.totalRir.toFixed(2) : '—'
    ]);
  }
  // Growth rows
  histRows.push([]);
  histRows.push(['Crescimento vs. 2024', '', '', '', '', '', '', '', '', '']);
  for (const r of allEditions) {
    const base = HIST_DATA[HIST_DATA.length - 1]; // 2024
    if (r.year === base.year) continue;
    const pctV = ((r.vendas - base.vendas) / base.vendas * 100).toFixed(1) + '%';
    const pctR = r.receita ? ((r.receita - base.receita) / base.receita * 100).toFixed(1) + '%' : '—';
    histRows.push([r.year === 2026 ? '2026 (atual)' : r.year, pctV, pctR]);
  }

  const ws3hist = XLSX.utils.aoa_to_sheet(histRows);
  ws3hist['!cols'] = [{wch:16},{wch:10},{wch:18},{wch:14},{wch:26},{wch:4},{wch:18},{wch:16},{wch:16},{wch:16}];
  XLSX.utils.book_append_sheet(wb, ws3hist, 'Comparativo Histórico');

  // ── Sheet 4: Progresso vs Histórico ─────────────────────
  const progRows = [
    ['Ano de Referência', 'Total de Vendas Históricas', 'Vendas 2026 até agora',
     '% Atingido', 'Faltam (ingressos)', 'Receita Histórica (R$)', 'Receita 2026 até agora (R$)', '% Receita Atingida']
  ];
  const atual2026 = _data.totalSold    || 0;
  const rev2026   = _data.totalRevenue || 0;
  for (const r of HIST_DATA) {
    progRows.push([
      r.year,
      r.vendas,
      atual2026,
      +(atual2026 / r.vendas * 100).toFixed(1) + '%',
      r.vendas - atual2026,
      +r.receita.toFixed(2),
      +rev2026.toFixed(2),
      +(rev2026 / r.receita * 100).toFixed(1) + '%'
    ]);
  }
  const ws4prog = XLSX.utils.aoa_to_sheet(progRows);
  ws4prog['!cols'] = [{wch:20},{wch:24},{wch:22},{wch:14},{wch:20},{wch:22},{wch:26},{wch:20}];
  XLSX.utils.book_append_sheet(wb, ws4prog, 'Progresso vs Histórico');

  // ── Sheet 5: Por Local de Venda ──────────────────────────
  const localMap = {};
  for (const s of _rawShows) {
    const k = (s.eventName || s.local || '').replace('Primeira Classe Rock in Rio - ', '');
    if (!localMap[k]) localMap[k] = { tks: 0, revenue: 0, cancelled: 0 };
    localMap[k].tks      += s.tks;
    localMap[k].revenue  += s.subtotal;
    localMap[k].cancelled += (s.cancelled || 0);
  }
  const localRows = [['Local de Venda', 'Ingressos Vendidos', 'Cancelamentos', 'Líquido', 'Receita (R$)', '% do Total']];
  const totalTks = _data.totalSold || 1;
  Object.entries(localMap)
    .sort((a,b) => b[1].tks - a[1].tks)
    .forEach(([k, v]) => localRows.push([
      k, v.tks, v.cancelled, v.tks - v.cancelled,
      +v.revenue.toFixed(2),
      +(v.tks / totalTks * 100).toFixed(1) + '%'
    ]));
  localRows.push(['TOTAL', totalTks, '', '', +rev2026.toFixed(2), '100%']);
  const ws5local = XLSX.utils.aoa_to_sheet(localRows);
  ws5local['!cols'] = [{wch:40},{wch:20},{wch:16},{wch:12},{wch:18},{wch:12}];
  XLSX.utils.book_append_sheet(wb, ws5local, 'Por Local de Venda');

  const today = new Date().toISOString().slice(0,10);
  XLSX.writeFile(wb, `comparativo-rir-${today}.xlsx`);
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
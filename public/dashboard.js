
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
    return `rgba(${r},${g},70,${0.2 + t * 0.7})`;
  }

  const rows = events.filter(e => e.sold > 0).sort((a, b) => b.sold - a.sold);
  let html = '<table class="heatmap-table"><thead><tr>';
  html += '<th class="event-col">Local</th>';
  DATE_SHORT.forEach(d => { html += `<th>${d}</th>`; });
  html += '</tr></thead><tbody>';
  rows.forEach(ev => {
    html += `<tr><td class="event-name">${ev.name}</td>`;
    FESTIVAL_DATES.forEach(d => {
      const v = heatmap[ev.name]?.[d] || 0;
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

  const wsData = [['ID Evento','Nome do Evento','Local','Produto','Setor','Data Festival','Horário Saída','Ingressos','Subtotal (R$)','Taxa (R$)','Total (R$)']];
  _rawShows.forEach(r => wsData.push([
    r.evId, r.eventName || r.local, r.local, r.productName || r.local, r.sectorName || '',
    r.date, r.time, r.tks, r.subtotal, r.taxa, +(r.subtotal + r.taxa).toFixed(2)
  ]));
  const totS = _rawShows.reduce((s,r)=>s+r.subtotal,0);
  const totT = _rawShows.reduce((s,r)=>s+r.taxa,0);
  wsData.push(['','','','','','TOTAL',_rawShows.reduce((s,r)=>s+r.tks,0),+totS.toFixed(2),+totT.toFixed(2),+(totS+totT).toFixed(2)]);

  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = [{wch:10},{wch:36},{wch:28},{wch:36},{wch:20},{wch:14},{wch:12},{wch:10},{wch:14},{wch:12},{wch:14}];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Shows Detalhados');

  const sum = [['Local','Ingressos','Subtotal (R$)','Taxa (R$)','Total (R$)']];
  const bl = {};
  _rawShows.forEach(r => { if(!bl[r.local]) bl[r.local]={t:0,s:0,x:0}; bl[r.local].t+=r.tks; bl[r.local].s+=r.subtotal; bl[r.local].x+=r.taxa; });
  Object.entries(bl).sort((a,b)=>b[1].t-a[1].t).forEach(([l,v])=>sum.push([l,v.t,+v.s.toFixed(2),+v.x.toFixed(2),+(v.s+v.x).toFixed(2)]));
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

  // ── Sheet 1: Dia a Dia 2026 ──────────────────────────────
  const salesByDate = (_data.salesByDate || []).filter(d => d.tks !== 0);
  const diasRows = [
    ['Data de Venda', 'Dia da Semana', 'Vendas do Dia', 'Cancelamentos do Dia',
     'Líquido do Dia', 'Acumulado (Vendas)', 'Receita do Dia (R$)', 'Receita Acumulada (R$)']
  ];
  const dias = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  let cumTks = 0, cumRev = 0;
  for (const row of salesByDate) {
    const dt = new Date(row.date + 'T12:00:00');
    const diaSemana = dias[dt.getDay()];
    const liq = row.tks;
    cumTks += liq;
    cumRev += row.revenue;
    diasRows.push([
      row.date, diaSemana,
      liq > 0 ? liq : 0,
      liq < 0 ? Math.abs(liq) : 0,
      liq,
      cumTks,
      +row.revenue.toFixed(2),
      +cumRev.toFixed(2)
    ]);
  }
  // Total row
  diasRows.push(['', 'TOTAL', '', '', cumTks, cumTks, +cumRev.toFixed(2), +cumRev.toFixed(2)]);
  const ws1 = XLSX.utils.aoa_to_sheet(diasRows);
  ws1['!cols'] = [{wch:14},{wch:14},{wch:16},{wch:22},{wch:16},{wch:20},{wch:20},{wch:22}];
  XLSX.utils.book_append_sheet(wb, ws1, 'Dia a Dia 2026');

  // ── Sheet 2: Comparativo Histórico ──────────────────────
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

  const ws2 = XLSX.utils.aoa_to_sheet(histRows);
  ws2['!cols'] = [{wch:16},{wch:10},{wch:18},{wch:14},{wch:26},{wch:4},{wch:18},{wch:16},{wch:16},{wch:16}];
  XLSX.utils.book_append_sheet(wb, ws2, 'Comparativo Histórico');

  // ── Sheet 3: Progresso vs Histórico ─────────────────────
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
  const ws3 = XLSX.utils.aoa_to_sheet(progRows);
  ws3['!cols'] = [{wch:20},{wch:24},{wch:22},{wch:14},{wch:20},{wch:22},{wch:26},{wch:20}];
  XLSX.utils.book_append_sheet(wb, ws3, 'Progresso vs Histórico');

  // ── Sheet 4: Por Local de Venda ──────────────────────────
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
  const ws4 = XLSX.utils.aoa_to_sheet(localRows);
  ws4['!cols'] = [{wch:40},{wch:20},{wch:16},{wch:12},{wch:18},{wch:12}];
  XLSX.utils.book_append_sheet(wb, ws4, 'Por Local de Venda');

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
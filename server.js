'use strict';
const express = require('express');
const session = require('express-session');
const fetch   = require('node-fetch');
const cron    = require('node-cron');
const crypto  = require('crypto');
const path    = require('path');

// ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
// CONFIG  (set these as Railway env variables)
// ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
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

// ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
// CROWDER API CONFIG
// ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
const CROWDER_BASE    = 'https://data.getcrowder.com';
// NOTA (2026-06-26): a Ticketmaster trocou a API e forneceu uma chave nova,
// mas essa chave nova n√£o est√° trazendo o hist√≥rico anterior √† sua cria√ß√£o
// (s√≥ mostra vendas recentes, a partir de hoje). A chave antiga continua
// ativa e tem todo o hist√≥rico. Solu√ß√£o tempor√°ria: buscar dados das DUAS
// chaves em refreshData() e mesclar (removendo duplicados por id), at√© a
// Ticketmaster confirmar que a chave nova j√° traz o hist√≥rico completo.
let CROWDER_API_KEY_OLD = process.env.CROWDER_API_KEY_OLD ||
  '0b666073629dd36b18cb760355b4daf7105a7a9cd1d338cd05f9723e971b78c9';
let CROWDER_API_KEY_NEW = process.env.CROWDER_API_KEY_NEW ||
  'fb2c661b2d309f7e6e0a83a02e0cfe54ab8fcdb15561d8457cc490f1679e2e15';
// Mantido por compatibilidade com c√≥digo/endpoints que ainda referenciam uma
// √∫nica chave (ex: /health/rawapi) ‚Äî aponta para a chave antiga (hist√≥rico).
let CROWDER_API_KEY = CROWDER_API_KEY_OLD;
// Filter: only include movements whose event name contains this string.
// Set to '' (empty) to include all events from the organizer.
const EVENT_NAME_FILTER = process.env.EVENT_NAME_FILTER || 'Rock in Rio';

// ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
// STATE
// ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
let state = {
  data: null,           // Aggregated dashboard data
  lastRefresh: null,    // Date of last successful data fetch
  refreshing: false,
  error: null
};

// ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
// CROWDER DATA AGGREGATION
// ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
function aggregateCrowderData(movements, catalogShows = []) {
  const FESTIVAL_DATES = ['2026-09-04','2026-09-05','2026-09-06','2026-09-07',
                          '2026-09-11','2026-09-12','2026-09-13'];
  const DATE_LABELS    = ['Sex 04/Set','S√°b 05/Set','Dom 06/Set','Seg 07/Set',
                          'Sex 11/Set','S√°b 12/Set','Dom 13/Set'];

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

  // ‚îÄ‚îÄ Payment / demographic aggregation maps ‚îÄ‚îÄ
  const payTypeMap = {}, bankMap = {}, brandMap = {}, installMap = {}, cardTypeMap = {};
  const genderMap = {}, ageMap = {}, bankGenderMap = {};
  const freeGiftList = [];  // capture FREE/GIFT transactions in full
  const rateCategoryMap = {}; // unique rate.category.name values

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

    // Rate category tracking (for Club/Cortesia detection)
    const rateCatName = m.rate?.category?.name || '';
    const rateNameFull = m.rate?.name || '';
    const rateCatKey = rateCatName ? `${rateCatName} | ${rateNameFull}` : '';
    if (rateCatKey) rateCategoryMap[rateCatKey] = (rateCategoryMap[rateCatKey] || 0) + 1;

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

    // ‚îÄ‚îÄ Payment / demographic aggregation ‚îÄ‚îÄ
    if ((m.ticketCount || 0) > 0) {
      const pay     = m.payment || m.purchase?.payment || {};
      const cardObj = m.card    || pay.card            || {};
      const buyerObj = m.purchase?.buyerInfo || m.buyer || m.customer || {};

      const payType = pay.type || pay.method || pay.paymentMethod || pay.paymentType || '';
      const bank    = pay.bank || pay.bankName || cardObj.bank || cardObj.bankName || '';
      const rawBrand = pay.cardBrand || pay.brand || cardObj.brand || cardObj.cardBrand || '';
      const BNORM = { mastercard:'MASTERCARD', master:'MASTERCARD', visa:'VISA', amex:'AMEX',
        'american express':'AMEX', americanexpress:'AMEX', elo:'ELO', hipercard:'HIPERCARD',
        discover:'DISCOVER', hiper:'HIPER' };
      const brand = rawBrand ? (BNORM[rawBrand.toLowerCase()] || rawBrand.toUpperCase()) : '';
      const instRaw = pay.instalments ?? pay.installments ?? pay.parcelas ?? cardObj.installments ?? null;
      const install = instRaw != null ? String(instRaw) + '√ó' : '';
      const cardType = pay.cardType || pay.card_type || cardObj.type || cardObj.cardType || '';
      const gender  = String(buyerObj.gender || m.gender || '').toUpperCase();
      const ageRaw  = buyerObj.age ?? buyerObj.ageGroup ?? m.age ?? m.ageGroup ?? null;

      // ‚îÄ‚îÄ Determina label de pagamento ‚îÄ‚îÄ
      // Cortesia Club / Cortesia sobrep√µem FREE/GIFT
      const rateCat = m.rate?.category?.name || '';
      let pt = '';
      if (rateCat === 'Cortesia Club') {
        pt = 'Cortesia Club';
      } else if (rateCat === 'Cortesia') {
        pt = 'Cortesia';
      } else if (payType && payType !== 'FREE' && payType !== 'GIFT') {
        pt = payType === 'CREDIT_CARD'  ? 'Cr√©dito'
          : payType === 'PIX'           ? 'PIX'
          : payType === 'DEBIT_CARD'    ? 'D√©bito'
          : payType === 'BOLETO'        ? 'Boleto'
          : payType;
      }
      if (pt) payTypeMap[pt] = (payTypeMap[pt] || 0) + 1;

      // Capture Cortesia Club / Cortesia details for export
      if (rateCat === 'Cortesia Club' || rateCat === 'Cortesia' || payType === 'FREE' || payType === 'GIFT') {
        const buyer = buyerObj;
        const purch = m.purchase || {};
        const channel = purch.channel || {};
        const geo = purch.geoInfo || {};
        freeGiftList.push({
          tipo:          rateCat || payType,
          data_compra:   (m.date || '').substring(0, 10),
          hora_compra:   (m.date || '').substring(11, 16),
          id_compra:     purch.id || m.id || '',
          produto:       m.product?.name || '',
          show:          (show ? show.name : ''),
          data_show:     (show ? (show.startDate || '').substring(0, 10) : ''),
          evento:        m.event?.name || '',
          qtd_ingressos: m.ticketCount || 0,
          valor_face:    m.amount || 0,
          rate_name:     m.rate?.name || '',
          rate_category: rateCat,
          pay_type:      payType,
          voucher:       pay.voucher || '',
          canal:         channel.name || '',
          canal_tipo:    channel.type || '',
          nome:          `${buyer.firstName || purch.user?.firstName || ''} ${buyer.lastName || purch.user?.lastName || ''}`.trim(),
          email:         buyer.email || purch.user?.email || '',
          genero:        buyer.gender || '',
          idade:         buyer.age || '',
          cidade:        geo.city || '',
          estado:        geo.region || '',
          pais:          geo.country || '',
          device:        purch.deviceInfo?.deviceType || '',
          os:            purch.deviceInfo?.os || ''
        });
      }
      if (bank)    bankMap[bank]   = (bankMap[bank]   || 0) + 1;
      if (brand)   brandMap[brand] = (brandMap[brand] || 0) + 1;
      if (install) installMap[install] = (installMap[install] || 0) + 1;
      if (cardType) {
        const ct = cardType === 'credit'  ? 'Cr√©dito'
          : cardType === 'debit'   ? 'D√©bito'
          : cardType === 'prepaid' ? 'Pr√©-pago'
          : cardType;
        cardTypeMap[ct] = (cardTypeMap[ct] || 0) + 1;
      }
      if (gender) genderMap[gender] = (genderMap[gender] || 0) + 1;
      if (ageRaw !== null && ageRaw !== undefined && ageRaw !== '') {
        let group = String(ageRaw);
        if (!group.includes('-') && !group.includes('+') && !group.includes('<')) {
          const n = parseInt(group);
          if (!isNaN(n)) {
            group = n < 18 ? '<18' : n < 25 ? '18-24' : n < 35 ? '25-34'
              : n < 45 ? '35-44' : n < 55 ? '45-54' : '55+';
          }
        }
        ageMap[group] = (ageMap[group] || 0) + 1;
      }
      if (bank && gender) {
        if (!bankGenderMap[bank]) bankGenderMap[bank] = { F: 0, M: 0, O: 0 };
        const gKey = gender.startsWith('F') ? 'F' : gender.startsWith('M') ? 'M' : 'O';
        bankGenderMap[bank][gKey] = (bankGenderMap[bank][gKey] || 0) + 1;
      }
    }
  }

  // Build rawShows (dashboard-compatible format) ‚Äî only shows with sales
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
    totalReserved: 0, totalReservedRevenue: 0,
    paymentStats: { payTypeMap, bankMap, brandMap, installMap, cardTypeMap, genderMap, ageMap, bankGenderMap },
    freeGiftList,
    rateCategoryMap
  };
}

// ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
// DATA REFRESH (Crowder API with pagination)
// ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
async function refreshData() {
  if (state.refreshing) return;
  state.refreshing = true;
  state.error = null;
  console.log(`[${new Date().toISOString()}] Iniciando refresh (Crowder API)...`);

  const globalTimeout = setTimeout(() => {
    if (state.refreshing) {
      state.refreshing = false;
      state.error = 'Timeout: refresh demorou mais de 3 minutos.';
      console.error('[refresh timeout] Abortado ap√≥s 3 minutos.');
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
      if (pages > 2000) { console.warn(`[refresh] (${label}) Safety limit: 2000 p√°ginas`); break; }
    }
    console.log(`[refresh] (${label}) ${movements.length} movements em ${pages} p√°gina(s)`);
    return movements;
  }

  // Fetch the show catalog for a single API key
  async function fetchCatalog(apiKey, label) {
    try {
      const catRes = await fetch(`${CROWDER_BASE}/shows/organizer`, {
        headers: { 'ApiKey': apiKey }
      });
      if (!catRes.ok) {
        console.warn(`[refresh] (${label}) Cat√°logo shows: HTTP ${catRes.status}`);
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
      console.log(`[refresh] (${label}) Cat√°logo: ${filtered.length} shows`);
      return filtered;
    } catch (e) {
      console.warn(`[refresh] (${label}) Falha ao buscar cat√°logo de shows:`, e.message);
      return [];
    }
  }

  try {
    // ‚îÄ‚îÄ Busca das DUAS chaves (antiga = hist√≥rico, nova = vendas recentes) ‚îÄ‚îÄ
    // Solu√ß√£o tempor√°ria at√© a Ticketmaster confirmar que a chave nova j√°
    // traz o hist√≥rico completo. Mescla por id de movimento, sem duplicar.
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

    // Cat√°logo de shows ‚Äî mescla das duas chaves, dedup por showId/productId
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

// ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
// EXPRESS APP
// ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Serve static JS files (dashboard.js) ‚Äî no auth required since no secrets in JS
app.use('/js', express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 } // 8h session
}));

// ‚îÄ‚îÄ Auth middleware ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
function requireAuth(req, res, next) {
  if (req.session.user) return next();
  res.redirect('/login');
}

// ‚îÄ‚îÄ Public: list loaded usernames (no passwords exposed) ‚îÄ‚îÄ‚îÄ‚îÄ
app.get('/health/users', (req, res) => {
  res.json({ users: Object.keys(USERS), count: Object.keys(USERS).length });
});

// ‚îÄ‚îÄ Debug: proxy Crowder shows catalog ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
app.get('/api/debug/shows', requireAuth, async (req, res) => {
  try {
    const r = await fetch(`${CROWDER_BASE}/shows/organizer`, { headers: { 'ApiKey': CROWDER_API_KEY } });
    const text = await r.text();
    res.json({ status: r.status, body: text.substring(0, 5000) });
  } catch(e) {
    res.json({ error: e.message });
  }
});

// ‚îÄ‚îÄ Public health check (no auth) ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    lastRefresh: state.lastRefresh,
    refreshing: state.refreshing,
    error: state.error,
    totalSold: state.data?.totalSold ?? null,
    totalRevenue: state.data?.totalRevenue ?? null,
    showCount: state.data?.rawShows?.length ?? null,
    rateCategoryMap: state.data?.rateCategoryMap ?? null
  });
});

// ‚îÄ‚îÄ Public: sales by date for spreadsheet export (no auth) ‚îÄ
app.get('/health/salesbydate', (req, res) => {
  if (!state.data) return res.json({ ok: false, message: 'Sem dados ainda' });
  res.json({ ok: true, salesByDate: state.data.salesByDate || [] });
});


// ‚îÄ‚îÄ Debug: check current Crowder API key status (auth required).
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

// ‚îÄ‚îÄ Public debug: list unique events (no auth) ‚îÄ
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

// ‚îÄ‚îÄ Login page ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
app.get('/login', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashboard Rock in Rio ‚Äî Login</title>
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
  <p>Dashboard de Vendas ‚Äî Acesso Restrito</p>
  ${req.query.error ? '<div class="err">Usu√°rio ou senha incorretos.</div>' : ''}
  <form method="POST" action="/login">
    <label>Usu√°rio</label>
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

// ‚îÄ‚îÄ API: data endpoint ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
app.get('/api/data', requireAuth, (req, res) => {
  res.json({
    data:        state.data,
    lastRefresh: state.lastRefresh,
    refreshing:  state.refreshing,
    error:       state.error
  });
});

app.post('/api/refresh', requireAuth, async (req, res) => {
  if (state.refreshing) return res.json({ ok: false, message: 'J√° est√° atualizando...' });
  refreshData(); // fire and don't wait
  res.json({ ok: true, message: 'Atualiza√ß√£o iniciada...' });
});

// ‚îÄ‚îÄ Debug: force refresh ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
app.get('/api/debug/refresh', requireAuth, async (req, res) => {
  try {
    await refreshData();
    res.json({ ok: true, totalSold: state.data?.totalSold, error: state.error });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ‚îÄ‚îÄ Admin: update Crowder API key at runtime ‚îÄ
app.post('/admin/update-api-key', (req, res) => {
  const secret = req.headers['x-admin-secret'] || req.body?.adminSecret;
  if (!secret || secret !== (process.env.ADMIN_SECRET || 'rir-admin-2026')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { apiKey } = req.body || {};
  if (!apiKey || typeof apiKey !== 'string' || apiKey.length < 10) {
    return res.status(400).json({ error: 'apiKey inv√°lida' });
  }
  CROWDER_API_KEY = apiKey;
  res.json({ ok: true, message: 'API key atualizada. Atualizando dados...' });
  refreshData();
});

// ‚îÄ‚îÄ Dashboard (main page) ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
app.get('/', requireAuth, (req, res) => {
  res.send(getDashboardHTML(req.session.user));
});

/// ‚îÄ‚îÄ API: gratuidades/cortesia export ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
app.get('/api/gratuidades', requireAuth, (req, res) => {
  if (!state.data) return res.json({ loading: true });
  res.json({ list: state.data.freeGiftList || [], updatedAt: state.lastRefresh });
});

// ‚îÄ‚îÄ API: cortesia-club export (CSV download) ‚îÄ
app.get('/api/cortesia-club/csv', requireAuth, (req, res) => {
  if (!state.data) return res.status(503).send('Data not loaded');
  const list = (state.data.freeGiftList || []).filter(r =>
    r.rate_category === 'Cortesia Club' || r.rate_category === 'Cortesia'
  );
  const cols = ['tipo','data_compra','hora_compra','id_compra','produto','show','data_show','evento','qtd_ingressos','valor_face','rate_name','rate_category','pay_type','voucher','canal','canal_tipo','nome','email','genero','idade','cidade','estado','pais','device','os'];
  const hdr = ['Tipo','Data Compra','Hora','ID Compra','Produto','Show','Data Show','Evento','Qtd','Valor Face','Rate Name','Rate Category','Pay Type','Voucher','Canal','Canal Tipo','Nome','Email','G√™nero','Idade','Cidade','Estado','Pa√≠s','Device','OS'];
  const esc = v => '"' + String(v==null?'':v).replace(/"/g,'""') + '"';
  const lines = [hdr.map(esc).join(','), ...list.map(r => cols.map(c => esc(r[c])).join(','))];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="cortesia_club.csv"');
  res.send('Ôªø' + lines.join('\r\n')); // BOM for Excel

});

// ‚îÄ‚îÄ API: pagamento-data endpoint ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
app.get('/api/pagamento-data', requireAuth, (req, res) => {
  if (!state.data) return res.json({ loading: true });
  const ps = state.data.paymentStats || {};

  const bankSorted    = Object.entries(ps.bankMap    || {}).sort((a,b) => b[1]-a[1]);
  const brandSorted   = Object.entries(ps.brandMap   || {}).sort((a,b) => b[1]-a[1]);
  const installSorted = Object.entries(ps.installMap || {})
    .sort((a,b) => parseInt(a[0]||0) - parseInt(b[0]||0));

  const total    = state.data.totalSold || 0;
  const ccCount  = (ps.payTypeMap || {})['Cr√©dito'] || 0;
  const pixCount = (ps.payTypeMap || {})['PIX']     || 0;
  const debCount = (ps.payTypeMap || {})['D√©bito']  || 0;

  res.json({
    loading:       false,
    updated_at:    state.lastRefresh ? new Date(state.lastRefresh).toLocaleString('pt-BR') : null,
    total,
    ccCount, pixCount, debCount,
    payTypeMap:    ps.payTypeMap    || {},
    bankSorted,
    brandSorted,
    installSorted,
    cardTypeMap:   ps.cardTypeMap   || {},
    genderMap:     ps.genderMap     || {},
    ageMap:        ps.ageMap        || {},
    bankGenderMap: ps.bankGenderMap || {},
    hasData:       bankSorted.length > 0 || brandSorted.length > 0
  });
});

// ‚îÄ‚îÄ Sub-page: Pagamento √ó Perfil ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
app.get('/pagamento', requireAuth, (req, res) => {
  res.send(getPagamentoHTML(req.session.user));
});

// ‚îÄ‚îÄ API: velocidade-data endpoint ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
app.get('/api/velocidade-data', requireAuth, (req, res) => {
  if (!state.data) return res.json({ loading: true });

  const sbd = (state.data.salesByDate || []).filter(d => (d.tks||0) > 0);
  if (!sbd.length) return res.json({ loading: false, hasData: false });

  const FESTIVAL_START = new Date('2026-09-04T00:00:00-03:00');
  const now = new Date();
  const daysLeft = Math.max(0, Math.ceil((FESTIVAL_START - now) / 86400000));

  // Totals
  const totalTks = sbd.reduce((s,d) => s + (d.tks||0), 0);
  const totalDays = sbd.length;
  const avgPerDay = Math.round(totalTks / totalDays);

  // Best day
  const bestDay = sbd.reduce((best, d) => (d.tks||0) > (best.tks||0) ? d : best, sbd[0]);

  // Last 7 days avg
  const last7 = sbd.slice(-7);
  const avg7  = Math.round(last7.reduce((s,d) => s+(d.tks||0), 0) / Math.min(7, last7.length));

  // Last 30 days avg
  const last30 = sbd.slice(-30);
  const avg30  = Math.round(last30.reduce((s,d) => s+(d.tks||0), 0) / Math.min(30, last30.length));

  // Weekly grouping (Sunday-based)
  const weekMap = {};
  for (const d of sbd) {
    const dt = new Date(d.date + 'T12:00:00Z');
    const day = dt.getDay(); // 0=Sun
    const monday = new Date(dt); monday.setDate(dt.getDate() - ((day+6)%7));
    const wk = monday.toISOString().substring(0,10);
    if (!weekMap[wk]) weekMap[wk] = { weekStart: wk, tks: 0, revenue: 0 };
    weekMap[wk].tks     += d.tks     || 0;
    weekMap[wk].revenue += d.revenue || 0;
  }
  const weeklyData = Object.values(weekMap).sort((a,b) => a.weekStart.localeCompare(b.weekStart));

  // 7-day moving average series
  const maWindow = 7;
  const maData = sbd.map((d, i) => {
    const slice = sbd.slice(Math.max(0, i - maWindow + 1), i + 1);
    return Math.round(slice.reduce((s,x) => s+(x.tks||0), 0) / slice.length);
  });

  // Projection: days remaining √ó avg7
  const projectedRemaining = avg7 * daysLeft;
  const projectedTotal     = totalTks + projectedRemaining;

  res.json({
    loading: false, hasData: true,
    updated_at: state.lastRefresh ? new Date(state.lastRefresh).toLocaleString('pt-BR') : null,
    totalTks, totalDays, avgPerDay, avg7, avg30,
    daysLeft, bestDay, projectedTotal, projectedRemaining,
    dailyData:  sbd.map(d => ({ date: d.date, tks: d.tks, revenue: d.revenue })),
    maData,
    weeklyData
  });
});

// ‚îÄ‚îÄ Sub-page: Velocidade de Vendas ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
app.get('/velocidade', requireAuth, (req, res) => {
  res.send(getVelocidadeHTML(req.session.user));
});

// ‚îÄ‚îÄ Sub-page: Lista de Eventos ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
app.get('/eventos', requireAuth, (req, res) => {
  res.send(getEventosHTML(req.session.user));
});

// ‚îÄ‚îÄ Sub-page: Eventos Lotados ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
app.get('/lotados', requireAuth, (req, res) => {
  res.send(getLotadosHTML(req.session.user));
});

// ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
// SHARED CSS VARIABLES (dark theme)
// ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
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

// ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
// DASHBOARD HTML
// ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
function getDashboardHTML(username) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Primeira Classe Rock in Rio ‚Äî Dashboard de Vendas</title>
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
  /* ‚îÄ‚îÄ HEATMAP ‚îÄ‚îÄ */
  .heatmap-wrap{overflow-x:auto}
  .heatmap-table{border-collapse:collapse;min-width:100%}
  .heatmap-table th{padding:8px 12px;font-size:10px;font-weight:600;color:var(--muted);text-align:center;white-space:nowrap}
  .heatmap-table th.event-col{text-align:left;min-width:170px}
  .heatmap-table td{padding:5px 8px;font-size:11px;text-align:center;border:1px solid var(--border)}
  .heatmap-table td.event-name{text-align:left;font-weight:600;white-space:nowrap;background:var(--surface2)}
  .hm-cell{border-radius:4px;padding:3px 8px;font-weight:700;font-size:11px;display:inline-block;min-width:30px}
  /* ‚îÄ‚îÄ EVENTS TABLE ‚îÄ‚îÄ */
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
  /* ‚îÄ‚îÄ MODAL HIST√ìRICO ‚îÄ‚îÄ */
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
  /* ‚îÄ‚îÄ PROJE√á√ÉO ‚îÄ‚îÄ */
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
  /* ‚îÄ‚îÄ RANKING ‚îÄ‚îÄ */
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
  /* ‚îÄ‚îÄ NAV CARDS ‚îÄ‚îÄ */
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
      <h1>Primeira Classe ‚Äî Dashboard de Vendas</h1>
      <p>Setembro 2026 ¬∑ Logado como <strong>${username}</strong></p>
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
    <button class="btn" onclick="exportComparativo()" id="export-comp-btn" style="background:#2ec27e;color:#fff">‚Üì Comparativo</button>
    <button class="btn btn-primary" onclick="exportXLS()" id="export-btn">‚Üì XLS</button>
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
  <a href="/eventos" class="nav-card">
    <div class="nav-card-icon">üóìÔ∏è</div>
    <div><div class="nav-card-title">Lista de Eventos</div><div class="nav-card-desc">Todos os shows com status de ocupa√ß√£o</div></div>
    <div class="nav-card-arrow">‚Ä∫</div>
  </a>
  <a href="/lotados" class="nav-card" style="border-color:#e6394644">
    <div class="nav-card-icon">üö®</div>
    <div><div class="nav-card-title">Eventos Lotados</div><div class="nav-card-desc">Hor√°rios esgotados e novos hor√°rios</div></div>
    <div class="nav-card-arrow">‚Ä∫</div>
  </a>
  <a href="/pagamento" class="nav-card" style="border-color:#5b8dee44">
    <div class="nav-card-icon">üí≥</div>
    <div><div class="nav-card-title">Pagamento √ó Perfil</div><div class="nav-card-desc">Bandeiras, bancos, parcelamento e perfil do comprador</div></div>
    <div class="nav-card-arrow">‚Ä∫</div>
  </a>
  <a href="/velocidade" class="nav-card" style="border-color:#2ec27e44">
    <div class="nav-card-icon">üöÄ</div>
    <div><div class="nav-card-title">Velocidade de Vendas</div><div class="nav-card-desc">Ritmo di√°rio, tend√™ncia e proje√ß√£o at√© o festival</div></div>
    <div class="nav-card-arrow">‚Ä∫</div>
  </a>
</div>

<!-- MODAL COMPARATIVO HIST√ìRICO -->
<div class="modal-overlay hidden" id="hist-modal" onclick="if(event.target===this)closeHistorico()">
  <div class="modal-box">
    <button class="modal-close" onclick="closeHistorico()">√ó</button>
    <div style="margin-bottom:20px">
      <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);margin-bottom:4px">S√©rie Hist√≥rica</div>
      <h2 style="font-size:22px;font-weight:800">Comparativo de Edi√ß√µes ‚Äî Primeira Classe</h2>
      <p style="font-size:12px;color:var(--muted);margin-top:4px">Snapshot na mesma janela de anteced√™ncia ao 1¬∫ dia do festival ¬∑ 2026 = dados ao vivo</p>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:24px">
      <div class="chart-card">
        <div class="chart-title">Ingressos Vendidos por Edi√ß√£o</div>
        <canvas id="histTicketsChart" height="200"></canvas>
      </div>
      <div class="chart-card">
        <div class="chart-title">Receita Total (R$) por Edi√ß√£o</div>
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

// ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
// TEMPO DE VENDAS PAGE
// ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
function getTempoHTML(username) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tempo de Vendas ‚Äî Rock in Rio 2026</title>
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
    <a href="/" class="btn btn-back" style="text-decoration:none">‚Üê Voltar</a>
    <div class="logo-badge">Rock in Rio 2026</div>
    <div><h1>Tempo de Vendas</h1><p>An√°lise temporal das vendas de Primeira Classe</p></div>
  </div>
  <div class="header-right">
    <button class="btn btn-secondary" onclick="loadData()">‚Üª Atualizar</button>
    <form method="POST" action="/logout" style="margin:0"><button class="btn btn-secondary" type="submit">Sair</button></form>
  </div>
</header>
<div id="status-bar"><span class="status-dot" id="status-dot"></span><span id="status-text">Conectando...</span></div>
<div class="content">
  <div class="kpis">
    <div class="kpi gold"><div class="kpi-icon">üìÖ</div><div class="kpi-label">Melhor Semana</div><div class="kpi-val" id="kpi-semana" style="font-size:14px">‚Äî</div><div class="kpi-sub" id="kpi-semana-n">‚Äî</div></div>
    <div class="kpi blue"><div class="kpi-icon">üìÜ</div><div class="kpi-label">Melhor Dia da Semana</div><div class="kpi-val" id="kpi-dia">‚Äî</div><div class="kpi-sub" id="kpi-dia-n">‚Äî</div></div>
    <div class="kpi green"><div class="kpi-icon">üé´</div><div class="kpi-label">Total Ingressos</div><div class="kpi-val" id="kpi-total">‚Äî</div><div class="kpi-sub">registros</div></div>
    <div class="kpi pink"><div class="kpi-icon">‚è≥</div><div class="kpi-label">Dias at√© o Festival</div><div class="kpi-val" id="kpi-dias">‚Äî</div><div class="kpi-sub">at√© 04/09/2026</div></div>
  </div>

  <div class="section">
    <div class="section-title">üìÖ Vendas por Semana</div>
    <div class="chart-wrap-tall"><canvas id="chart-semanas"></canvas></div>
  </div>

  <div class="charts-row">
    <div class="section">
      <div class="section-title">üìÜ Vendas por Dia da Semana</div>
      <div class="chart-wrap"><canvas id="chart-diasemana"></canvas></div>
    </div>
    <div class="section">
      <div class="section-title">üìà Acumulado de Vendas</div>
      <div class="chart-wrap"><canvas id="chart-acumulado"></canvas></div>
    </div>
  </div>

  <div class="charts-row-3">
    <div class="section">
      <div class="section-title">üèÜ Top Semanas</div>
      <div class="table-scroll"><table class="rank-table" id="tbl-semanas"><thead><tr><th>#</th><th>Semana</th><th>Ingressos</th></tr></thead><tbody></tbody></table></div>
    </div>
    <div class="section">
      <div class="section-title">üèÜ Top Dias da Semana</div>
      <div class="table-scroll"><table class="rank-table" id="tbl-dias"><thead><tr><th>#</th><th>Dia</th><th>Ingressos</th></tr></thead><tbody></tbody></table></div>
    </div>
    <div class="section">
      <div class="section-title">üìÖ √öltimos 10 Dias</div>
      <div class="table-scroll"><table class="rank-table" id="tbl-recent"><thead><tr><th>Data</th><th>Ingressos</th><th>Receita</th></tr></thead><tbody></tbody></table></div>
    </div>
  </div>
</div>
<script>
const DIAS = ['Domingo','Segunda','Ter√ßa','Quarta','Quinta','Sexta','S√°bado'];
const DIAS_C = ['Dom','Seg','Ter','Qua','Qui','Sex','S√°b'];
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
    document.getElementById('status-text').textContent = 'Dados ao vivo ¬∑ Atualizado: '+(json.lastRefresh?new Date(json.lastRefresh).toLocaleString('pt-BR'):'‚Äî');
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

// ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
// PRODUTOS & SETORES PAGE
// ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
function getPerfilHTML(username) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Produtos & Setores ‚Äî Rock in Rio 2026</title>
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
    <a href="/" class="btn btn-back" style="text-decoration:none">‚Üê Voltar</a>
    <div class="logo-badge">Rock in Rio 2026</div>
    <div><h1>Produtos & Setores</h1><p>Breakdown de vendas por setor, produto e data do show</p></div>
  </div>
  <div class="header-right">
    <button class="btn btn-secondary" onclick="loadData()">‚Üª Atualizar</button>
    <form method="POST" action="/logout" style="margin:0"><button class="btn btn-secondary" type="submit">Sair</button></form>
  </div>
</header>
<div id="status-bar"><span class="status-dot" id="status-dot"></span><span id="status-text">Conectando...</span></div>
<div class="content">
  <div class="kpis">
    <div class="kpi"><div class="kpi-icon">üé´</div><div class="kpi-label">Total Vendido</div><div class="kpi-val" id="kpi-total">‚Äî</div><div class="kpi-sub">ingressos</div></div>
    <div class="kpi green"><div class="kpi-icon">üí∞</div><div class="kpi-label">Receita Total</div><div class="kpi-val" id="kpi-receita" style="font-size:16px">‚Äî</div></div>
    <div class="kpi gold"><div class="kpi-icon">üèÜ</div><div class="kpi-label">Top Setor</div><div class="kpi-val" id="kpi-top-setor" style="font-size:15px">‚Äî</div><div class="kpi-sub" id="kpi-top-setor-n">‚Äî</div></div>
    <div class="kpi blue"><div class="kpi-icon">üé™</div><div class="kpi-label">Top Show</div><div class="kpi-val" id="kpi-top-show" style="font-size:13px">‚Äî</div><div class="kpi-sub" id="kpi-top-show-n">‚Äî</div></div>
  </div>

  <div class="charts-row">
    <div class="section">
      <div class="section-title">üé™ Ingressos por Show / Data</div>
      <div class="chart-wrap-tall"><canvas id="chart-shows"></canvas></div>
    </div>
    <div class="section">
      <div class="section-title">üéüÔ∏è Ingressos por Setor</div>
      <div class="chart-wrap-tall"><canvas id="chart-setores"></canvas></div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">üì¶ Top Produtos</div>
    <div class="chart-wrap" style="height:260px"><canvas id="chart-produtos"></canvas></div>
  </div>

  <div class="section">
    <div class="section-title">üìã Detalhamento por Produto</div>
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
const fmtR = n => 'R$¬†'+Number(n||0).toLocaleString('pt-BR',{minimumFractionDigits:0,maximumFractionDigits:0});
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

  const showLabels = showEntries.slice(0,12).map(([k])=>k.length>28?k.substring(0,28)+'‚Ä¶':k);
  const showVals = showEntries.slice(0,12).map(([,v])=>v.tks);
  mk('chart-shows',{type:'bar',data:{labels:showLabels,datasets:[{data:showVals,backgroundColor:PALETTE,borderRadius:4}]},options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>fmt(c.raw)+' ingressos'}}},scales:{x:{ticks:{color:'#7a8499',callback:v=>fmt(v)},grid:{color:'#252d3d'}},y:{ticks:{color:'#e8eaf0',font:{size:11}},grid:{color:'#252d3d'}}}}});

  // By setor
  const setorMap = {};
  shows.forEach(s=>{const k=s.sectorName||s.productName||'Outro';if(!setorMap[k])setorMap[k]=0;setorMap[k]+=s.tks;});
  const setorEntries = Object.entries(setorMap).sort((a,b)=>b[1]-a[1]);
  const topSetor = setorEntries[0];
  if(topSetor){document.getElementById('kpi-top-setor').textContent=topSetor[0].substring(0,18);document.getElementById('kpi-top-setor-n').textContent=fmt(topSetor[1])+' ingressos';}
  mk('chart-setores',{type:'doughnut',data:{labels:setorEntries.map(([k])=>k.length>22?k.substring(0,22)+'‚Ä¶':k),datasets:[{data:setorEntries.map(([,v])=>v),backgroundColor:PALETTE,borderWidth:2,borderColor:'#131720'}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'right',labels:{color:'#e8eaf0',font:{size:11},boxWidth:14}},tooltip:{callbacks:{label:c=>fmt(c.raw)+' ingressos'}}}}});

  // By product
  const prodMap = {};
  shows.forEach(s=>{const k=s.productName||s.sectorName||'Outro';if(!prodMap[k])prodMap[k]={tks:0,rev:0};prodMap[k].tks+=s.tks;prodMap[k].rev+=(s.subtotal||0);});
  const prodEntries = Object.entries(prodMap).sort((a,b)=>b[1].tks-a[1].tks);
  const pLabels = prodEntries.slice(0,10).map(([k])=>k.length>30?k.substring(0,30)+'‚Ä¶':k);
  const pVals = prodEntries.slice(0,10).map(([,v])=>v.tks);
  const maxP = Math.max(...pVals,1);
  mk('chart-produtos',{type:'bar',data:{labels:pLabels,datasets:[{data:pVals,backgroundColor:pVals.map(v=>v===maxP?'#ffd700':'#5b8dee'),borderRadius:4}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>fmt(c.raw)+' ingressos'}}},scales:{x:{ticks:{color:'#7a8499',font:{size:10},maxRotation:30},grid:{color:'#252d3d'}},y:{ticks:{color:'#7a8499',callback:v=>fmt(v)},grid:{color:'#252d3d'}}}}});

  // Table
  document.querySelector('#tbl-produtos tbody').innerHTML = shows
    .sort((a,b)=>b.tks-a.tks)
    .map((s,i)=>\`<tr><td style="color:var(--muted)">\${i+1}</td><td style="font-weight:600">\${(s.productName||s.sectorName||'‚Äî').substring(0,30)}</td><td style="color:var(--muted);font-size:12px">\${(s.showName||s.local||'‚Äî').substring(0,25)}</td><td class="num">\${fmt(s.tks)}</td><td class="rev">\${fmtR(s.subtotal||0)}</td></tr>\`)
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
    document.getElementById('status-text').textContent='Dados ao vivo ¬∑ '+(json.lastRefresh?new Date(json.lastRefresh).toLocaleString('pt-BR'):'‚Äî');
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

// ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
// LISTA DE EVENTOS PAGE
// ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
function getEventosHTML(username) {
  // Capacidades conhecidas por produto/setor (ingressos dispon√≠veis)
  // Ajuste conforme necess√°rio
  const CAPACIDADES = {
    'Primeira Classe - Sexta': 500,
    'Primeira Classe - S√°bado': 500,
    'Primeira Classe - Domingo': 500,
    'Primeira Classe - Segunda': 500,
    'Primeira Classe - Quinta': 500,
    'Primeira Classe - Sexta 2': 500,
    'Primeira Classe - S√°bado 2': 500,
  };
  const DEFAULT_CAP = 46; // capacidade padr√£o por produto/hor√°rio

  const FESTIVAL_DATES = ['2026-09-04','2026-09-05','2026-09-06','2026-09-07',
                          '2026-09-11','2026-09-12','2026-09-13'];
  const DATE_LABELS = {
    '2026-09-04': 'Sexta-feira, 04 de Setembro',
    '2026-09-05': 'S√°bado, 05 de Setembro',
    '2026-09-06': 'Domingo, 06 de Setembro',
    '2026-09-07': 'Segunda-feira, 07 de Setembro',
    '2026-09-11': 'Sexta-feira, 11 de Setembro',
    '2026-09-12': 'S√°bado, 12 de Setembro',
    '2026-09-13': 'Domingo, 13 de Setembro',
  };

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Lista de Eventos ‚Äî Rock in Rio 2026</title>
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
    <div><h1>Lista de Eventos</h1><p>Ocupa√ß√£o e disponibilidade por show</p></div>
  </div>
  <div class="header-right">
    <a href="/" class="btn btn-back">‚Üê Voltar ao Dashboard</a>
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
function fmtR(n) { return 'R$¬†'+(n||0).toLocaleString('pt-BR',{minimumFractionDigits:0,maximumFractionDigits:0}); }
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
  if (level === 'critical') return 'üö® LOTA√á√ÉO CR√çTICA';
  if (level === 'warning')  return '‚ö†Ô∏è QUASE ESGOTADO';
  if (level === 'ok')       return '‚úì DISPON√çVEL';
  return '‚Äî SEM CAPACIDADE';
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
    <div class="summary-item"><div class="summary-label">Alertas de Ocupa√ß√£o</div><div class="summary-value" style="color:\${alertCount>0?'var(--accent)':'var(--muted)'}">\${alertCount}</div></div>
  </div>
  <div class="legend">
    <div class="legend-item"><div class="legend-dot" style="background:var(--accent)"></div>‚â• 90% ‚Äî Lota√ß√£o cr√≠tica</div>
    <div class="legend-item"><div class="legend-dot" style="background:var(--accent2)"></div>‚â• 80% ‚Äî Quase esgotado</div>
    <div class="legend-item"><div class="legend-dot" style="background:var(--green)"></div>< 80% ‚Äî Dispon√≠vel</div>
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
      <div class="day-stats"><strong>\${fmt(daySold)}</strong> vendidos\${dayAlerts>0?' &nbsp;¬∑&nbsp; <span style="color:var(--accent)">'+dayAlerts+' alerta'+(dayAlerts>1?'s':'')+'</span>':''}</div>
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
          <div class="event-name">\${s.productName || s.local || s.sectorName || '‚Äî'}</div>
          <div class="alert-badge \${level}">\${alertLabel(level)}</div>
        </div>
        <div class="event-meta">
          <span>üïê \${s.time||'‚Äî'}</span>
          <span class="meta-sep">¬∑</span>
          <span>\${s.sectorName||s.local||'‚Äî'}</span>
        </div>
        \${cap ? \`<div class="progress-wrap">
          <div class="progress-label">
            <span>Ocupa√ß√£o</span>
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
            <div class="stat-label">Dispon√≠veis</div>
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
    document.getElementById('status-text').textContent = 'Dados ao vivo ¬∑ ' + (json.lastRefresh ? new Date(json.lastRefresh).toLocaleString('pt-BR') : '‚Äî');
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

// ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
// SUB-PAGE: EVENTOS LOTADOS
// ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
function getLotadosHTML(username) {
  const FESTIVAL_DATES = ['2026-09-04','2026-09-05','2026-09-06','2026-09-07',
                          '2026-09-11','2026-09-12','2026-09-13'];
  const DATE_LABELS = {
    '2026-09-04':'Sex 04/Set','2026-09-05':'S√°b 05/Set','2026-09-06':'Dom 06/Set',
    '2026-09-07':'Seg 07/Set','2026-09-11':'Sex 11/Set','2026-09-12':'S√°b 12/Set',
    '2026-09-13':'Dom 13/Set'
  };
  const CAP = 46;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Eventos Lotados ‚Äî Rock in Rio 2026</title>
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
    <div><h1>Eventos Lotados</h1><p>Hor√°rios esgotados e sugest√£o de novos hor√°rios</p></div>
  </div>
  <div class="header-right">
    <a href="/" class="btn btn-back">‚Üê Voltar ao Dashboard</a>
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
    if (tableWrap) tableWrap.innerHTML = '<div class="no-data-msg" style="padding:24px">üéâ Todos os hor√°rios lotados j√° possuem novo hor√°rio aceito!</div>';
  }
}

function renderAceitos() {
  const aceitos = getAceitos();
  const container = document.getElementById('aceitos-container');
  if (!container) return;
  const count = document.getElementById('aceitos-count');
  if (count) count.textContent = aceitos.length;

  if (aceitos.length === 0) {
    container.innerHTML = '<div class="empty-msg">Nenhum novo hor√°rio aceito ainda. Clique em "Aceitar" nos eventos lotados acima.</div>';
    return;
  }

  let html = '<table class="aceitos-table"><thead><tr>' +
    '<th>Local de Embarque</th><th>Data</th><th>Hor√°rio Original</th><th>Novo Hor√°rio</th><th>Aceito em</th>' +
    '</tr></thead><tbody>';
  for (const a of aceitos) {
    const dt = new Date(a.aceitoEm);
    const dtStr = dt.toLocaleDateString('pt-BR') + ' ' + dt.toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit'});
    const dateLabel = DATE_LABELS[a.date] || a.date;
    html += \`<tr>
      <td><strong>\${a.local}</strong></td>
      <td><span class="tag-date">\${dateLabel}</span></td>
      <td><span class="tag-time">\${a.horarioOriginal}</span></td>
      <td><span class="tag-new">üïê \${a.novoHorario}</span></td>
      <td style="color:var(--muted);font-size:11px">\${dtStr}</td>
    </tr>\`;
  }
  html += '</tbody></table>';
  container.innerHTML = html;
}

function limparAceitos() {
  if (!confirm('Tem certeza que deseja limpar todos os novos hor√°rios aceitos?')) return;
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
  if (aceitos.length === 0) { alert('Nenhum hor√°rio aceito para exportar.'); return; }
  if (typeof XLSX === 'undefined') { alert('SheetJS carregando, tente em breve.'); return; }

  const wsData = [['Local de Embarque', 'Nome Completo do Evento', 'Data Festival', 'Hor√°rio Original (Lotado)', 'Novo Hor√°rio Sugerido', 'Aceito em']];
  for (const a of aceitos) {
    wsData.push([a.local, a.eventName || a.local, a.date, a.horarioOriginal, a.novoHorario, new Date(a.aceitoEm).toLocaleString('pt-BR')]);
  }
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = [{wch:32},{wch:48},{wch:14},{wch:22},{wch:20},{wch:20}];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Novos Hor√°rios');
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
  return s.local || s.eventName || '‚Äî';
}

function render(rawShows) {
  // Build set of all existing slots keyed by "localEmbarque|date|time"
  const existingSlots = new Set(rawShows.map(s => \`\${getLocalEmbarque(s)}|\${s.date}|\${s.time}\`));

  // Build neighbor map: "localEmbarque|date" ‚Üí sorted array of {time, tks}
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

  // Sort: localEmbarque (A‚ÜíZ) ‚Üí date ‚Üí time
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
    html += '<div class="no-data-msg">üéâ Nenhum evento com lota√ß√£o esgotada no momento.</div>';
    document.getElementById('app').innerHTML = html;
    document.getElementById('loading').classList.add('hidden');
    return;
  }

  // Sold-out table
  html += \`<div class="section-title">üö® Hor√°rios Esgotados</div>
  <div class="section-sub">Eventos com \${CAP} de \${CAP} ingressos vendidos ‚Äî capacidade m√°xima atingida</div>
  <div style="overflow-x:auto">
  <table class="lotados-table">
    <thead><tr>
      <th>Local de Embarque</th><th>Data</th><th>Hor√°rio Lotado</th><th>Vendidos</th><th>Hor√°rios Vizinhos</th><th>Novo Hor√°rio Sugerido</th><th>A√ß√£o</th>
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
      ? \`<div style="font-size:11px;white-space:nowrap">‚Üê \${prev.time} &nbsp;<b style="color:var(--text)">\${prev.tks}</b> <span style="color:var(--muted)">ing.</span></div>\`
      : \`<div style="color:#555;font-size:11px">‚Üê sem anterior</div>\`;
    const nextHtml = next
      ? \`<div style="font-size:11px;white-space:nowrap">‚Üí \${next.time} &nbsp;<b style="color:var(--text)">\${next.tks}</b> <span style="color:var(--muted)">ing.</span></div>\`
      : \`<div style="color:#555;font-size:11px">‚Üí sem pr√≥ximo</div>\`;
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
      <td><span class="tag-new">üïê \${novoH}</span> <span style="font-size:10px;color:var(--muted)">\${offsetLabel}</span></td>
      <td style="display:flex;gap:6px;align-items:center">
        <button class="btn-aceitar\${jaAceito?' aceito':''}" id="\${btnId}" \${jaAceito?'disabled':''}\
          onclick="aceitar('\${localEsc}','\${eventEsc}','\${s.date}','\${s.time}','\${novoH}','\${btnId}')">\
          \${jaAceito?'‚úì Aceito':'Aceitar'}</button>
        <button class="btn-negar" onclick="negar('\${localEsc}','\${s.date}','\${s.time}','\${rowId}')">‚úï Negar</button>
      </td>
    </tr>\`;
  });

  html += '</tbody></table></div>';

  // Accepted section
  html += \`<div class="aceitos-section">
    <div class="aceitos-header">
      <div class="aceitos-title">‚úÖ Novos Hor√°rios Aceitos &nbsp;<span id="aceitos-count" style="background:#2ec27e;color:#000;border-radius:12px;padding:1px 10px;font-size:13px">0</span></div>
      <div class="aceitos-actions">
        <button class="btn-export" onclick="exportarXLS()">üì• Exportar XLS</button>
        <button class="btn-limpar" onclick="limparAceitos()">üóëÔ∏è Limpar Lista</button>
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
    document.getElementById('status-text').textContent = 'Dados ao vivo ¬∑ ' + (json.lastRefresh ? new Date(json.lastRefresh).toLocaleString('pt-BR') : '‚Äî');
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

// ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
// AN√ÅLISE POR LOCAL PAGE
// ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
function getLocaisHTML(username) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>An√°lise por Local ‚Äî Rock in Rio 2026</title>
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
    <a href="/" style="text-decoration:none;border:1px solid var(--border);padding:7px 14px;border-radius:8px;color:var(--text);font-size:13px;font-weight:600">‚Üê Voltar</a>
    <div class="logo-badge">Rock in Rio 2026</div>
    <div><h1>An√°lise por Local</h1><p>Receita, ingressos, hor√°rios e lota√ß√£o por ponto de embarque</p></div>
  </div>
  <div class="header-right">
    <span id="last-upd" style="font-size:11px;color:var(--muted)"></span>
    <button class="btn btn-primary" onclick="loadData()">‚Üª Atualizar</button>
    <form method="POST" action="/logout" style="margin:0"><button class="btn btn-secondary" type="submit">Sair</button></form>
  </div>
</header>
<div id="status-bar"><span class="status-dot" id="status-dot"></span><span id="status-text">Conectando...</span></div>
<div class="content" id="content" style="display:none">

  <div class="kpis">
    <div class="kpi gold"><div class="kpi-label">üí∞ Receita Total</div><div class="kpi-val" id="k-receita">‚Äî</div><div class="kpi-sub">em ingressos vendidos</div></div>
    <div class="kpi red"><div class="kpi-label">üé´ Ingressos Vendidos</div><div class="kpi-val" id="k-tks">‚Äî</div><div class="kpi-sub" id="k-tks-sub">locais ativos</div></div>
    <div class="kpi blue"><div class="kpi-label">üìç Pontos de Embarque</div><div class="kpi-val" id="k-locais">‚Äî</div><div class="kpi-sub" id="k-locais-sub">com vendas</div></div>
    <div class="kpi teal"><div class="kpi-label">üí≥ Ticket M√©dio</div><div class="kpi-val" id="k-medio">‚Äî</div><div class="kpi-sub">por ingresso</div></div>
    <div class="kpi green"><div class="kpi-label">üèÜ Top Local</div><div class="kpi-val" id="k-top" style="font-size:14px;line-height:1.3">‚Äî</div><div class="kpi-sub" id="k-top-sub"></div></div>
    <div class="kpi orange"><div class="kpi-label">‚ùå Cancelados</div><div class="kpi-val" id="k-can">‚Äî</div><div class="kpi-sub">ingressos cancelados</div></div>
  </div>

  <div class="charts-row">
    <div class="section">
      <div class="section-title">üèÖ Top 15 Locais ‚Äî Receita (R$)</div>
      <div class="chart-wrap-tall"><canvas id="chart-receita"></canvas></div>
    </div>
    <div class="section">
      <div class="section-title">üèÖ Top 15 Locais ‚Äî Ingressos Vendidos</div>
      <div class="chart-wrap-tall"><canvas id="chart-ingressos"></canvas></div>
    </div>
  </div>

  <div class="charts-row">
    <div class="section">
      <div class="section-title">üìÖ Vendas por Dia (Data da Compra)</div>
      <div class="chart-wrap"><canvas id="chart-timeline"></canvas></div>
    </div>
    <div class="section">
      <div class="section-title">üïê Ranking de Hor√°rios de Partida</div>
      <div style="max-height:320px;overflow-y:auto">
        <table class="rank-table" id="tbl-horarios">
          <thead><tr><th>#</th><th>Hor√°rio</th><th>Ingressos</th><th style="width:120px">Barra</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">üìä Lota√ß√£o por Data de Show ‚Äî Ingressos por Ponto de Embarque</div>
    <div class="table-scroll" id="tbl-lotacao-wrap" style="max-height:500px;overflow-y:auto"></div>
  </div>

</div>
<script>
const FEST_DATES  = ['2026-09-04','2026-09-05','2026-09-06','2026-09-07','2026-09-11','2026-09-12','2026-09-13'];
const FEST_LABELS = ['04/Set (Sex)','05/Set (S√°b)','06/Set (Dom)','07/Set (Seg)','11/Set (Sex)','12/Set (S√°b)','13/Set (Dom)'];
const PREFIX1 = 'Primeira Classe Rock in Rio - ';
const PREFIX2 = 'Primeira Classe Rock in Rio | ';
const fmt  = n => Number(n||0).toLocaleString('pt-BR');
const fmtR = n => 'R$\\u00a0'+Number(n||0).toLocaleString('pt-BR',{minimumFractionDigits:0,maximumFractionDigits:0});
const COLORS = ['#e8871a','#5b8dee','#2ec27e','#9b59b6','#1abc9c','#ffd700','#e63946','#f4a261','#FF6B9D','#4ecdc4','#45b7d1','#96ceb4','#ff9f43','#54a0ff','#5f27cd'];
const axO = {color:'#7a8499',grid:{color:'#252d3d'}};
let charts = {};
function mk(id,cfg){ if(charts[id])charts[id].destroy(); const c=document.getElementById(id); if(c)charts[id]=new Chart(c,cfg); }

function normLocal(s){
  if(!s) return '‚Äî';
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
    if(!loc||loc==='‚Äî') continue;
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
  const top    = active[0]||['‚Äî',{tks:0,receita:0}];

  document.getElementById('k-receita').textContent = fmtR(totRec);
  document.getElementById('k-tks').textContent     = fmt(totTks);
  document.getElementById('k-tks-sub').textContent = active.length+' locais ativos';
  document.getElementById('k-locais').textContent  = byTks.length;
  document.getElementById('k-locais-sub').textContent = active.length+' com vendas';
  document.getElementById('k-medio').textContent   = totTks>0?fmtR(totRec/totTks):'‚Äî';
  document.getElementById('k-top').textContent     = top[0];
  document.getElementById('k-top-sub').textContent = fmt(top[1].tks)+' ing ¬∑ '+fmtR(top[1].receita);
  document.getElementById('k-can').textContent     = fmt(totCan);

  // Top 15 receita
  const t15r = byRec.slice(0,15);
  mk('chart-receita',{type:'bar',data:{labels:t15r.map(([l])=>l.length>20?l.slice(0,19)+'‚Ä¶':l),datasets:[{label:'Receita',data:t15r.map(([,v])=>v.receita),backgroundColor:COLORS.slice(0,15),borderRadius:4}]},
    options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>fmtR(c.raw)}}},scales:{x:{ticks:{...axO,callback:v=>fmtR(v)},grid:{color:'#252d3d'}},y:{ticks:{...axO,font:{size:11}},grid:{color:'#252d3d'}}}}});

  // Top 15 ingressos
  const t15i = byTks.slice(0,15);
  mk('chart-ingressos',{type:'bar',data:{labels:t15i.map(([l])=>l.length>20?l.slice(0,19)+'‚Ä¶':l),datasets:[{label:'Ingressos',data:t15i.map(([,v])=>v.tks),backgroundColor:COLORS.slice(0,15),borderRadius:4}]},
    options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>fmt(c.raw)+' ingressos'}}},scales:{x:{ticks:{...axO,callback:v=>fmt(v)},grid:{color:'#252d3d'}},y:{ticks:{...axO,font:{size:11}},grid:{color:'#252d3d'}}}}});

  // Timeline
  mk('chart-timeline',{type:'line',data:{labels:sbd.map(r=>r.date.slice(5)),datasets:[{label:'Ingressos',data:sbd.map(r=>r.tks),borderColor:'#e8871a',backgroundColor:'rgba(232,135,26,.12)',fill:true,tension:.35,pointRadius:2,pointBackgroundColor:'#e8871a'}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>fmt(c.raw)+' ingressos'}}},scales:{x:{ticks:{...axO,maxTicksLimit:10},grid:{color:'#252d3d'}},y:{ticks:{...axO,callback:v=>fmt(v)},grid:{color:'#252d3d'}}}}});

  // Hor√°rios de partida
  const horMap = {};
  for(const r of raw){ if(r.time) horMap[r.time]=(horMap[r.time]||0)+(r.tks||0); }
  const horArr = Object.entries(horMap).sort((a,b)=>b[1]-a[1]);
  const maxH = horArr[0]?horArr[0][1]:1;
  document.querySelector('#tbl-horarios tbody').innerHTML = horArr.map(([t,n],i)=>
    \`<tr><td style="color:var(--muted);width:28px">\${i+1}</td><td style="font-weight:700;font-size:14px">\${t}</td><td class="num">\${fmt(n)}</td><td><div class="bar-cell"><div class="bar-inline" style="width:\${Math.max(4,Math.round(n/maxH*120))}px"></div><span style="font-size:11px;color:var(--muted)">\${Math.round(n/maxH*100)}%</span></div></td></tr>\`
  ).join('');

  // Lota√ß√£o matrix
  const matMap = {};
  for(const r of raw){
    const loc = normLocal(r.local||r.eventName||'');
    if(!loc||loc==='‚Äî') continue;
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
      :\`<td class="zero">‚Äî</td>\`).join('')}<td class="num" style="color:var(--gold)">\${fmt(tot)}</td></tr>\`;
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
    const ts = json.lastRefresh ? new Date(json.lastRefresh).toLocaleString('pt-BR') : '‚Äî';
    document.getElementById('status-text').textContent = 'Dados ao vivo ¬∑ '+ts;
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

// ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
// VELOCIDADE DE VENDAS PAGE
// ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
function getVelocidadeHTML(username) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Velocidade de Vendas ‚Äî Rock in Rio 2026</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>
<style>
${SHARED_CSS_VARS}
${SHARED_HEADER_CSS}
  .content{padding:20px 32px 60px}
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin-bottom:20px}
  .kpi{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;text-align:center;position:relative;overflow:hidden}
  .kpi::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;border-radius:12px 12px 0 0}
  .kpi.green::before{background:var(--green)} .kpi.blue::before{background:var(--blue)}
  .kpi.gold::before{background:var(--gold)}   .kpi.teal::before{background:var(--teal)}
  .kpi.purple::before{background:var(--purple)} .kpi.red::before{background:var(--accent)}
  .kpi-icon{font-size:20px;margin-bottom:5px}
  .kpi-label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:4px;font-weight:700}
  .kpi-val{font-size:22px;font-weight:800;color:var(--green)}
  .kpi.blue .kpi-val{color:var(--blue)} .kpi.gold .kpi-val{color:var(--gold)}
  .kpi.teal .kpi-val{color:var(--teal)} .kpi.purple .kpi-val{color:var(--purple)}
  .kpi.red .kpi-val{color:var(--accent)}
  .kpi-sub{font-size:11px;color:var(--muted);margin-top:3px}
  .section{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px;margin-bottom:18px}
  .section-title{font-size:13px;font-weight:700;color:var(--green);margin-bottom:14px;padding-bottom:8px;border-bottom:1px solid var(--border)}
  .charts-row{display:grid;grid-template-columns:2fr 1fr;gap:16px;margin-bottom:18px}
  .chart-wrap{position:relative;height:300px}
  .chart-wrap-sm{position:relative;height:240px}
  .proj-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px}
  .proj-card{background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:16px;text-align:center}
  .proj-label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:6px;font-weight:700}
  .proj-val{font-size:26px;font-weight:800}
  .proj-sub{font-size:11px;color:var(--muted);margin-top:4px}
  .trend-up{color:var(--green)} .trend-down{color:var(--accent)} .trend-flat{color:var(--gold)}
  .accel-badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:700;margin-top:6px}
  .accel-pos{background:#0d2a1a;color:var(--green)} .accel-neg{background:#2a0d0d;color:var(--accent)} .accel-flat{background:#2a2a0d;color:var(--gold)}
  /* ‚îÄ‚îÄ COMPARATIVO TABLE ‚îÄ‚îÄ */
  .comp-wrap{overflow-x:auto;max-height:520px;overflow-y:auto}
  .comp-table{border-collapse:collapse;min-width:100%;font-size:12px}
  .comp-table th{position:sticky;top:0;z-index:2;background:var(--surface2);padding:8px 12px;text-align:right;
    font-size:10px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--muted);
    border-bottom:2px solid var(--border);white-space:nowrap}
  .comp-table th.col-cd{text-align:center;min-width:54px}
  .comp-table td{padding:7px 12px;text-align:right;border-bottom:1px solid #1a1f2a;white-space:nowrap}
  .comp-table td.col-cd{text-align:center;font-weight:700;color:var(--muted);font-size:11px}
  .comp-table tr:hover td{background:var(--surface2)}
  .comp-table tr.row-current td{background:#0d2a1a!important;font-weight:700}
  .comp-table tr.row-current td.col-cd{color:var(--green)}
  .comp-table tr.row-current td.col-2026{color:var(--green);font-size:13px}
  .col-2026{color:var(--accent);font-weight:700}
  .col-daily{color:#b0b8cc;border-left:1px solid #222a38}
  .comp-table th:nth-child(n+8){border-left:1px solid #222a38}
  .diff-pos{color:#2ec27e;font-weight:700}
  .diff-neg{color:#e63946;font-weight:700}
  .growth-pos{color:var(--green);font-size:10px;margin-left:3px}
  .growth-neg{color:var(--accent);font-size:10px;margin-left:3px}
  .comp-table thead tr:first-child th{position:sticky;top:0;z-index:3}
  .comp-table thead tr:nth-child(2) th{position:sticky;top:29px;z-index:3}
  @media(max-width:768px){
    header,.content{padding-left:16px;padding-right:16px}
    .charts-row{grid-template-columns:1fr}
    .kpis{grid-template-columns:1fr 1fr}
    #status-bar{padding-left:16px;padding-right:16px}
  }
</style>
</head>
<body>

<div id="loading" style="position:fixed;inset:0;background:rgba(10,12,16,.9);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;z-index:9999;font-size:14px;color:var(--muted)">
  <div style="width:38px;height:38px;border:3px solid var(--border);border-top-color:var(--green);border-radius:50%;animation:spin .8s linear infinite"></div>
  <span>Carregando dados de velocidade...</span>
  <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
</div>

<header>
  <div class="header-left">
    <div class="logo-badge">Rock in Rio 2026</div>
    <div>
      <h1>üöÄ Velocidade de Vendas</h1>
      <p id="header-sub">Ritmo di√°rio √ó metas ‚Äî atualizado em ‚Äî</p>
    </div>
  </div>
  <div class="header-right">
    <a href="/" class="btn btn-back">‚Üê Painel</a>
    <form method="POST" action="/logout" style="margin:0">
      <button class="btn btn-secondary" type="submit">Sair</button>
    </form>
  </div>
</header>

<div id="status-bar">
  <span class="status-dot" id="status-dot"></span>
  <span id="status-text">Conectando...</span>
</div>

<div class="content" id="content" style="display:none">

  <!-- KPIs -->
  <div class="kpis">
    <div class="kpi green"><div class="kpi-icon">üéüÔ∏è</div><div class="kpi-label">Total Vendidos</div><div class="kpi-val" id="k-total">‚Äî</div><div class="kpi-sub" id="k-days">em ‚Äî dias</div></div>
    <div class="kpi blue"><div class="kpi-icon">üìà</div><div class="kpi-label">M√©dia / Dia</div><div class="kpi-val" id="k-avg">‚Äî</div><div class="kpi-sub">hist√≥rico total</div></div>
    <div class="kpi teal"><div class="kpi-icon">‚ö°</div><div class="kpi-label">Ritmo Atual</div><div class="kpi-val" id="k-avg7">‚Äî</div><div class="kpi-sub" id="k-accel"></div></div>
    <div class="kpi gold"><div class="kpi-icon">üèÜ</div><div class="kpi-label">Melhor Dia</div><div class="kpi-val" id="k-best">‚Äî</div><div class="kpi-sub" id="k-best-date"></div></div>
    <div class="kpi purple"><div class="kpi-icon">üìÖ</div><div class="kpi-label">Dias Restantes</div><div class="kpi-val" id="k-days-left">‚Äî</div><div class="kpi-sub">at√© 04/Set/2026</div></div>
  </div>

  <!-- Main chart: vendas di√°rias + m√©dia m√≥vel -->
  <div class="section">
    <div class="section-title">üìä Vendas por Dia + M√©dia M√≥vel (7 dias)</div>
    <div class="charts-row">
      <div class="chart-wrap"><canvas id="chartDaily"></canvas></div>
      <div>
        <div class="section-title" style="font-size:12px;color:var(--muted)">üìÜ Vendas por Semana</div>
        <div class="chart-wrap-sm"><canvas id="chartWeekly"></canvas></div>
      </div>
    </div>
  </div>

  <!-- Proje√ß√£o -->
  <div class="section">
    <div class="section-title">üîÆ Proje√ß√£o at√© o Festival (04/Set/2026)</div>

    <!-- Linha de status -->
    <div style="display:flex;align-items:center;gap:20px;margin-bottom:16px;flex-wrap:wrap">
      <div style="font-size:13px;color:var(--muted)">Vendidos hoje: <strong style="color:var(--green);font-size:16px" id="proj-atual">‚Äî</strong></div>
      <div style="font-size:13px;color:var(--muted)">Dias restantes: <strong style="color:var(--text)" id="proj-days-rem">‚Äî</strong></div>
      <div style="font-size:13px;color:var(--muted)">Ritmo 7 dias: <strong style="color:var(--blue)" id="proj-rate">‚Äî</strong>/dia</div>
    </div>

    <!-- Dois cen√°rios lado a lado -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">

      <!-- Cen√°rio 1: Ritmo Constante -->
      <div style="background:var(--surface2);border:1px solid var(--border);border-top:3px solid #5b8dee;border-radius:10px;padding:18px">
        <div style="font-size:10px;font-weight:700;color:#5b8dee;text-transform:uppercase;letter-spacing:.1em;margin-bottom:8px">üìä Ritmo Constante</div>
        <p style="font-size:11px;color:var(--muted);margin-bottom:14px;line-height:1.5">M√©dia dos √∫ltimos 7 dias aplicada uniformemente at√© o festival</p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div>
            <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px">Adicional</div>
            <div style="font-size:24px;font-weight:800;color:#5b8dee" id="proj-add">‚Äî</div>
          </div>
          <div>
            <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px">Total</div>
            <div style="font-size:24px;font-weight:800;color:#748ffc" id="proj-total">‚Äî</div>
          </div>
        </div>
      </div>

      <!-- Cen√°rio 2: Curva Hist√≥rica -->
      <div style="background:var(--surface2);border:1px solid var(--border);border-top:3px solid #2ec27e;border-radius:10px;padding:18px">
        <div style="font-size:10px;font-weight:700;color:#2ec27e;text-transform:uppercase;letter-spacing:.1em;margin-bottom:8px">üìà Curva Hist√≥rica</div>
        <p style="font-size:11px;color:var(--muted);margin-bottom:14px;line-height:1.5">M√©dia de <span id="hist-years-count">‚Äî</span> edi√ß√µes: <strong id="hist-pct-sold" style="color:var(--text)">‚Äî</strong>% vendido at√© este ponto ‚Äî inclui acelera√ß√£o final</p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div>
            <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px">Adicional</div>
            <div style="font-size:24px;font-weight:800;color:#2ec27e" id="proj-hist-add">‚Äî</div>
          </div>
          <div>
            <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px">Total</div>
            <div style="font-size:24px;font-weight:800;color:#ffd700" id="proj-hist-total">‚Äî</div>
          </div>
        </div>
        <div id="hist-uplift" style="margin-top:10px;font-size:11px;color:var(--muted)"></div>
      </div>

    </div>

    <!-- Detalhe por edi√ß√£o -->
    <div id="hist-detail" style="margin-top:12px;font-size:11px;color:var(--muted);display:none">
      <span style="font-weight:700;color:var(--text)">% vendido neste ponto por edi√ß√£o: </span>
      <span id="hist-detail-text"></span>
    </div>

    <!-- Card destaque: Total at√© fim do festival -->
    <div id="proj-festival-card" style="display:none;margin-top:16px;background:linear-gradient(135deg,#1a0a2e 0%,#0d1f2d 100%);border:1px solid #5b3d8c;border-radius:12px;padding:20px 24px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:14px">
        <div>
          <div style="font-size:10px;font-weight:700;color:#b77ef7;text-transform:uppercase;letter-spacing:.12em;margin-bottom:6px">üé™ Proje√ß√£o Total ‚Äî Fim do Festival (13/Set/2026)</div>
          <div style="font-size:11px;color:#8a7aa0;margin-bottom:4px" id="proj-festival-sub">Curva hist√≥rica √ó fator p√≥s-in√≠cio m√©dio de ‚Äî edi√ß√µes</div>
          <div style="font-size:11px;color:#8a7aa0">Inclui acelera√ß√£o pr√©-festival <strong style="color:#b77ef7">+</strong> vendas durante os 9 dias de shows</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:11px;color:#8a7aa0;margin-bottom:2px">Total projetado at√© 13/Set</div>
          <div style="font-size:38px;font-weight:900;color:#b77ef7;line-height:1" id="proj-festival-total">‚Äî</div>
          <div style="font-size:12px;color:#8a7aa0;margin-top:4px">ingressos ¬∑ <span id="proj-festival-add" style="color:#ffd700;font-weight:700">‚Äî</span> ainda a vender</div>
          <div style="font-size:11px;color:#5b8dee;margin-top:6px" id="proj-festival-vs2024"></div>
        </div>
      </div>
    </div>
  </div>

  <!-- Comparativo Hist√≥rico -->
  <div class="section" id="section-comp">
    <div class="section-title" style="display:flex;align-items:center;justify-content:space-between">
      <span>üìã Comparativo Hist√≥rico ‚Äî Dia a Dia por Edi√ß√£o</span>
      <button onclick="exportComparativo()" class="btn btn-secondary" style="font-size:11px;padding:6px 12px">‚Üì XLS Comparativo</button>
    </div>
    <p style="font-size:12px;color:var(--muted);margin-bottom:14px">Ingressos acumulados por dias antes do festival (D-0 = dia do 1¬∫ show). Linha verde = hoje.</p>
    <div class="comp-wrap" id="comp-table-wrap"><div style="color:var(--muted);padding:20px;text-align:center">Carregando...</div></div>
  </div>

</div>

<script>
function fmt(n){ return (n||0).toLocaleString('pt-BR'); }
function fmtDate(s){ if(!s)return'‚Äî'; const [y,m,d]=s.split('-'); return d+'/'+m+'/'+y; }

function mkLineChart(id, labels, datasets, opts={}){
  const ctx = document.getElementById(id);
  if(!ctx) return;
  return new Chart(ctx,{
    type:'line',
    data:{ labels, datasets },
    options:{
      responsive:true, maintainAspectRatio:false,
      interaction:{ mode:'index', intersect:false },
      plugins:{ legend:{ position:'top', labels:{ color:'#7a8499', font:{size:11}, padding:12 }},
        tooltip:{ callbacks:{ label: ctx=>' '+fmt(ctx.parsed.y)+' ingressos' }}},
      scales:{
        x:{ ticks:{ color:'#7a8499', font:{size:10}, maxTicksLimit:12, maxRotation:30 }, grid:{color:'#252d3d'} },
        y:{ ticks:{ color:'#7a8499', font:{size:11} }, grid:{color:'#252d3d'}, beginAtZero:true }
      },
      ...opts
    }
  });
}

async function loadData(){
  try {
    const res  = await fetch('/api/velocidade-data');
    const json = await res.json();

    document.getElementById('loading').style.display='none';
    document.getElementById('content').style.display='block';

    const ts = json.updated_at || '‚Äî';
    document.getElementById('status-dot').className='status-dot green';
    document.getElementById('status-text').textContent='Dados ao vivo ¬∑ '+ts;
    document.getElementById('header-sub').textContent='Ritmo di√°rio √ó metas ‚Äî atualizado em '+ts;

    if(!json.hasData){
      document.getElementById('content').innerHTML='<div style="text-align:center;padding:60px;color:var(--muted)"><div style="font-size:48px;margin-bottom:12px">üìã</div><h3>Dados ainda n√£o dispon√≠veis</h3></div>';
      return;
    }

    // ‚îÄ‚îÄ KPIs ‚îÄ‚îÄ
    document.getElementById('k-total').textContent    = fmt(json.totalTks);
    document.getElementById('k-days').textContent     = 'em '+json.totalDays+' dias';
    document.getElementById('k-avg').textContent      = fmt(json.avgPerDay);
    document.getElementById('k-avg7').textContent     = fmt(json.avg7)+'/dia';
    document.getElementById('k-best').textContent     = fmt(json.bestDay?.tks);
    document.getElementById('k-best-date').textContent = fmtDate(json.bestDay?.date);
    document.getElementById('k-days-left').textContent = json.daysLeft;

    // Acceleration indicator
    const accel = json.avg7 - json.avg30;
    const accelEl = document.getElementById('k-accel');
    if(accel > 5){
      accelEl.innerHTML = '<span class="accel-badge accel-pos">‚Üë Acelerando +'+fmt(accel)+'/dia</span>';
    } else if(accel < -5){
      accelEl.innerHTML = '<span class="accel-badge accel-neg">‚Üì Desacelerando '+fmt(accel)+'/dia</span>';
    } else {
      accelEl.innerHTML = '<span class="accel-badge accel-flat">‚Üí Est√°vel (7d vs 30d)</span>';
    }

    // ‚îÄ‚îÄ Daily chart ‚îÄ‚îÄ
    const daily = json.dailyData || [];
    const ma    = json.maData    || [];
    // Show last 60 days for readability
    const slice = daily.length > 60 ? daily.slice(-60) : daily;
    const maSlice = ma.length > 60 ? ma.slice(-60) : ma;

    mkLineChart('chartDaily',
      slice.map(d => fmtDate(d.date)),
      [
        { label:'Vendas por Dia', data: slice.map(d=>d.tks), backgroundColor:'rgba(91,141,238,0.15)', borderColor:'#5b8dee', borderWidth:2, fill:true, tension:0.3, pointRadius:2 },
        { label:'M√©dia M√≥vel 7d', data: maSlice, borderColor:'#2ec27e', borderWidth:2, fill:false, tension:0.4, pointRadius:0, borderDash:[4,4] }
      ]
    );

    // ‚îÄ‚îÄ Weekly chart ‚îÄ‚îÄ
    const wk = json.weeklyData || [];
    const ctxW = document.getElementById('chartWeekly');
    if(ctxW && wk.length){
      new Chart(ctxW,{
        type:'bar',
        data:{
          labels: wk.map(w => { const [y,m,d]=w.weekStart.split('-'); return d+'/'+m; }),
          datasets:[{ label:'Vendas/Semana', data:wk.map(w=>w.tks), backgroundColor:'rgba(46,194,126,0.7)', borderColor:'#2ec27e', borderWidth:1, borderRadius:4 }]
        },
        options:{
          responsive:true, maintainAspectRatio:false,
          plugins:{ legend:{display:false}, tooltip:{ callbacks:{ label: ctx=>' '+fmt(ctx.parsed.y)+' ingressos' }}},
          scales:{
            x:{ ticks:{ color:'#7a8499', font:{size:10}, maxRotation:45 }, grid:{color:'#252d3d'} },
            y:{ ticks:{ color:'#7a8499', font:{size:10} }, grid:{color:'#252d3d'}, beginAtZero:true }
          }
        }
      });
    }

    // ‚îÄ‚îÄ Proje√ß√£o ‚îÄ‚îÄ
    document.getElementById('proj-rate').textContent     = fmt(json.avg7);
    document.getElementById('proj-atual').textContent    = fmt(json.totalTks);
    document.getElementById('proj-add').textContent      = fmt(json.projectedRemaining);
    document.getElementById('proj-days-rem').textContent = json.daysLeft;
    document.getElementById('proj-total').textContent    = fmt(json.projectedTotal);

    // ‚îÄ‚îÄ Proje√ß√£o com Curva Hist√≥rica + Total Fim do Festival ‚îÄ‚îÄ
    (function() {
      const cd = json.daysLeft;
      const HIST_TOTALS = [107861, 93218, 140852, 175959, 185316];
      const HIST_YEARS  = [2015, 2017, 2019, 2022, 2024];

      // ‚îÄ‚îÄ Parte 1: % vendido no countdown atual ‚Üí projeta total em D-0 ‚îÄ‚îÄ
      const row = HIST_CD[cd] || HIST_CD[cd+1] || HIST_CD[cd-1] || null;
      if (!row) return;

      let pctSum = 0, pctCount = 0;
      const details = [];
      HIST_TOTALS.forEach((total, i) => {
        const cum = row[i] || 0;
        if (cum > 0 && total > 0) {
          const pct = cum / total;
          pctSum += pct;
          pctCount++;
          details.push(HIST_YEARS[i]+': '+Math.round(pct*100)+'%');
        }
      });
      if (pctCount < 2) return;

      const avgPctSoFar   = pctSum / pctCount;
      const projHistTotal = Math.round(json.totalTks / avgPctSoFar);
      const projHistAdd   = projHistTotal - json.totalTks;
      const upliftPct     = Math.round((projHistTotal / json.projectedTotal - 1) * 100);

      document.getElementById('hist-years-count').textContent = pctCount;
      document.getElementById('hist-pct-sold').textContent    = Math.round(avgPctSoFar * 100);
      document.getElementById('proj-hist-add').textContent    = fmt(projHistAdd);
      document.getElementById('proj-hist-total').textContent  = fmt(projHistTotal);

      if (upliftPct > 0) {
        document.getElementById('hist-uplift').innerHTML =
          '<span style="color:#2ec27e;font-weight:700">‚¨Ü +'+upliftPct+'%</span> vs ritmo constante ¬∑ acelera√ß√£o esperada nos √∫ltimos '+cd+' dias';
      } else if (upliftPct < 0) {
        document.getElementById('hist-uplift').innerHTML =
          '<span style="color:var(--accent);font-weight:700">‚¨á '+upliftPct+'%</span> vs ritmo constante';
      }
      if (details.length > 0) {
        document.getElementById('hist-detail').style.display = 'block';
        document.getElementById('hist-detail-text').textContent = details.join(' ¬∑ ');
      }

      // ‚îÄ‚îÄ Parte 2: fator p√≥s-in√≠cio ‚Üí projeta total no fim do festival (D+9 = 13/Set) ‚îÄ‚îÄ
      // Para cada edi√ß√£o: fator = acumulado_D+9 / acumulado_D-0
      // D+9 = key '-9' no HIST_CD
      const rowD0   = HIST_CD[0]   || [0,0,0,0,0];
      const rowDend = HIST_CD['-9'] || HIST_CD['-8'] || HIST_CD['-10'] || [0,0,0,0,0];

      let factorSum = 0, factorCount = 0;
      const factorDetails = [];
      HIST_TOTALS.forEach((_, i) => {
        const atStart = rowD0[i];
        const atEnd   = rowDend[i];
        if (atStart > 0 && atEnd > 0) {
          const f = atEnd / atStart;
          factorSum += f;
          factorCount++;
          factorDetails.push(HIST_YEARS[i]+': √ó'+f.toFixed(2));
        }
      });

      if (factorCount < 2) return;

      const avgFactor      = factorSum / factorCount;
      const projFestTotal  = Math.round(projHistTotal * avgFactor);
      const projFestAdd    = projFestTotal - json.totalTks;
      const vs2024         = 185316; // total 2024
      const vs2024Pct      = Math.round((projFestTotal / vs2024 - 1) * 100);

      document.getElementById('proj-festival-card').style.display  = 'block';
      document.getElementById('proj-festival-total').textContent   = fmt(projFestTotal);
      document.getElementById('proj-festival-add').textContent     = fmt(projFestAdd);
      document.getElementById('proj-festival-sub').textContent     =
        'Curva hist√≥rica √ó fator p√≥s-in√≠cio m√©dio de '+factorCount+' edi√ß√µes (√ó'+avgFactor.toFixed(2)+')';
      document.getElementById('proj-festival-vs2024').innerHTML    =
        vs2024Pct >= 0
          ? '<span style="color:#2ec27e">‚ñ≤ +'+vs2024Pct+'%</span> vs 2024 ('+fmt(vs2024)+')'
          : '<span style="color:var(--accent)">‚ñº '+vs2024Pct+'%</span> vs 2024 ('+fmt(vs2024)+')';
    })();

    // ‚îÄ‚îÄ Comparativo ‚îÄ‚îÄ
    renderComparativo(json);

  } catch(e){
    document.getElementById('loading').style.display='none';
    document.getElementById('content').style.display='block';
    document.getElementById('status-dot').className='status-dot red';
    document.getElementById('status-text').textContent='Erro: '+e.message;
  }
}
// ‚îÄ‚îÄ Dados hist√≥ricos por edi√ß√£o ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
const HIST_DATA = [
  { year:2015, vendas:107861 },
  { year:2017, vendas:93218  },
  { year:2019, vendas:140852 },
  { year:2022, vendas:175959 },
  { year:2024, vendas:185316 },
];

// Ingressos acumulados por countdown (D-N = N dias antes do 1¬∫ show)
// Cada valor: [2015, 2017, 2019, 2022, 2024]
const HIST_CD = {
  180:[0,0,0,0,0],179:[0,0,0,0,0],178:[0,0,0,37,0],177:[0,0,0,53,0],
  176:[0,0,0,73,0],175:[0,0,0,325,0],174:[0,0,0,532,0],173:[0,0,0,622,0],
  172:[0,0,0,695,0],171:[0,0,0,737,0],170:[0,0,0,786,0],169:[0,0,12558,835,0],
  168:[0,0,13329,1259,0],167:[0,0,13670,1551,0],166:[0,0,14036,1654,0],
  165:[0,0,14334,1774,0],164:[0,0,14609,1906,0],163:[0,0,14781,1994,0],
  162:[0,0,14987,2081,0],161:[0,0,15163,2214,0],160:[0,0,15298,2291,0],
  159:[0,0,15398,2360,44],158:[0,0,15570,2459,105],157:[0,0,15742,2595,140],
  156:[0,0,15900,2677,1721],155:[0,0,16040,2811,2220],154:[0,0,16198,2950,2505],
  153:[0,0,16304,3067,2654],152:[0,0,16457,3134,2832],151:[0,0,16566,3224,3009],
  150:[0,0,16691,3466,3161],149:[0,0,16830,4202,3252],148:[0,0,16935,5763,3367],
  147:[0,0,17060,6446,3461],146:[0,0,17201,6822,3528],145:[0,0,17360,7149,3607],
  144:[0,0,17497,7540,3683],143:[0,0,17689,7846,3757],142:[0,0,17806,8187,3828],
  141:[0,0,17939,8471,3892],140:[0,0,18026,8712,3967],139:[0,0,18108,8871,4023],
  138:[0,0,18204,9017,4090],137:[0,0,18365,9165,4233],136:[0,0,18489,9375,4357],
  135:[0,0,18617,9575,4461],134:[0,0,18748,9708,4611],133:[0,0,18836,9863,4721],
  132:[0,0,18922,9975,4815],131:[0,0,18983,10026,4926],130:[0,0,19095,10102,5067],
  129:[0,0,19233,10259,5186],128:[0,0,19365,10437,5318],127:[0,0,19456,10604,5398],
  126:[0,0,19539,10766,5521],125:[0,0,19604,10878,5577],124:[0,0,19723,10967,5684],
  123:[0,0,19873,11060,5872],122:[0,0,20000,11225,6197],121:[0,0,20091,11340,6370],
  120:[0,0,20176,11473,6547],119:[0,0,20250,11628,6681],118:[0,0,20355,11735,6867],
  117:[0,0,20489,11832,7117],116:[0,0,20655,11931,8820],115:[0,0,20747,12082,8914],
  114:[0,0,20933,12242,8940],113:[0,0,21462,12365,8948],112:[0,0,21981,12483,8963],
  111:[0,0,22176,12577,8963],110:[0,0,22369,12673,8963],109:[0,0,22626,12798,8963],
  108:[0,0,22823,13005,8963],107:[0,0,23010,13119,8965],106:[0,0,23144,13280,8965],
  105:[0,0,23262,13404,8967],104:[0,0,23389,13504,8967],103:[0,0,23575,13603,8981],
  102:[0,0,23793,13741,11377],101:[0,0,23950,13873,13251],100:[0,0,24080,14038,17401],
  99:[0,0,24280,14188,18534],98:[0,0,24405,14326,19312],97:[0,0,24520,14409,19834],
  96:[0,0,24693,14476,20423],95:[0,0,24889,14579,21031],94:[0,0,25113,15429,21594],
  93:[0,0,25289,16008,22028],92:[0,0,25457,16333,22469],91:[0,0,25613,16646,22763],
  90:[0,0,25749,16963,22963],89:[0,0,25956,17456,23204],88:[0,0,26205,18023,24034],
  87:[0,0,26330,18718,24357],86:[0,1453,26535,19454,24671],85:[0,2426,26578,19973,25040],
  84:[0,2922,26521,20490,25278],83:[0,3389,26642,20885,25436],82:[0,3815,26813,21040,25667],
  81:[0,4531,27000,21203,25982],80:[0,5208,27181,21519,26229],79:[0,5740,27372,21764,26518],
  78:[0,6079,27478,22551,26711],77:[0,6431,27608,22766,26908],76:[0,6660,27747,22951,27105],
  75:[0,6901,27894,23127,27365],74:[0,7290,28082,23336,27723],73:[1035,7649,28266,23583,28031],
  72:[2254,7944,28491,23930,28288],71:[3473,8071,28655,24198,28515],70:[3473,8300,28772,24388,28746],
  69:[4072,8457,28833,24621,28954],68:[4671,8651,28950,24784,29189],67:[5270,8968,29184,24976,29525],
  66:[8088,9358,29397,25342,29875],65:[10907,9776,29586,25705,30218],64:[11769,10939,29781,26016,30516],
  63:[12632,11678,29923,26314,30922],62:[13494,12093,30046,26535,31218],61:[14357,12648,30237,26740,31631],
  60:[15219,13237,30430,26999,32111],59:[16082,13852,30640,27294,32540],58:[16944,14274,30876,27641,32961],
  57:[18385,14598,31107,27980,33315],56:[18706,14904,31351,28298,33621],55:[19028,15089,31564,28538,33847],
  54:[19350,15461,31934,28803,34182],53:[19671,15891,32301,29113,34630],52:[20729,16314,32654,29567,35125],
  51:[21786,16626,33059,30003,35615],50:[22844,16971,33722,30443,36104],49:[23901,17272,34177,30851,36489],
  48:[24959,17550,34486,31209,36804],47:[26016,17984,34894,31437,37158],46:[27074,18540,35339,31867,37805],
  45:[28279,19036,35864,32371,38655],44:[29484,19557,36346,32894,39709],43:[30689,20027,36697,33371,40632],
  42:[31136,20554,37062,33806,41665],41:[31582,21017,37357,34275,42468],40:[32029,21684,37789,34649,43412],
  39:[32476,22454,38284,35116,44648],38:[34221,23550,38734,35718,46754],37:[35966,24410,39423,36250,48191],
  36:[37339,25105,40311,37037,49443],35:[38283,25694,40788,37882,50414],34:[39228,26208,41200,38731,51334],
  33:[40172,26990,41684,39486,52659],32:[41117,28291,42384,40362,54461],31:[42061,30191,42996,41664,56597],
  30:[43656,32449,43627,42988,59109],29:[45252,33338,44328,44836,60946],28:[46847,34012,45054,46720,63526],
  27:[47134,34352,45473,48209,64616],26:[47420,34992,46109,49704,65912],25:[47707,35738,46960,51385,67932],
  24:[48828,36453,47985,53712,69745],23:[49948,37196,49361,56757,72174],22:[51069,38060,50413,60073,73985],
  21:[52190,38786,51275,62975,75288],20:[52604,39366,52192,65019,76393],19:[53019,39955,53337,66609,78241],
  18:[53433,42205,54864,68201,80292],17:[56580,43348,56288,70674,82231],16:[58921,44728,57679,74097,84314],
  15:[61545,45896,59104,76742,86248],14:[61766,46491,60277,79120,88353],13:[64565,47302,61260,81581,90090],
  12:[64595,47708,62835,83483,92819],11:[64613,48897,65055,85683,97086],10:[66608,50157,67244,88818,101552],
  9:[68660,51290,69340,92386,106305],8:[70712,51923,71549,96574,110663],7:[75893,53308,73506,100007,114850],
  6:[79079,54093,75384,103512,118942],5:[82264,54528,78143,106633,123814],4:[85450,55823,82618,110301,131392],
  3:[88636,62842,87217,116105,138472],2:[89835,66573,92178,123617,145703],1:[91034,71406,97758,131487,152402],
  0:[92233,75121,104366,140779,159223],
  '-1':[93718,77305,109777,146022,164418],'-2':[95203,79079,113942,151738,168077],
  '-3':[96284,82590,117384,159711,171396],'-4':[97365,85381,119019,166626,174643],
  '-5':[100648,88250,125685,171420,178524],'-6':[102910,90822,130937,172796,181327],
  '-7':[105173,92489,135652,173514,183790],'-8':[107054,93218,139125,173878,185312],
  '-9':[107861,93218,140660,174954,185316],'-10':[107861,93218,140852,175959,185316]
};

// Converte dailyData (array {date,tks}) ‚Üí mapa countdown‚Üíacumulado para 2026
function build2026Countdown(dailyData) {
  const FESTIVAL = new Date('2026-09-04T00:00:00-03:00');
  const sorted = [...(dailyData||[])].sort((a,b)=>a.date.localeCompare(b.date));
  let cum = 0;
  const result = {};
  for (const d of sorted) {
    cum += d.tks || 0;
    const dt = new Date(d.date + 'T12:00:00-03:00');
    const cd = Math.round((FESTIVAL - dt) / 86400000);
    result[cd] = cum;
  }
  return result;
}

function renderComparativo(json) {
  const cd2026 = build2026Countdown(json.dailyData || []);
  const currentCd = typeof json.daysLeft === 'number' ? json.daysLeft : 56;

  const YR_LABELS = ['2015','2017','2019','2022','2024','2026 ‚ö°'];
  const YR_COLORS = ['#748ffc','#f4a261','#2ec27e','#9b59b6','#1abc9c','#e63946'];

  // Coleta todas as chaves num√©ricas dispon√≠veis, ordena do maior para menor (D-180 ‚Üí D+10)
  const allKeys = Object.keys(HIST_CD).map(Number).sort((a,b)=>b-a);

  // Filtra: mostra apenas linhas com ao menos um dado > 0
  const activeKeys = allKeys.filter(cd => {
    const row = HIST_CD[cd] || [0,0,0,0,0];
    return row.some(v=>v>0) || (cd2026[cd] != null && cd2026[cd] > 0);
  });

  // Pr√©-calcula deltas di√°rios para 2024 e 2026
  // delta[cd] = acumulado[cd] - acumulado[cd+1] (D-(cd+1) √© o dia anterior)
  function dailyDelta2024(cd) {
    const cur  = (HIST_CD[cd]  || [0,0,0,0,0])[4] || 0;
    const prev = (HIST_CD[cd+1]|| [0,0,0,0,0])[4] || 0;
    return cur > 0 ? Math.max(0, cur - prev) : null;
  }
  function dailyDelta2026(cd) {
    const cur  = cd2026[cd]   != null ? cd2026[cd]   : null;
    const prev = cd2026[cd+1] != null ? cd2026[cd+1] : 0;
    return cur != null ? Math.max(0, cur - prev) : null;
  }

  function fmtN(v) {
    if (v == null || v === 0) return '<span style="color:#3a3f4a">‚Äî</span>';
    return Number(v).toLocaleString('pt-BR');
  }
  function fmtDiff(diff) {
    if (diff == null) return '<span style="color:#3a3f4a">‚Äî</span>';
    const sign = diff >= 0 ? '+' : '';
    const cls  = diff >= 0 ? 'diff-pos' : 'diff-neg';
    return '<span class="'+cls+'">'+sign+Number(diff).toLocaleString('pt-BR')+'</span>';
  }
  function growthBadge(curr, prev) {
    if (!prev || !curr || prev === 0) return '';
    const pct = ((curr - prev) / prev * 100);
    const cls = pct >= 0 ? 'growth-pos' : 'growth-neg';
    return ' <span class="'+cls+'">'+(pct>=0?'+':'')+pct.toFixed(0)+'%</span>';
  }

  // ‚îÄ‚îÄ Cabe√ßalho com dois grupos ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
  let html = '<table class="comp-table"><thead>';

  // Linha 1 ‚Äî grupo de colunas
  html += '<tr>';
  html += '<th rowspan="2" style="min-width:56px;vertical-align:bottom">D-N</th>';
  html += '<th colspan="6" style="text-align:center;border-bottom:1px solid #2a3040;padding-bottom:4px">Ingressos Acumulados</th>';
  html += '<th colspan="3" style="text-align:center;border-bottom:1px solid #2a3040;padding-bottom:4px;color:#aaa">Vendas no Dia</th>';
  html += '</tr>';

  // Linha 2 ‚Äî sub-cabe√ßalhos
  html += '<tr>';
  YR_LABELS.forEach((y,i) => {
    html += '<th style="color:'+YR_COLORS[i]+'">'+y+'</th>';
  });
  html += '<th style="color:#1abc9c">Dia/2024</th>';
  html += '<th style="color:#e63946">Dia/2026 ‚ö°</th>';
  html += '<th style="color:#aaa">Œî 26-24</th>';
  html += '</tr>';

  html += '</thead><tbody>';

  activeKeys.forEach(cd => {
    const hist   = HIST_CD[cd] || [0,0,0,0,0];
    const v2026  = cd2026[cd]  != null ? cd2026[cd] : null;
    const isCur  = cd === currentCd;
    const rowCls = isCur ? ' class="row-current"' : '';
    const label  = cd >= 0 ? 'D-'+cd : 'D+'+Math.abs(cd);

    // Deltas di√°rios
    const d24  = dailyDelta2024(cd);
    const d26  = dailyDelta2026(cd);
    const diff = (d24 != null && d26 != null) ? (d26 - d24) : null;

    html += '<tr'+rowCls+'>';
    html += '<td class="col-cd">'+label+(isCur?' ‚óÄ':'')+'</td>';

    // Acumulados hist√≥ricos (2015‚Äì2024)
    hist.forEach(v => { html += '<td>'+(v ? fmtN(v) : '<span style="color:#3a3f4a">‚Äî</span>')+'</td>'; });

    // Acumulado 2026
    const prev2024 = hist[4] || 0;
    const badge = (v2026 && prev2024) ? growthBadge(v2026, prev2024) : '';
    html += '<td class="col-2026">'+( v2026 ? fmtN(v2026)+badge : '<span style="color:#3a3f4a">‚Äî</span>' )+'</td>';

    // Vendas no dia
    html += '<td class="col-daily">'+fmtN(d24)+'</td>';
    html += '<td class="col-daily col-2026">'+( d26 != null ? fmtN(d26) : '<span style="color:#3a3f4a">‚Äî</span>' )+'</td>';
    html += '<td class="col-daily">'+fmtDiff(diff)+'</td>';

    html += '</tr>';
  });

  html += '</tbody></table>';
  document.getElementById('comp-table-wrap').innerHTML = html;

  // Scroll para a linha corrente
  setTimeout(() => {
    const cur = document.querySelector('.row-current');
    if (cur) cur.scrollIntoView({ block:'center', behavior:'smooth' });
  }, 300);
}

function exportComparativo() {
  if (typeof XLSX === 'undefined') { alert('SheetJS ainda carregando, tente em breve.'); return; }
  const table = document.querySelector('.comp-table');
  if (!table) { alert('Tabela ainda n√£o carregada.'); return; }
  const ws = XLSX.utils.table_to_sheet(table);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Comparativo Hist√≥rico');
  XLSX.writeFile(wb, 'comparativo-historico-RiR.xlsx');
}

document.addEventListener('DOMContentLoaded', loadData);
<\/script>
</body></html>`;
}

// ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
// PAGAMENTO √ó PERFIL PAGE
// ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
function getPagamentoHTML(username) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pagamento √ó Perfil ‚Äî Rock in Rio 2026</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<style>
${SHARED_CSS_VARS}
${SHARED_HEADER_CSS}
  .content{padding:20px 32px 60px}
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:20px}
  .kpi{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;text-align:center}
  .kpi-icon{font-size:22px;margin-bottom:6px}
  .kpi-label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:4px;font-weight:700}
  .kpi-val{font-size:22px;font-weight:800;color:var(--blue)}
  .kpi-sub{font-size:11px;color:var(--muted);margin-top:3px}
  .kpi.green .kpi-val{color:var(--green)}.kpi.teal .kpi-val{color:var(--teal)}
  .kpi.gold .kpi-val{color:var(--gold)}.kpi.red .kpi-val{color:var(--accent)}
  .section{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px;margin-bottom:18px}
  .section-title{font-size:13px;font-weight:700;color:var(--blue);margin-bottom:14px;padding-bottom:8px;border-bottom:1px solid var(--border)}
  .charts-row{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:18px}
  .charts-row-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;margin-bottom:18px}
  .chart-wrap{position:relative;height:260px}
  .chart-wrap-sm{position:relative;height:200px}
  .no-data{text-align:center;padding:48px 20px;color:var(--muted)}
  .no-data-icon{font-size:48px;margin-bottom:12px}
  .no-data h3{font-size:16px;font-weight:700;margin-bottom:8px;color:var(--text)}
  .bank-table{width:100%;border-collapse:collapse;font-size:13px}
  .bank-table tr{border-bottom:1px solid var(--border)}
  .bank-table tr:last-child{border-bottom:none}
  .bank-table tr:hover td{background:var(--surface2)}
  .bank-table td{padding:9px 10px}
  .bank-rank{width:32px;font-weight:800;color:var(--muted);text-align:center}
  .bank-rank.top3{color:var(--gold)}
  .bank-name{font-weight:600}
  .bank-bar-td{width:40%;padding:9px 6px}
  .bank-bar-wrap{background:var(--surface2);border-radius:4px;height:7px;overflow:hidden}
  .bank-bar-fill{height:100%;border-radius:4px;background:var(--blue)}
  .bank-count{text-align:right;font-weight:700;min-width:50px;white-space:nowrap}
  .bank-pct{text-align:right;color:var(--muted);font-size:11px;min-width:42px}
  .gender-split{display:flex;align-items:center;gap:8px;margin-top:12px}
  .gender-bar{flex:1;height:32px;border-radius:8px;overflow:hidden;display:flex}
  .gender-bar-f{background:var(--purple);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;transition:width .6s}
  .gender-bar-m{background:var(--blue);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;transition:width .6s}
  .gender-labels{display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-top:6px}
  @media(max-width:768px){
    header,.content{padding-left:16px;padding-right:16px}
    .charts-row,.charts-row-3{grid-template-columns:1fr}
    .kpis{grid-template-columns:1fr 1fr}
    #status-bar{padding-left:16px;padding-right:16px}
  }
</style>
</head>
<body>

<div id="loading" style="position:fixed;inset:0;background:rgba(10,12,16,.9);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;z-index:9999;font-size:14px;color:var(--muted)">
  <div style="width:38px;height:38px;border:3px solid var(--border);border-top-color:var(--blue);border-radius:50%;animation:spin .8s linear infinite"></div>
  <span>Carregando dados de pagamento...</span>
  <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
</div>

<header>
  <div class="header-left">
    <div class="logo-badge">Rock in Rio 2026</div>
    <div>
      <h1>Pagamento √ó Perfil</h1>
      <p>M√©todos de pagamento, bancos e perfil do comprador ¬∑ Logado como <strong>${username}</strong></p>
    </div>
  </div>
  <div class="header-right">
    <a href="/" class="btn btn-back">‚Üê Painel</a>
    <form method="POST" action="/logout" style="margin:0">
      <button class="btn btn-secondary" type="submit">Sair</button>
    </form>
  </div>
</header>

<div id="status-bar">
  <span class="status-dot" id="status-dot"></span>
  <span id="status-text">Conectando...</span>
</div>

<div class="content" id="content" style="display:none">

  <!-- KPIs -->
  <div class="kpis">
    <div class="kpi"><div class="kpi-icon">üéüÔ∏è</div><div class="kpi-label">Total Ingressos</div><div class="kpi-val" id="k-total">‚Äî</div></div>
    <div class="kpi green"><div class="kpi-icon">üí≥</div><div class="kpi-label">Cart√£o de Cr√©dito</div><div class="kpi-val" id="k-cc">‚Äî</div><div class="kpi-sub" id="k-cc-sub"></div></div>
    <div class="kpi teal"><div class="kpi-icon">üè¶</div><div class="kpi-label">PIX</div><div class="kpi-val" id="k-pix">‚Äî</div><div class="kpi-sub" id="k-pix-sub"></div></div>
    <div class="kpi"><div class="kpi-icon">üèÜ</div><div class="kpi-label">Top M√©todo</div><div class="kpi-val" id="k-top-bank" style="font-size:16px">‚Äî</div></div>
    <div class="kpi gold"><div class="kpi-icon">‚≠ê</div><div class="kpi-label">Bandeira #1</div><div class="kpi-val" id="k-top-brand" style="font-size:15px">‚Äî</div></div>
  </div>

  <!-- M√©todo de Pagamento + Bandeiras -->
  <div class="charts-row">
    <div class="section">
      <div class="section-title" style="display:flex;align-items:center;justify-content:space-between">
        <span>üí≥ M√©todo de Pagamento</span>
        <button id="btn-export-cortesia" onclick="exportCortesiaClub()" style="display:none;padding:5px 12px;border:none;border-radius:6px;background:linear-gradient(135deg,#c0392b,#8e1a11);color:#fff;font-size:12px;font-weight:600;cursor:pointer;gap:5px;align-items:center">
          ‚¨á Exportar Cortesia Club
        </button>
      </div>
      <div id="paytype-list"></div>
    </div>
    <div class="section">
      <div class="section-title">‚≠ê Bandeiras de Cart√£o</div>
      <div class="chart-wrap"><canvas id="chartBrand"></canvas></div>
    </div>
  </div>

  <!-- Tipo Cart√£o + Parcelamento (s√≥ com dados) -->
  <div class="charts-row" id="row-extras" style="display:none">
    <div class="section" id="section-cardtype" style="display:none">
      <div class="section-title">üîµ Tipo de Cart√£o</div>
      <div class="chart-wrap-sm" style="margin-top:20px"><canvas id="chartCardType"></canvas></div>
    </div>
    <div class="section" id="section-install" style="display:none">
      <div class="section-title">üìä Parcelamento</div>
      <div class="chart-wrap"><canvas id="chartInstall"></canvas></div>
    </div>
  </div>

  <!-- Parcelamento (s√≥ com dados) -->
  <div class="section" id="section-install" style="display:none">
    <div class="section-title">üìä Parcelamento</div>
    <div class="chart-wrap"><canvas id="chartInstall"></canvas></div>
  </div>

  <!-- G√™nero -->
  <div class="section" id="section-gender" style="display:none">
    <div class="section-title">üë• Perfil ‚Äî G√™nero</div>
    <p style="font-size:12px;color:var(--muted);margin-bottom:14px">Distribui√ß√£o por g√™nero do comprador</p>
    <div class="gender-split">
      <span style="font-size:13px;color:var(--purple);font-weight:700">‚ôÄ Fem</span>
      <div class="gender-bar">
        <div class="gender-bar-f" id="gender-bar-f">‚Äî</div>
        <div class="gender-bar-m" id="gender-bar-m">‚Äî</div>
      </div>
      <span style="font-size:13px;color:var(--blue);font-weight:700">Masc ‚ôÇ</span>
    </div>
    <div class="gender-labels"><span id="gender-lbl-f"></span><span id="gender-lbl-m"></span></div>
  </div>

  <!-- Idade -->
  <div class="section" id="section-age" style="display:none">
    <div class="section-title">üìÖ Perfil ‚Äî Faixa Et√°ria</div>
    <div class="chart-wrap"><canvas id="chartAge"></canvas></div>
  </div>

  <!-- No data message -->
  <div id="no-data" style="display:none">
    <div class="no-data">
      <div class="no-data-icon">üìã</div>
      <h3>Dados de pagamento n√£o dispon√≠veis</h3>
      <p style="max-width:480px;margin:0 auto;font-size:13px">A API Crowder ainda n√£o retornou dados detalhados de pagamento e perfil para esta chave. Esses dados aparecem conforme as vendas s√£o processadas.</p>
    </div>
  </div>

</div>

<script>
const BLUE_PALETTE = ['#5b8dee','#4a7cdc','#3d6abf','#2ec27e','#1abc9c','#9b59b6','#e63946','#f4a261','#ffd700','#e8871a','#FF6B9D'];
const BRAND_COLORS  = { MASTERCARD:'#eb5b25', VISA:'#1a1f71', ELO:'#ffd700', 'AMERICAN EXPRESS':'#016fcf', DISCOVER:'#f76f20', HIPERCARD:'#b81c22' };

function fmt(n){ return n>=1e6 ? (n/1e6).toFixed(1)+'M' : n>=1e3 ? (n/1e3).toFixed(1)+'K' : String(n||0); }

function mkChart(id, type, labels, data, colors, opts={}){
  const ctx = document.getElementById(id);
  if(!ctx) return;
  return new Chart(ctx,{
    type, data:{ labels, datasets:[{ data, backgroundColor: colors||BLUE_PALETTE, borderColor: type==='bar'?'transparent':'#131720', borderWidth:2 }]},
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{ display: type!=='bar', position:'right', labels:{ color:'#7a8499', font:{size:11}, padding:12 }},
        tooltip:{ callbacks:{ label: ctx=>{ const v=ctx.parsed.y??ctx.parsed; return ' '+Number(v).toLocaleString('pt-BR'); } }}},
      scales: type==='bar' ? { x:{ ticks:{ color:'#7a8499', font:{size:11}}, grid:{color:'#252d3d'} }, y:{ ticks:{ color:'#7a8499', font:{size:11}}, grid:{color:'#252d3d'}, beginAtZero:true } } : {},
      ...opts
    }
  });
}

async function loadData(){
  try {
    const res  = await fetch('/api/pagamento-data');
    const json = await res.json();

    document.getElementById('loading').style.display='none';
    document.getElementById('content').style.display='block';

    const ts = json.updated_at || '‚Äî';
    document.getElementById('status-dot').className='status-dot green';
    document.getElementById('status-text').textContent = 'Dados ao vivo ¬∑ '+ts;

    if(!json.hasData){
      document.getElementById('no-data').style.display='block';
      // Update KPIs with what we have
      document.getElementById('k-total').textContent = fmt(json.total||0);
      return;
    }

    // ‚îÄ‚îÄ KPIs ‚îÄ‚îÄ
    const total = json.total||0;
    document.getElementById('k-total').textContent   = fmt(total);
    document.getElementById('k-cc').textContent      = fmt(json.ccCount||0);
    document.getElementById('k-cc-sub').textContent  = total ? ((json.ccCount||0)*100/total).toFixed(1)+'% do total' : '';
    document.getElementById('k-pix').textContent     = fmt(json.pixCount||0);
    document.getElementById('k-pix-sub').textContent = total ? ((json.pixCount||0)*100/total).toFixed(1)+'% do total' : '';
    const topPt = Object.entries(json.payTypeMap||{}).sort((a,b)=>b[1]-a[1])[0];
    if(topPt) document.getElementById('k-top-bank').textContent = topPt[0];
    if(json.brandSorted&&json.brandSorted[0]) document.getElementById('k-top-brand').textContent = json.brandSorted[0][0];

    // ‚îÄ‚îÄ M√©todo de Pagamento (tabela com barras) ‚îÄ‚îÄ
    const PT_COLORS = {'Cr√©dito':'#5b8dee','PIX':'#2ec27e','D√©bito':'#9b59b6','Boleto':'#f4a261','PREPAID_CARD':'#1abc9c','Cortesia Club':'#c0392b','Cortesia':'#e67e22'};
    const ptEntries = Object.entries(json.payTypeMap||{}).sort((a,b)=>b[1]-a[1]);
    const ptMax = ptEntries[0]?.[1]||1;
    const ptHtml = ptEntries.map((e,i)=>{
      const pct = ((e[1]/total)*100).toFixed(1);
      const color = PT_COLORS[e[0]]||'#748ffc';
      return \`<tr>
        <td class="bank-rank \${i<3?'top3':''}">\${i+1}</td>
        <td class="bank-name">\${e[0]}</td>
        <td class="bank-bar-td"><div class="bank-bar-wrap"><div class="bank-bar-fill" style="width:\${Math.round(e[1]/ptMax*100)}%;background:\${color}"></div></div></td>
        <td class="bank-count">\${e[1].toLocaleString('pt-BR')}</td>
        <td class="bank-pct">\${pct}%</td>
      </tr>\`;
    }).join('');
    document.getElementById('paytype-list').innerHTML = '<table class="bank-table">'+ptHtml+'</table>';

    // ‚îÄ‚îÄ Exibe bot√£o Exportar Cortesia Club se houver dados ‚îÄ‚îÄ
    const hasCortesia = (json.payTypeMap||{})['Cortesia Club'] > 0;
    const btnExport = document.getElementById('btn-export-cortesia');
    if(btnExport) btnExport.style.display = hasCortesia ? 'inline-flex' : 'none';

    // ‚îÄ‚îÄ Bandeiras ‚îÄ‚îÄ
    const brands = json.brandSorted||[];
    const brandColors = brands.map(b=>BRAND_COLORS[b[0]]||BLUE_PALETTE[brands.indexOf(b)%BLUE_PALETTE.length]);
    mkChart('chartBrand','doughnut', brands.map(b=>b[0]), brands.map(b=>b[1]), brandColors);

    // ‚îÄ‚îÄ Parcelas (s√≥ se houver dados) ‚îÄ‚îÄ
    const inst = json.installSorted||[];
    if(inst.length>0){
      document.getElementById('section-install').style.display='block';
      document.getElementById('row-extras').style.display='grid';
      mkChart('chartInstall','bar', inst.map(i=>i[0]), inst.map(i=>i[1]), BLUE_PALETTE);
    }

    // ‚îÄ‚îÄ Tipo Cart√£o (s√≥ se houver dados) ‚îÄ‚îÄ
    const ct = Object.entries(json.cardTypeMap||{}).sort((a,b)=>b[1]-a[1]);
    if(ct.length>0){
      document.getElementById('section-cardtype').style.display='block';
      document.getElementById('row-extras').style.display='grid';
      mkChart('chartCardType','doughnut', ct.map(c=>c[0]), ct.map(c=>c[1]), ['#5b8dee','#2ec27e','#9b59b6','#e63946']);
    }

    // ‚îÄ‚îÄ G√™nero ‚îÄ‚îÄ
    const gm = json.genderMap||{};
    const fCount = gm['FEMALE']||gm['F']||0;
    const mCount = gm['MALE']||gm['M']||0;
    if(fCount+mCount>0){
      document.getElementById('section-gender').style.display='block';
      const tot = fCount+mCount;
      const fp = Math.round(fCount/tot*100);
      const mp = 100-fp;
      document.getElementById('gender-bar-f').style.width = fp+'%';
      document.getElementById('gender-bar-f').textContent = fp+'%';
      document.getElementById('gender-bar-m').style.width = mp+'%';
      document.getElementById('gender-bar-m').textContent = mp+'%';
      document.getElementById('gender-lbl-f').textContent = 'Feminino: '+fCount.toLocaleString('pt-BR')+' ('+fp+'%)';
      document.getElementById('gender-lbl-m').textContent = 'Masculino: '+mCount.toLocaleString('pt-BR')+' ('+mp+'%)';
    }

    // ‚îÄ‚îÄ Faixa Et√°ria ‚îÄ‚îÄ
    const ageOrder = ['<18','18-24','25-34','35-44','45-54','55+'];
    const am = json.ageMap||{};
    const ageEntries = Object.entries(am).sort((a,b)=>{
      const ai = ageOrder.indexOf(a[0]); const bi = ageOrder.indexOf(b[0]);
      return (ai<0?99:ai)-(bi<0?99:bi);
    });
    if(ageEntries.length>0){
      document.getElementById('section-age').style.display='block';
      mkChart('chartAge','bar', ageEntries.map(e=>e[0]), ageEntries.map(e=>e[1]), BLUE_PALETTE);
    }

  } catch(e){
    document.getElementById('loading').style.display='none';
    document.getElementById('content').style.display='block';
    document.getElementById('status-dot').className='status-dot red';
    document.getElementById('status-text').textContent = 'Erro: '+e.message;
  }
}
function exportCortesiaClub() {
  const btn = document.getElementById('btn-export-cortesia');
  if(btn) { btn.disabled = true; btn.textContent = '‚è≥ Baixando...'; }
  fetch('/api/cortesia-club/csv')
    .then(r => {
      if(!r.ok) throw new Error('Erro '+r.status);
      return r.blob();
    })
    .then(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'cortesia_club.csv';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
    })
    .catch(err => alert('Erro ao exportar: ' + err.message))
    .finally(() => {
      if(btn) { btn.disabled = false; btn.innerHTML = '‚¨á Exportar Cortesia Club'; }
    });
}
document.addEventListener('DOMContentLoaded', loadData);
<\/script>
</body></html>`;
}

// ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
// START
// ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ‚îÄ
app.listen(PORT, () => {
  console.log(`\nüé∏ Rock in Rio Dashboard rodando em http://localhost:${PORT}`);
  console.log(`\n‚öôÔ∏è  Vari√°veis de ambiente:`);
  console.log(`   USERS          = "usuario1:senha1,usuario2:senha2"`);
  console.log(`   SESSION_SECRET = "string-aleat√≥ria-longa"`);
  console.log(`   CROWDER_API_KEY = (opcional, padr√£o em c√≥digo)\n`);
  // Buscar dados imediatamente ao iniciar
  refreshData();
});

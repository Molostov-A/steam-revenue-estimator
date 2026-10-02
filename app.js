'use strict';

const API_BASE = window.STEAM_ESTIMATOR_API || '';

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);

function num(id) {
  const v = $(id).value.trim();
  if (v === '') return null;
  const n = Number(v.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function round1(n) { return Math.round(n * 10) / 10; }

function money(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function compact(v) {
  if (v == null || !Number.isFinite(v)) return null;
  if (v >= 1e9) return (v / 1e9).toFixed(2) + ' млрд';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + ' млн';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + ' тыс';
  return Math.round(v) + '';
}

function fmtInt(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return Math.round(v).toLocaleString('en-US');
}

// ---------- tax presets ----------
const TAX_PRESETS = {
  none:    { tax: 0,  us: 0,  fee: 0, label: 'Без налогов' },
  ru_ndfl: { tax: 13, us: 30, fee: 2, label: 'Россия — физлицо (НДФЛ 13%)' },
  ru_npd:  { tax: 6,  us: 30, fee: 2, label: 'Россия — самозанятый (НПД 6%)' },
  ru_ip6:  { tax: 6,  us: 30, fee: 2, label: 'Россия — ИП (УСН 6%)' },
  ru_ip15: { tax: 15, us: 30, fee: 2, label: 'Россия — ИП (УСН 15%)' },
  custom:  { tax: null, us: null, fee: 2, label: 'Свой вариант' },
};

// ---------- model: review ratio suggestion ----------
function suggestRatio(year, price) {
  let base;
  if (!year) base = { min: 20, mode: 30, max: 55 };
  else if (year >= 2020) base = { min: 20, mode: 30, max: 45 };
  else if (year >= 2016) base = { min: 25, mode: 40, max: 60 };
  else if (year >= 2012) base = { min: 35, mode: 55, max: 85 };
  else base = { min: 45, mode: 70, max: 100 };

  let mult = 1;
  if (price != null) {
    if (price < 5) mult = 0.8;
    else if (price <= 15) mult = 1.0;
    else if (price <= 30) mult = 1.15;
    else mult = 1.3;
  }
  return {
    min: round1(base.min * mult),
    mode: round1(base.mode * mult),
    max: round1(base.max * mult),
  };
}

// ---------- model: steam fee ----------
function tieredSteamFee(gross) {
  const t1 = 10_000_000, t2 = 50_000_000;
  if (gross <= t1) return gross * 0.30;
  if (gross <= t2) return t1 * 0.30 + (gross - t1) * 0.25;
  return t1 * 0.30 + (t2 - t1) * 0.25 + (gross - t2) * 0.20;
}

// ---------- model: single pipeline run ----------
function runPipeline(inp, ratio, discount) {
  const r = {};
  if (inp.gross != null) {
    r.source = 'gross';
    r.gross = inp.gross;
  } else if (inp.owners != null) {
    r.source = 'owners';
    r.owners = inp.owners;
    if (inp.price != null) r.gross = r.owners * inp.price * discount;
  } else if (inp.reviews != null) {
    r.source = 'reviews';
    r.owners = inp.reviews * ratio;
    if (inp.price != null) r.gross = r.owners * inp.price * discount;
  } else {
    r.source = 'none';
  }

  if (r.gross != null) {
    r.steamFee = inp.tieredCut ? tieredSteamFee(r.gross) : r.gross * (inp.steamCut / 100);
    r.effectiveCut = r.gross > 0 ? r.steamFee / r.gross : 0;
    r.netAfterSteam = r.gross - r.steamFee;
    r.usWithholding = r.netAfterSteam * (inp.usWithholding / 100);
    r.netAfterUS = r.netAfterSteam - r.usWithholding;
    r.publisherTake = r.netAfterUS * (inp.publisher / 100);
    r.netAfterPublisher = r.netAfterUS - r.publisherTake;
    r.taxTake = r.netAfterPublisher * (inp.tax / 100);
    r.netAfterTax = r.netAfterPublisher - r.taxTake;
    r.withdrawalFee = r.netAfterTax * (inp.withdrawalFee / 100);
    r.netAfterWithdrawal = r.netAfterTax - r.withdrawalFee;
    r.refundTake = r.netAfterWithdrawal * (inp.refund / 100);
    r.devRevenue = r.netAfterWithdrawal - r.refundTake;
  }
  return r;
}

// ---------- model: resolve ASP override ----------
function resolveDiscount(inp) {
  if (inp.asp != null && inp.price != null && inp.price > 0) {
    const mode = Math.min(inp.asp / inp.price, 1);
    return { min: Math.min(mode * 0.85, 1), mode, max: Math.min(mode * 1.15, 1), fromAsp: true };
  }
  return { min: inp.discountMin, mode: inp.discountMode, max: inp.discountMax, fromAsp: false };
}

// ---------- collect inputs ----------
function collectInputs() {
  const inp = {
    reviews: num('reviews'),
    price: num('price'),
    asp: num('asp'),
    owners: num('owners'),
    gross: num('gross'),
    year: num('year'),
    ratioMin: num('ratioMin'),
    ratioMode: num('ratioMode'),
    ratioMax: num('ratioMax'),
    discountMin: num('discountMin') ?? 0.4,
    discountMode: num('discountMode') ?? 0.6,
    discountMax: num('discountMax') ?? 0.9,
    steamCut: num('steamCut') ?? 30,
    publisher: num('publisher') ?? 0,
    tax: num('tax') ?? 0,
    withdrawalFee: num('withdrawalFee') ?? 0,
    usWithholding: num('usWithholding') ?? 0,
    taxMode: $('taxMode').value,
    refund: num('refund') ?? 5,
    tieredCut: $('tieredCut').checked,
  };
  return inp;
}

// ---------- calculate ----------
function calculate(inp) {
  const discount = resolveDiscount(inp);
  const scenarios = {
    low: runPipeline(inp, inp.ratioMin, discount.min),
    mid: runPipeline(inp, inp.ratioMode, discount.mode),
    high: runPipeline(inp, inp.ratioMax, discount.max),
  };
  return { inp, discount, scenarios };
}

// ---------- render ----------
function render(result) {
  const { inp, discount, scenarios } = result;
  const mid = scenarios.mid;

  const showOwners = mid.owners != null;
  const showGross = mid.gross != null;
  const showNet = mid.devRevenue != null;

  if (mid.source === 'none') {
    alert('Введите хотя бы одно из: количество отзывов, число владельцев или валовую выручку.');
    return;
  }

  $('results').classList.remove('hidden');

  // cards
  [['low', 'res-low', 'res-low-owners'], ['mid', 'res-mid', 'res-mid-owners'], ['high', 'res-high', 'res-high-owners']]
    .forEach(([key, valueId, subId]) => {
      const s = scenarios[key];
      const valEl = $(valueId);
      const subEl = $(subId);
      if (showNet) valEl.textContent = money(s.devRevenue);
      else if (showGross) valEl.textContent = money(s.gross);
      else valEl.textContent = '—';

      const parts = [];
      if (s.owners != null) parts.push('Владельцев ≈ ' + fmtInt(s.owners));
      if (showNet) parts.push('Валовая ≈ ' + money(s.gross));
      subEl.textContent = parts.join(' · ');
    });

  // formula
  $('formula-text').textContent = buildFormula(inp, discount, showOwners, showGross, showNet);

  // steps
  $('steps-text').textContent = buildSteps(inp, discount, mid, showOwners, showGross, showNet);
}

function buildFormula(inp, discount, showOwners, showGross, showNet) {
  const L = [];
  L.push('Общая модель (Boxleiter / review-to-sales):');
  L.push('');
  if (showOwners) L.push('  владельцы      ≈ отзывы × ratio');
  L.push('  валовая выручка ≈ владельцы × цена × коэффициент_скидок');
  if (showNet) {
    L.push('  комиссия Steam  = валовая × ' + (inp.tieredCut ? '30%/25%/20% (пороговая)' : inp.steamCut + '%'));
    L.push('  налог США       = (валовая − Steam) × ' + inp.usWithholding + '%');
    L.push('  издатель        = (… − Steam − налог США) × ' + inp.publisher + '%');
    L.push('  налоги (РФ)     = (… − издатель) × ' + inp.tax + '%');
    L.push('  вывод/конвертация = (… − налоги) × ' + inp.withdrawalFee + '%');
    L.push('  возвраты        = (… − вывод) × ' + inp.refund + '%');
    L.push('  доход разработчика = валовая − все вычеты');
  }
  L.push('');
  L.push('Использованные значения для расчёта:');
  if (inp.reviews != null) {
    L.push('  отзывы      = ' + fmtInt(inp.reviews));
    L.push('  ratio       = ' + inp.ratioMin + ' / ' + inp.ratioMode + ' / ' + inp.ratioMax + '  (мин / вероятно / макс)');
  }
  if (inp.owners != null) L.push('  владельцы   = ' + fmtInt(inp.owners) + ' (задано вручную)');
  if (inp.gross != null) L.push('  валовая     = ' + money(inp.gross) + ' (задано вручную)');
  if (inp.gross == null && inp.owners == null) {
    L.push('  цена        = ' + (inp.price != null ? money(inp.price) : 'не задана'));
    L.push('  скидки      = ' + (discount.fromAsp ? 'по ASP: ' + money(inp.asp) + ' → доля ' + (discount.mode * 100).toFixed(1) + '%'
      : (discount.min * 100).toFixed(0) + '% / ' + (discount.mode * 100).toFixed(0) + '% / ' + (discount.max * 100).toFixed(0) + '%'));
  }
  if (showNet) {
    L.push('  Steam       = ' + inp.steamCut + '%' + (inp.tieredCut ? ' (с понижением 25%/20%)' : ''));
    L.push('  издатель    = ' + inp.publisher + '%');
    L.push('  налоговый режим = ' + (TAX_PRESETS[inp.taxMode] ? TAX_PRESETS[inp.taxMode].label : 'свой'));
    L.push('  налог США   = ' + inp.usWithholding + '%');
    L.push('  налоги (РФ) = ' + inp.tax + '%');
    L.push('  вывод/конв. = ' + inp.withdrawalFee + '%');
    L.push('  возвраты    = ' + inp.refund + '%');
  }
  L.push('');
  L.push('Разброс: пессимистично = min ratio × min скидок, оптимистично = max ratio × max скидок.');
  return L.join('\n');
}

function buildSteps(inp, discount, mid, showOwners, showGross, showNet) {
  const L = [];
  const ownersText = mid.owners != null ? fmtInt(mid.owners) : 'неизвестно';

  if (inp.gross != null) {
    L.push('1. Валовая выручка задана вручную: ' + money(inp.gross));
  } else if (inp.owners != null) {
    L.push('1. Владельцы заданы вручную: ' + fmtInt(inp.owners));
    if (showGross) L.push('2. Валовая = ' + fmtInt(inp.owners) + ' × ' + money(inp.price) + ' × ' + (discount.mode * 100).toFixed(1) + '% = ' + money(mid.gross));
  } else if (inp.reviews != null) {
    L.push('1. Владельцы ≈ ' + fmtInt(inp.reviews) + ' (отзывы) × ' + inp.ratioMode + ' (ratio) = ' + ownersText);
    if (showGross) L.push('2. Валовая ≈ ' + ownersText + ' × ' + money(inp.price) + ' × ' + (discount.mode * 100).toFixed(1) + '% (скидки) = ' + money(mid.gross));
  }

  if (showNet) {
    let n = 3;
    L.push(n + '. Комиссия Steam = ' + money(mid.steamFee) + ' (эффективно ' + (mid.effectiveCut * 100).toFixed(1) + '%)');
    n++;
    L.push(n + '. После Steam = ' + money(mid.netAfterSteam));
    n++;
    if (inp.usWithholding > 0) {
      L.push(n + '. Налог США (withholding ' + inp.usWithholding + '%) = ' + money(mid.usWithholding) + ' → ' + money(mid.netAfterUS));
      n++;
    }
    if (inp.publisher > 0) {
      L.push(n + '. Издатель (' + inp.publisher + '%) = ' + money(mid.publisherTake) + ' → ' + money(mid.netAfterPublisher));
      n++;
    }
    if (inp.tax > 0) {
      L.push(n + '. Налоги (' + inp.tax + '%) = ' + money(mid.taxTake) + ' → ' + money(mid.netAfterTax));
      n++;
    }
    if (inp.withdrawalFee > 0) {
      L.push(n + '. Вывод/конвертация (' + inp.withdrawalFee + '%) = ' + money(mid.withdrawalFee) + ' → ' + money(mid.netAfterWithdrawal));
      n++;
    }
    L.push(n + '. Возвраты (' + inp.refund + '%) = ' + money(mid.refundTake));
    L.push('');
    L.push('Итог (наиболее вероятный доход разработчика): ' + money(mid.devRevenue));
  } else {
    L.push('');
    L.push('Для оценки выручки укажите цену (и/или ASP), либо валовую выручку напрямую.');
  }
  return L.join('\n');
}

// ---------- URL mode ----------
function extractAppId(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^\d+$/.test(s)) return s;
  try {
    const u = new URL(s);
    const m = u.pathname.match(/\/(?:app|agecheck\/app)\/(\d+)/i);
    if (m) return m[1];
  } catch (e) {
    const m = s.match(/app\/(\d+)/i);
    if (m) return m[1];
  }
  return null;
}

async function fetchSteamViaProxy(appid) {
  const proxy = 'https://corsproxy.io/?';
  const [dr, rr] = await Promise.all([
    fetch(proxy + encodeURIComponent('https://store.steampowered.com/api/appdetails?appids=' + appid + '&cc=us&l=english&filters=basic,price_overview,release_date,genres'), { signal: AbortSignal.timeout(30000) }),
    fetch(proxy + encodeURIComponent('https://store.steampowered.com/appreviews/' + appid + '?json=1&filter=all&language=all&num_per_page=0&purchase_type=all'), { signal: AbortSignal.timeout(30000) }),
  ]);
  const details = await dr.json();
  const reviews = await rr.json();
  const entry = details && details[appid];
  if (!entry || !entry.success) {
    return { ok: false, error: 'Игра с таким App ID не найдена в Steam.' };
  }
  const d = entry.data;
  const po = d.price_overview || null;
  const qs = reviews && reviews.query_summary ? reviews.query_summary : null;
  return {
    ok: true,
    appid,
    name: d.name || null,
    type: d.type || null,
    isFree: !!d.is_free,
    price: po ? { currency: po.currency, initial: po.initial, final: po.final, discountPercent: po.discount_percent || 0 } : null,
    releaseDate: d.release_date ? d.release_date.date : null,
    comingSoon: !!(d.release_date && d.release_date.coming_soon),
    headerImage: d.header_image || null,
    genres: (d.genres || []).map(g => g.description),
    reviews: qs ? { total: qs.total_reviews, positive: qs.total_positive, negative: qs.total_negative, score: qs.review_score, scoreDesc: qs.review_score_desc } : null,
  };
}

async function fetchApp() {
  const url = $('url-input').value.trim();
  const status = $('url-status');
  status.className = 'status';
  if (!url) { status.className = 'status error'; status.textContent = 'Введите ссылку или App ID.'; return; }

  const appid = extractAppId(url);
  if (!appid) { status.className = 'status error'; status.textContent = 'Не удалось определить App ID из ссылки.'; return; }

  status.textContent = 'Загружаю данные Steam…';
  let data = null;
  let usingProxy = false;

  if (API_BASE) {
    try {
      const res = await fetch(API_BASE + '/api/app?appid=' + appid, { signal: AbortSignal.timeout(20000) });
      data = await res.json();
    } catch (e) { /* fallback below */ }
  }

  if (!data) {
    try {
      status.textContent = 'Загружаю через прокси…';
      data = await fetchSteamViaProxy(appid);
      usingProxy = true;
    } catch (e) {
      data = { ok: false, error: 'Не удалось загрузить данные. Проверьте App ID или интернет.' };
    }
  }

  if (!data.ok) { status.className = 'status error'; status.textContent = data.error; if (usingProxy) status.textContent += ' (через CORS-прокси)'; return; }

  status.className = 'status ok';
  status.textContent = 'Данные загружены: ' + data.name + (usingProxy ? ' (через CORS-прокси)' : '');

  const meta = $('fetched-meta');
  meta.classList.remove('hidden');
  const tags = [];
  if (data.type) tags.push(data.type);
  if (data.releaseDate) tags.push('релиз: ' + data.releaseDate);
  if (data.genres && data.genres.length) tags.push(data.genres.join(', '));
  if (data.isFree) tags.push('Free to Play');
  if (data.price && !data.isFree && data.price.discountPercent > 0) {
    tags.push('сейчас −' + data.price.discountPercent + '%, расчёт по базовой цене');
  }
  if (usingProxy) tags.push('загружено через CORS-прокси');
  meta.innerHTML = (data.headerImage ? '<img src="' + data.headerImage + '" class="game-img" alt="" />' : '') + '<strong>' + (data.name || 'Игра') + '</strong> <span class="tags">(' + tags.join(' · ') + ')</span>';

  if (data.reviews) $('reviews').value = data.reviews.total;
  if (data.price && !data.isFree) $('price').value = (data.price.initial / 100).toFixed(2);
  else if (data.isFree) $('price').value = '';
  if (data.releaseDate) {
    const m = data.releaseDate.match(/(\d{4})/);
    if (m) $('year').value = m[1];
  }
  applyRatioSuggestion();
  onCalculate();
  $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function applyRatioSuggestion() {
  const r = suggestRatio(num('year'), num('price'));
  $('ratioMin').value = r.min;
  $('ratioMode').value = r.mode;
  $('ratioMax').value = r.max;
}

// ---------- manual mode ----------
function onCalculate() {
  const inp = collectInputs();
  const result = calculate(inp);
  render(result);
}

function onTaxModeChange() {
  const mode = $('taxMode').value;
  const p = TAX_PRESETS[mode];
  if (p && p.tax != null) {
    $('tax').value = p.tax;
    $('tax').disabled = true;
  } else {
    $('tax').disabled = false;
  }
  if (mode && mode !== 'custom') {
    $('withdrawalFee').value = p.fee;
    $('usWithholding').value = p.us;
  }
}

function onClear() {
  ['reviews', 'price', 'year', 'asp', 'owners', 'gross', 'url-input'].forEach(id => $(id).value = '');
  ['steamCut', 'publisher', 'tax', 'refund'].forEach(id => $(id).value = '');
  $('steamCut').value = 30;
  $('publisher').value = 0;
  $('tax').value = 0;
  $('refund').value = 5;
  $('taxMode').value = 'ru_ip6';
  $('withdrawalFee').value = 0;
  $('usWithholding').value = 0;
  $('tieredCut').checked = true;
  $('discountMin').value = 0.4;
  $('discountMode').value = 0.6;
  $('discountMax').value = 0.9;
  $('url-status').textContent = '';
  $('url-status').className = 'status';
  $('fetched-meta').classList.add('hidden');
  $('results').classList.add('hidden');
  onTaxModeChange();
  applyRatioSuggestion();
}

// ---------- init ----------
function init() {
  $('tab-link').addEventListener('click', () => switchTab('link'));
  $('tab-manual').addEventListener('click', () => switchTab('manual'));
  $('fetch-btn').addEventListener('click', fetchApp);
  $('url-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') fetchApp(); });
  $('ratio-suggest').addEventListener('click', applyRatioSuggestion);
  $('calc-btn').addEventListener('click', onCalculate);
  $('clear-btn').addEventListener('click', onClear);
  $('taxMode').addEventListener('change', onTaxModeChange);

  onClear();
  switchTab('link');
}

function switchTab(mode) {
  const link = mode === 'link';
  $('tab-link').classList.toggle('active', link);
  $('tab-manual').classList.toggle('active', !link);
  $('tab-link').setAttribute('aria-selected', link);
  $('tab-manual').setAttribute('aria-selected', !link);
  $('panel-link').classList.toggle('active', link);
  $('panel-manual').classList.toggle('active', !link);
}

init();

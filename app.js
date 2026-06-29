/* =====================================================
   TradeWatch — app.js
   Tickers  : AAOI, MRVL, MU, MSFT
   Prices   : Yahoo Finance v8 (CORS proxy)
   Charts   : 5-min candles, canvas line chart
   Sentiment: Linear regression + momentum + session avg
   Refresh  : 25 seconds with visual countdown ring
====================================================== */

// ── Config ────────────────────────────────────────────
const REFRESH_SEC = 25;
const TICKERS = [
  { symbol: 'AAOI',  exchange: 'NASDAQ', name: 'Applied Optoelectronics' },
  { symbol: 'MRVL',  exchange: 'NASDAQ', name: 'Marvell Technology' },
  { symbol: 'MU',    exchange: 'NASDAQ', name: 'Micron Technology' },
  { symbol: 'MSFT',  exchange: 'NASDAQ', name: 'Microsoft' },
];

const PROXIES = [
  s => `https://api.allorigins.win/get?url=${encodeURIComponent(s)}`,
  s => `https://corsproxy.io/?${encodeURIComponent(s)}`,
];

// ── State ─────────────────────────────────────────────
let eurUsdRate  = null;
let countdown   = REFRESH_SEC;
let timerHandle = null;
const chartData = {}; // symbol → array of close prices

// ── DOM ───────────────────────────────────────────────
const statusDot     = document.getElementById('statusDot');
const statusText    = document.getElementById('statusText');
const countdownNum  = document.getElementById('countdownNum');
const ringProgress  = document.getElementById('ringProgress');
const eurUsdDisplay = document.getElementById('eurUsdDisplay');
const rateUpdated   = document.getElementById('rateUpdated');
const eurInput      = document.getElementById('eurInput');
const usdInput      = document.getElementById('usdInput');
const usdResult     = document.getElementById('usdResult');
const eurResult     = document.getElementById('eurResult');

// ── Helpers ───────────────────────────────────────────
const fmt    = (n, d = 2) => n == null || isNaN(n) ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const timeNow = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function setStatus(cls, txt) {
  statusDot.className  = 'status-dot ' + cls;
  statusText.textContent = txt;
}

// ── Theme ─────────────────────────────────────────────
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  document.getElementById('themeIcon').textContent = t === 'dark' ? '☀' : '☾';
  document.getElementById('themeColor').content = t === 'dark' ? '#050810' : '#f0f4ff';
  localStorage.setItem('tw-theme', t);
  // Redraw all charts with new colours
  TICKERS.forEach(tk => { if (chartData[tk.symbol]?.length) drawChart(tk.symbol, chartData[tk.symbol]); });
}
window.toggleTheme = () => applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
applyTheme(localStorage.getItem('tw-theme') || 'dark');

// ── Countdown ring ────────────────────────────────────
const CIRCUMFERENCE = 2 * Math.PI * 11; // r=11

function updateRing(secs) {
  const fraction = secs / REFRESH_SEC;
  const offset   = CIRCUMFERENCE * (1 - fraction);
  ringProgress.style.strokeDashoffset = offset;
  // Colour: green when plenty of time, amber when almost due
  ringProgress.style.stroke = fraction > 0.3
    ? 'var(--accent)'
    : 'var(--yellow)';
  countdownNum.textContent = secs;
}

function startCountdown() {
  clearInterval(timerHandle);
  countdown = REFRESH_SEC;
  updateRing(countdown);
  timerHandle = setInterval(() => {
    countdown--;
    if (countdown <= 0) {
      countdown = REFRESH_SEC;
      refreshAll();
    }
    updateRing(countdown);
  }, 1000);
}

// ── Yahoo Finance fetch ───────────────────────────────
async function fetchYahoo(symbol) {
  // v8 chart with 5min interval, 1 day range, include pre/post
  const target = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=5m&range=1d&includePrePost=true`;
  for (const makeProxy of PROXIES) {
    try {
      const res  = await fetch(makeProxy(target), { signal: AbortSignal.timeout(12000) });
      if (!res.ok) continue;
      const text = await res.text();
      let payload;
      try {
        const outer = JSON.parse(text);
        payload = typeof outer.contents === 'string' ? JSON.parse(outer.contents) : outer;
      } catch { payload = JSON.parse(text); }
      const result = payload?.chart?.result?.[0];
      if (!result) continue;
      return result;
    } catch { /* try next */ }
  }
  throw new Error('All proxies failed');
}

// ── Price extraction ──────────────────────────────────
function extractPrice(result) {
  const meta      = result.meta;
  if (!meta) throw new Error('No meta');
  const mktState  = (meta.marketState || '').toUpperCase();
  const regPrice  = meta.regularMarketPrice;
  const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? regPrice;
  let price, stateLabel, isExtended = false;

  if ((mktState === 'PRE' || mktState === 'PREPRE') && meta.preMarketPrice) {
    price = meta.preMarketPrice; stateLabel = '⬡ PRE-MARKET'; isExtended = true;
  } else if ((mktState === 'POST' || mktState === 'POSTPOST') && meta.postMarketPrice) {
    price = meta.postMarketPrice; stateLabel = '⬡ AFTER-HRS'; isExtended = true;
  } else if (mktState === 'CLOSED') {
    price = regPrice; stateLabel = 'CLOSED';
  } else {
    price = regPrice; stateLabel = '';
  }

  if (price == null || isNaN(price)) throw new Error('No valid price');
  const change    = price - prevClose;
  const changePct = prevClose ? (change / prevClose) * 100 : 0;
  return { price, change, changePct, stateLabel, isExtended, regPrice, prevClose };
}

// ── 5-min candle extraction ───────────────────────────
function extractCandles(result) {
  const closes    = result.indicators?.quote?.[0]?.close;
  const timestamps = result.timestamp;
  if (!closes || !timestamps) return [];

  const pairs = timestamps.map((t, i) => ({ t, c: closes[i] }))
    .filter(p => p.c != null && !isNaN(p.c));
  return pairs.map(p => p.c);
}

// ── Sentiment analysis ────────────────────────────────
function analyseSentiment(closes) {
  if (!closes || closes.length < 4) return { label: '—', cls: 'neutral', line: 'Not enough data' };

  const n     = closes.length;
  const last8 = closes.slice(-8);  // ~40 min window
  const last3 = closes.slice(-3);

  // 1. Linear regression slope on last 8 candles
  const xMean = (last8.length - 1) / 2;
  const yMean = last8.reduce((a, b) => a + b, 0) / last8.length;
  let num = 0, den = 0;
  last8.forEach((y, x) => { num += (x - xMean) * (y - yMean); den += (x - xMean) ** 2; });
  const slope = den ? num / den : 0;
  const slopePct = yMean ? (slope / yMean) * 100 : 0; // slope as % of price

  // 2. Session average
  const sessionAvg = closes.reduce((a, b) => a + b, 0) / n;
  const lastPrice  = closes[n - 1];
  const aboveAvg   = lastPrice > sessionAvg;

  // 3. Momentum — compare first half vs second half avg
  const half      = Math.floor(n / 2);
  const firstHalf = closes.slice(0, half).reduce((a, b) => a + b, 0) / half;
  const secHalf   = closes.slice(half).reduce((a, b) => a + b, 0) / (n - half);
  const momentum  = secHalf > firstHalf;

  // 4. Last 3 candles direction
  const last3Up   = last3.every((v, i) => i === 0 || v >= last3[i - 1]);
  const last3Down = last3.every((v, i) => i === 0 || v <= last3[i - 1]);

  // 5. Breakout: slope very steep (>0.15% per candle)
  const isBreakout = Math.abs(slopePct) > 0.15;

  // Score
  let score = 0;
  if (slopePct > 0)  score++; else score--;
  if (aboveAvg)      score++; else score--;
  if (momentum)      score++; else score--;
  if (last3Up)       score++; else if (last3Down) score--;

  // Verdict
  let label, cls;
  if (isBreakout && slopePct > 0)  { label = '⚡ BREAKOUT ↑'; cls = 'breakout'; }
  else if (isBreakout)              { label = '⚡ BREAKOUT ↓'; cls = 'bearish'; }
  else if (score >= 3)              { label = '🟢 BULLISH';    cls = 'bullish'; }
  else if (score <= -2)             { label = '🔴 BEARISH';    cls = 'bearish'; }
  else                              { label = '🟡 NEUTRAL';    cls = 'neutral'; }

  // One-liner detail
  const greenCount = last8.filter((v, i) => i > 0 && v >= last8[i - 1]).length;
  const avgLabel   = aboveAvg ? 'above session avg' : 'below session avg';
  const momLabel   = momentum ? 'momentum building' : 'momentum fading';
  const line       = `${greenCount} of last ${last8.length} candles up · ${avgLabel} · ${momLabel}`;

  return { label, cls, line };
}

// ── Canvas chart ──────────────────────────────────────
function drawChart(symbol, closes) {
  const canvas  = document.getElementById(`chart-${symbol}`);
  const emptyEl = document.getElementById(`empty-${symbol}`);
  if (!canvas) return;

  if (!closes || closes.length < 2) {
    emptyEl.style.display = 'flex';
    return;
  }
  emptyEl.style.display = 'none';

  // HiDPI
  const dpr  = window.devicePixelRatio || 1;
  const rect  = canvas.getBoundingClientRect();
  const W     = rect.width  || canvas.parentElement.clientWidth;
  const H     = rect.height || 90;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const isDark  = document.documentElement.getAttribute('data-theme') !== 'light';
  const min     = Math.min(...closes);
  const max     = Math.max(...closes);
  const range   = max - min || 1;
  const pad     = { t: 6, b: 6, l: 4, r: 4 };
  const iw      = W - pad.l - pad.r;
  const ih      = H - pad.t - pad.b;

  const toX = i => pad.l + (i / (closes.length - 1)) * iw;
  const toY = v => pad.t + ih - ((v - min) / range) * ih;

  const trend   = closes[closes.length - 1] >= closes[0];
  const lineClr = trend
    ? (isDark ? '#06d6a0' : '#059669')
    : (isDark ? '#f72585' : '#e11d48');
  const fillClr = trend
    ? (isDark ? 'rgba(6,214,160,0.09)' : 'rgba(5,150,105,0.08)')
    : (isDark ? 'rgba(247,37,133,0.09)' : 'rgba(225,29,72,0.08)');

  // Subtle grid lines
  const gridClr = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.05)';
  ctx.strokeStyle = gridClr;
  ctx.lineWidth   = 0.5;
  [0.25, 0.5, 0.75].forEach(f => {
    const y = pad.t + ih * f;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
  });

  // Fill
  ctx.beginPath();
  ctx.moveTo(toX(0), toY(closes[0]));
  closes.forEach((v, i) => { if (i > 0) ctx.lineTo(toX(i), toY(v)); });
  ctx.lineTo(toX(closes.length - 1), H - pad.b);
  ctx.lineTo(toX(0), H - pad.b);
  ctx.closePath();
  ctx.fillStyle = fillClr;
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.moveTo(toX(0), toY(closes[0]));
  closes.forEach((v, i) => { if (i > 0) ctx.lineTo(toX(i), toY(v)); });
  ctx.strokeStyle = lineClr;
  ctx.lineWidth   = 1.8;
  ctx.lineJoin    = 'round';
  ctx.stroke();

  // Last price dot
  const lx = toX(closes.length - 1);
  const ly = toY(closes[closes.length - 1]);
  ctx.beginPath();
  ctx.arc(lx, ly, 3, 0, Math.PI * 2);
  ctx.fillStyle = lineClr;
  ctx.fill();

  // Min / max labels
  const labelClr = isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)';
  ctx.fillStyle  = labelClr;
  ctx.font       = `${9 * dpr / dpr}px JetBrains Mono, monospace`;
  ctx.textAlign  = 'left';
  ctx.fillText(`$${fmt(max)}`, pad.l + 2, pad.t + 9);
  ctx.fillText(`$${fmt(min)}`, pad.l + 2, H - pad.b - 3);
}

// ── Update card UI ────────────────────────────────────
function updateCard(symbol, priceData, closes) {
  const card      = document.querySelector(`.ticker-card[data-symbol="${symbol}"]`);
  if (!card) return;

  const priceEl   = card.querySelector('.ticker-price');
  const eurEl     = card.querySelector('.ticker-eur');
  const changeEl  = card.querySelector('.ticker-change');
  const stateEl   = card.querySelector('.ticker-state');
  const sentBadge = document.getElementById(`sent-${symbol}`);
  const sentLine  = document.getElementById(`sentline-${symbol}`);

  if (!priceData) {
    priceEl.textContent  = 'N/A';
    eurEl.textContent    = '';
    changeEl.textContent = 'Error';
    changeEl.className   = 'ticker-change neutral';
    stateEl.textContent  = '';
    card.className       = 'ticker-card';
    return;
  }

  const { price, change, changePct, stateLabel, isExtended, regPrice } = priceData;
  const dir = change >= 0 ? 'up' : 'down';

  // Price
  priceEl.textContent = `$${fmt(price)}`;
  priceEl.classList.remove('flash');
  void priceEl.offsetWidth;
  priceEl.classList.add('flash');

  // EUR equivalent
  const eur = eurUsdRate ? price / eurUsdRate : null;
  eurEl.textContent = eur ? `€${fmt(eur)}` : '';

  // Change
  const sign = change >= 0 ? '+' : '';
  changeEl.textContent = `${sign}${fmt(change)} (${sign}${fmt(changePct)}%)`;
  changeEl.className   = `ticker-change ${dir}`;

  // State
  if (isExtended && regPrice && regPrice !== price) {
    stateEl.textContent = `${stateLabel} · close $${fmt(regPrice)}`;
  } else {
    stateEl.textContent = stateLabel;
  }

  // Card border colour
  card.className = `ticker-card ${dir}`;

  // Sentiment
  const sent = analyseSentiment(closes);
  sentBadge.textContent = sent.label;
  sentBadge.className   = `sentiment-badge ${sent.cls}`;
  sentLine.textContent  = sent.line;

  // Chart
  drawChart(symbol, closes);
}

// ── Main fetch ────────────────────────────────────────
async function fetchTicker(symbol) {
  const result  = await fetchYahoo(symbol);
  const price   = extractPrice(result);
  const closes  = extractCandles(result);
  chartData[symbol] = closes;
  return { symbol, price, closes };
}

async function refreshAll() {
  setStatus('', 'Fetching…');

  // Fetch rate and tickers in parallel
  const [rateOk, ...tickerResults] = await Promise.all([
    fetchEurUsd(),
    ...TICKERS.map(t => fetchTicker(t.symbol).catch(e => ({ symbol: t.symbol, error: e.message }))),
  ]);

  let anyOk = false;
  tickerResults.forEach(r => {
    if (r.error) {
      updateCard(r.symbol, null, []);
    } else {
      updateCard(r.symbol, r.price, r.closes);
      anyOk = true;
    }
  });

  // Refresh converter if rate updated
  const ev = parseFloat(eurInput.value);
  if (ev && eurUsdRate) usdResult.textContent = `$${fmt(ev * eurUsdRate)}`;
  const uv = parseFloat(usdInput.value);
  if (uv && eurUsdRate) eurResult.textContent = `€${fmt(uv / eurUsdRate)}`;

  setStatus(
    anyOk ? 'live' : 'error',
    anyOk ? 'Live' : 'Failed'
  );

  startCountdown();
}

// ── Currency ──────────────────────────────────────────
async function fetchEurUsd() {
  try {
    const r = await fetch('https://api.exchangerate-api.com/v4/latest/EUR', { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error();
    const d = await r.json();
    eurUsdRate = d.rates.USD;
    eurUsdDisplay.textContent = fmt(eurUsdRate, 4);
    rateUpdated.textContent   = timeNow();
    return true;
  } catch {}
  try {
    const r = await fetch('https://api.frankfurter.app/latest?from=EUR&to=USD', { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error();
    const d = await r.json();
    eurUsdRate = d.rates.USD;
    eurUsdDisplay.textContent = fmt(eurUsdRate, 4);
    rateUpdated.textContent   = timeNow() + ' ↩';
    return true;
  } catch {
    eurUsdDisplay.textContent = 'Error';
    return false;
  }
}

eurInput.addEventListener('input', () => {
  const v = parseFloat(eurInput.value);
  usdResult.textContent = (!v && v !== 0) ? '$0.00' : eurUsdRate ? `$${fmt(v * eurUsdRate)}` : '—';
});
usdInput.addEventListener('input', () => {
  const v = parseFloat(usdInput.value);
  eurResult.textContent = (!v && v !== 0) ? '€0.00' : eurUsdRate ? `€${fmt(v / eurUsdRate)}` : '—';
});

// ── Redraw charts on resize ───────────────────────────
window.addEventListener('resize', () => {
  TICKERS.forEach(t => { if (chartData[t.symbol]?.length) drawChart(t.symbol, chartData[t.symbol]); });
});

// ── PWA Install ───────────────────────────────────────
let deferredPrompt = null;
const installBanner = document.getElementById('installBanner');
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredPrompt = e; installBanner?.classList.add('show'); });
window.installApp   = () => { if (!deferredPrompt) return; deferredPrompt.prompt(); deferredPrompt.userChoice.then(() => { deferredPrompt = null; installBanner?.classList.remove('show'); }); };
window.dismissInstall = () => installBanner?.classList.remove('show');

// ── Service Worker ────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

// ── Init ──────────────────────────────────────────────
(async () => {
  setStatus('', 'Loading…');
  await refreshAll();
})();

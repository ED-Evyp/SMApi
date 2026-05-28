/* ===================================================
   MarketPulse — app.js
   Currency: exchangerate.host (free, no key)
   Stocks:    Yahoo Finance query (CORS proxy)
=================================================== */

// ── State ──────────────────────────────────────────
let eurUsdRate = null;
let lastRateFetch = null;
let lastStockFetch = null;

const TICKERS = [
  { symbol: 'AXTI',  exchange: 'NASDAQ', name: 'AXT Inc.' },
  { symbol: 'LITE',  exchange: 'NASDAQ', name: 'Lumentum Holdings' },
  { symbol: 'AAOI',  exchange: 'NASDAQ', name: 'Applied Optoelectronics' },
  { symbol: 'COHR',  exchange: 'NYSE',   name: 'Coherent Corp.' },
];

// ── DOM refs ────────────────────────────────────────
const eurInput     = document.getElementById('eurInput');
const usdInput     = document.getElementById('usdInput');
const usdResult    = document.getElementById('usdResult');
const eurResult    = document.getElementById('eurResult');
const eurUsdDisplay= document.getElementById('eurUsdDisplay');
const rateUpdated  = document.getElementById('rateUpdated');
const stocksUpdated= document.getElementById('stocksUpdated');
const statusDot    = document.getElementById('statusDot');
const statusText   = document.getElementById('statusText');
const refreshBtn   = document.getElementById('refreshBtn');

// ── Helpers ─────────────────────────────────────────
function fmt(n, decimals = 2) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return Number(n).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function timeNow() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function setStatus(state, text) {
  statusDot.className = 'status-dot ' + state;
  statusText.textContent = text;
}

// ── Currency ─────────────────────────────────────────
async function fetchEurUsd() {
  try {
    // Primary: exchangerate-api (free tier, no key needed for this endpoint)
    const res = await fetch(
      'https://api.exchangerate-api.com/v4/latest/EUR',
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) throw new Error('API error');
    const data = await res.json();
    eurUsdRate = data.rates.USD;
    lastRateFetch = timeNow();
    eurUsdDisplay.textContent = fmt(eurUsdRate, 4);
    rateUpdated.textContent = lastRateFetch;
    eurUsdDisplay.style.animation = 'none';
    void eurUsdDisplay.offsetWidth;
    return true;
  } catch {
    // Fallback: frankfurter.app
    try {
      const res2 = await fetch(
        'https://api.frankfurter.app/latest?from=EUR&to=USD',
        { signal: AbortSignal.timeout(8000) }
      );
      if (!res2.ok) throw new Error();
      const data2 = await res2.json();
      eurUsdRate = data2.rates.USD;
      lastRateFetch = timeNow();
      eurUsdDisplay.textContent = fmt(eurUsdRate, 4);
      rateUpdated.textContent = lastRateFetch + ' (frankfurter)';
      return true;
    } catch {
      eurUsdDisplay.textContent = 'Error';
      return false;
    }
  }
}

function convertEurToUsd(eur) {
  if (!eurUsdRate || isNaN(eur)) return null;
  return eur * eurUsdRate;
}

function convertUsdToEur(usd) {
  if (!eurUsdRate || isNaN(usd)) return null;
  return usd / eurUsdRate;
}

eurInput.addEventListener('input', () => {
  const val = parseFloat(eurInput.value);
  if (!val && val !== 0) { usdResult.textContent = '$0.00'; return; }
  const r = convertEurToUsd(val);
  usdResult.textContent = r !== null ? `$${fmt(r)}` : '—';
});

usdInput.addEventListener('input', () => {
  const val = parseFloat(usdInput.value);
  if (!val && val !== 0) { eurResult.textContent = '€0.00'; return; }
  const r = convertUsdToEur(val);
  eurResult.textContent = r !== null ? `€${fmt(r)}` : '—';
});

// ── Stocks ────────────────────────────────────────────
// Uses Yahoo Finance v7 via allorigins CORS proxy
async function fetchQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`;
  const proxied = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;

  const res = await fetch(proxied, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const outer = await res.json();
  const data = JSON.parse(outer.contents);

  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error('No meta');

  const price  = meta.regularMarketPrice ?? meta.previousClose;
  const prev   = meta.chartPreviousClose ?? meta.previousClose;
  const change = price - prev;
  const changePct = (change / prev) * 100;

  return { price, change, changePct };
}

function updateTickerCard(symbol, data, error) {
  const card = document.querySelector(`.ticker-card[data-symbol="${symbol}"]`);
  if (!card) return;

  card.classList.remove('skeleton');
  const priceEl  = card.querySelector('.ticker-price');
  const changeEl = card.querySelector('.ticker-change');

  if (error) {
    priceEl.textContent  = 'N/A';
    changeEl.textContent = 'Error';
    changeEl.className   = 'ticker-change neutral';
    return;
  }

  const { price, change, changePct } = data;

  // Flash on update
  priceEl.textContent = `$${fmt(price)}`;
  priceEl.classList.remove('flash');
  void priceEl.offsetWidth;
  priceEl.classList.add('flash');

  const sign = change >= 0 ? '+' : '';
  changeEl.textContent = `${sign}${fmt(change)} (${sign}${fmt(changePct)}%)`;
  changeEl.className = `ticker-change ${change >= 0 ? 'up' : 'down'}`;
}

async function fetchAllStocks() {
  const results = await Promise.allSettled(
    TICKERS.map(t =>
      fetchQuote(t.symbol).then(d => ({ symbol: t.symbol, data: d }))
    )
  );

  let anyOk = false;
  for (const r of results) {
    if (r.status === 'fulfilled') {
      updateTickerCard(r.value.symbol, r.value.data, false);
      anyOk = true;
    } else {
      // Try to extract symbol from rejection if possible
      const sym = TICKERS[results.indexOf(r)]?.symbol;
      if (sym) updateTickerCard(sym, null, true);
    }
  }

  lastStockFetch = timeNow();
  stocksUpdated.textContent = lastStockFetch;
  return anyOk;
}

// ── Refresh all ────────────────────────────────────────
window.refreshAll = async function () {
  refreshBtn.classList.add('loading');
  setStatus('', 'Fetching…');

  const [rateOk, stocksOk] = await Promise.all([fetchEurUsd(), fetchAllStocks()]);

  refreshBtn.classList.remove('loading');

  if (rateOk && stocksOk) {
    setStatus('live', 'Live');
  } else if (rateOk || stocksOk) {
    setStatus('live', 'Partial data');
  } else {
    setStatus('error', 'Failed');
  }

  // Re-calc open converter inputs
  const eurVal = parseFloat(eurInput.value);
  if (eurVal) usdResult.textContent = `$${fmt(convertEurToUsd(eurVal))}`;
  const usdVal = parseFloat(usdInput.value);
  if (usdVal) eurResult.textContent = `€${fmt(convertUsdToEur(usdVal))}`;
};

// ── PWA Install ────────────────────────────────────────
let deferredPrompt = null;
const installBanner = document.getElementById('installBanner');

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredPrompt = e;
  if (installBanner) {
    installBanner.classList.add('show');
  }
});

function installApp() {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  deferredPrompt.userChoice.then(() => {
    deferredPrompt = null;
    if (installBanner) installBanner.classList.remove('show');
  });
}

function dismissInstall() {
  if (installBanner) installBanner.classList.remove('show');
}

// ── Service Worker ────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// ── Init ─────────────────────────────────────────────
(async () => {
  setStatus('', 'Loading…');
  await refreshAll();
  // Auto-refresh every 60 seconds
  setInterval(() => {
    fetchEurUsd().then(() => {
      const ev = parseFloat(eurInput.value);
      if (ev) usdResult.textContent = `$${fmt(convertEurToUsd(ev))}`;
      const uv = parseFloat(usdInput.value);
      if (uv) eurResult.textContent = `€${fmt(convertUsdToEur(uv))}`;
    });
    fetchAllStocks();
  }, 60000);
})();

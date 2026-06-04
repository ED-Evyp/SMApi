/* =====================================================
   MarketPulse — app.js
   Currency : exchangerate-api.com (fallback: frankfurter)
   Stocks   : Yahoo Finance v8 via multiple CORS proxies
              Handles regular, pre-market, and post-market
====================================================== */

// ── State ─────────────────────────────────────────────
let eurUsdRate = null;

const TICKERS = [
  { symbol: 'AXTI', exchange: 'NASDAQ', name: 'AXT Inc.' },
  { symbol: 'LITE', exchange: 'NASDAQ', name: 'Lumentum Holdings' },
  { symbol: 'AAOI', exchange: 'NASDAQ', name: 'Applied Optoelectronics' },
  { symbol: 'COHR', exchange: 'NYSE',   name: 'Coherent Corp.' },
];

// CORS proxies tried in order
const PROXIES = [
  s => `https://api.allorigins.win/get?url=${encodeURIComponent(s)}`,
  s => `https://corsproxy.io/?${encodeURIComponent(s)}`,
];

// ── DOM ───────────────────────────────────────────────
const eurInput      = document.getElementById('eurInput');
const usdInput      = document.getElementById('usdInput');
const usdResult     = document.getElementById('usdResult');
const eurResult     = document.getElementById('eurResult');
const eurUsdDisplay = document.getElementById('eurUsdDisplay');
const rateUpdated   = document.getElementById('rateUpdated');
const stocksUpdated = document.getElementById('stocksUpdated');
const statusDot     = document.getElementById('statusDot');
const statusText    = document.getElementById('statusText');
const refreshBtn    = document.getElementById('refreshBtn');

// ── Helpers ───────────────────────────────────────────
const fmt = (n, d = 2) =>
  (n == null || isNaN(n)) ? '—' :
  Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

const timeNow = () =>
  new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function setStatus(state, text) {
  statusDot.className = 'status-dot ' + state;
  statusText.textContent = text;
}

// ── Theme toggle ──────────────────────────────────────
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('themeIcon').textContent = theme === 'dark' ? '☀' : '☾';
  document.getElementById('themeColor').content = theme === 'dark' ? '#0a0f1e' : '#f0f4ff';
  localStorage.setItem('mp-theme', theme);
}

window.toggleTheme = function () {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  applyTheme(current === 'dark' ? 'light' : 'dark');
};

// Restore saved preference
applyTheme(localStorage.getItem('mp-theme') || 'dark');

// ── Currency ──────────────────────────────────────────
async function fetchEurUsd() {
  // Primary
  try {
    const r = await fetch('https://api.exchangerate-api.com/v4/latest/EUR',
      { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error();
    const d = await r.json();
    eurUsdRate = d.rates.USD;
    eurUsdDisplay.textContent = fmt(eurUsdRate, 4);
    rateUpdated.textContent = timeNow();
    return true;
  } catch {}

  // Fallback
  try {
    const r = await fetch('https://api.frankfurter.app/latest?from=EUR&to=USD',
      { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error();
    const d = await r.json();
    eurUsdRate = d.rates.USD;
    eurUsdDisplay.textContent = fmt(eurUsdRate, 4);
    rateUpdated.textContent = timeNow() + ' ↩';
    return true;
  } catch {
    eurUsdDisplay.textContent = 'Error';
    return false;
  }
}

const toEur  = usd => (eurUsdRate ? usd / eurUsdRate : null);
const toUsd  = eur => (eurUsdRate ? eur * eurUsdRate : null);

eurInput.addEventListener('input', () => {
  const v = parseFloat(eurInput.value);
  usdResult.textContent = (!v && v !== 0) ? '$0.00' : (toUsd(v) !== null ? `$${fmt(toUsd(v))}` : '—');
});
usdInput.addEventListener('input', () => {
  const v = parseFloat(usdInput.value);
  eurResult.textContent = (!v && v !== 0) ? '€0.00' : (toEur(v) !== null ? `€${fmt(toEur(v))}` : '—');
});

// ── Stock fetch ───────────────────────────────────────
/**
 * Fetches a Yahoo Finance chart payload through CORS proxies.
 * Returns raw JSON or throws.
 */
async function fetchYahoo(symbol) {
  // Yahoo v8 chart endpoint — returns both regular and extended-hours prices
  const target = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d&includePrePost=true`;

  for (const makeProxy of PROXIES) {
    try {
      const url = makeProxy(target);
      const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (!res.ok) continue;

      let payload;
      const text = await res.text();

      // allorigins wraps in { contents: "..." }
      try {
        const outer = JSON.parse(text);
        payload = typeof outer.contents === 'string' ? JSON.parse(outer.contents) : outer;
      } catch {
        payload = JSON.parse(text);
      }

      const result = payload?.chart?.result?.[0];
      if (!result) continue;
      return result;
    } catch {
      // try next proxy
    }
  }
  throw new Error('All proxies failed');
}

/**
 * Extracts the best available price and change from a Yahoo chart result.
 *
 * Yahoo marketState values:
 *   PRE      = pre-market (4:00-9:30 AM ET)
 *   PREPRE   = very early pre-market (before 4 AM ET)
 *   REGULAR  = normal market hours (9:30 AM-4:00 PM ET)
 *   POST     = after-hours (4:00-8:00 PM ET)
 *   POSTPOST = late after-hours
 *   CLOSED   = market closed
 *
 * Change is always vs previous regular close for consistency.
 */
function extractPrice(result) {
  const meta = result.meta;
  if (!meta) throw new Error('No meta');

  const mktState     = (meta.marketState || '').toUpperCase();
  const regularPrice = meta.regularMarketPrice;
  const prevClose    = meta.chartPreviousClose ?? meta.previousClose ?? regularPrice;

  let price, stateLabel, isExtended = false;

  if ((mktState === 'PRE' || mktState === 'PREPRE') && meta.preMarketPrice) {
    price      = meta.preMarketPrice;
    stateLabel = '⬡ PRE-MARKET';
    isExtended = true;
  } else if ((mktState === 'POST' || mktState === 'POSTPOST') && meta.postMarketPrice) {
    price      = meta.postMarketPrice;
    stateLabel = '⬡ AFTER-HOURS';
    isExtended = true;
  } else if (mktState === 'CLOSED') {
    price      = regularPrice;
    stateLabel = 'CLOSED';
  } else {
    price      = regularPrice;
    stateLabel = '';
  }

  if (price == null || isNaN(price)) throw new Error('No valid price');

  const change    = price - prevClose;
  const changePct = prevClose ? (change / prevClose) * 100 : 0;

  return { price, change, changePct, stateLabel, isExtended, regularPrice, prevClose };
}

function updateCard(symbol, data, error) {
  const card = document.querySelector(`.ticker-card[data-symbol="${symbol}"]`);
  if (!card) return;
  card.classList.remove('skeleton');

  const priceUsdEl  = card.querySelector('.ticker-price-usd');
  const priceEurEl  = card.querySelector('.ticker-price-eur');
  const changeEl    = card.querySelector('.ticker-change');
  const stateEl     = card.querySelector('.ticker-market-state');

  if (error) {
    priceUsdEl.textContent = 'N/A';
    priceEurEl.textContent = '';
    changeEl.textContent   = String(error).replace('Error: ', '');
    changeEl.className     = 'ticker-change neutral';
    stateEl.textContent    = '';
    return;
  }

  const { price, change, changePct, stateLabel, isExtended, regularPrice } = data;

  // USD price with flash
  priceUsdEl.textContent = `$${fmt(price)}`;
  priceUsdEl.classList.remove('flash');
  void priceUsdEl.offsetWidth;
  priceUsdEl.classList.add('flash');

  // EUR price — always show extended-hours price in EUR too
  const eur = toEur(price);
  priceEurEl.textContent = eur !== null ? `€${fmt(eur)}` : '';

  // Change vs prev close (consistent for all sessions)
  const sign = change >= 0 ? '+' : '';
  changeEl.textContent = `${sign}${fmt(change)} (${sign}${fmt(changePct)}%)`;
  changeEl.className   = `ticker-change ${change >= 0 ? 'up' : 'down'}`;

  // Market state label — during extended hours also show last regular close
  if (isExtended && regularPrice && regularPrice !== price) {
    stateEl.textContent = `${stateLabel}  ·  close $${fmt(regularPrice)}`;
  } else {
    stateEl.textContent = stateLabel;
  }
}

async function fetchAllStocks() {
  const settled = await Promise.allSettled(
    TICKERS.map(async t => {
      const result = await fetchYahoo(t.symbol);
      return { symbol: t.symbol, data: extractPrice(result) };
    })
  );

  let anyOk = false;
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      updateCard(r.value.symbol, r.value.data, null);
      anyOk = true;
    } else {
      updateCard(TICKERS[i].symbol, null, r.reason?.message || 'Fetch failed');
    }
  });

  stocksUpdated.textContent = timeNow();
  return anyOk;
}

// ── Refresh all ───────────────────────────────────────
window.refreshAll = async function () {
  refreshBtn.classList.add('loading');
  setStatus('', 'Fetching…');

  const [rateOk, stocksOk] = await Promise.all([fetchEurUsd(), fetchAllStocks()]);

  refreshBtn.classList.remove('loading');
  setStatus(
    rateOk || stocksOk ? 'live' : 'error',
    rateOk && stocksOk ? 'Live' : rateOk || stocksOk ? 'Partial' : 'Failed'
  );

  // Recalculate open converter fields now that rate may have updated
  const ev = parseFloat(eurInput.value);
  if (ev) usdResult.textContent = toUsd(ev) !== null ? `$${fmt(toUsd(ev))}` : '—';
  const uv = parseFloat(usdInput.value);
  if (uv) eurResult.textContent = toEur(uv) !== null ? `€${fmt(toEur(uv))}` : '—';

  // Also refresh EUR prices on ticker cards if rate just arrived
  document.querySelectorAll('.ticker-card:not(.skeleton)').forEach(card => {
    const usdText = card.querySelector('.ticker-price-usd')?.textContent || '';
    const usdVal  = parseFloat(usdText.replace('$', '').replace(/,/g, ''));
    if (!isNaN(usdVal)) {
      const eurEl = card.querySelector('.ticker-price-eur');
      const eur = toEur(usdVal);
      if (eurEl && eur !== null) eurEl.textContent = `€${fmt(eur)}`;
    }
  });
};

// ── PWA Install ───────────────────────────────────────
let deferredPrompt = null;
const installBanner = document.getElementById('installBanner');

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredPrompt = e;
  installBanner?.classList.add('show');
});

window.installApp = function () {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  deferredPrompt.userChoice.then(() => {
    deferredPrompt = null;
    installBanner?.classList.remove('show');
  });
};
window.dismissInstall = () => installBanner?.classList.remove('show');

// ── Service Worker ────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

// ── Init ──────────────────────────────────────────────
(async () => {
  setStatus('', 'Loading…');
  await refreshAll();
  // Auto-refresh every 60 s
  setInterval(refreshAll, 60_000);
})();

// ── News ──────────────────────────────────────────────
// Company news: Yahoo Finance search (no key, via CORS proxy)
// Macro news:   NewsAPI.org free tier (requires free API key)
//
// HOW TO GET YOUR FREE NEWSAPI KEY:
//   1. Go to https://newsapi.org/register
//   2. Sign up (free, takes 60 seconds)
//   3. Copy your API key
//   4. Replace 'YOUR_NEWSAPI_KEY_HERE' below with your key
//
const NEWSAPI_KEY = '0647cc5f28b34532a63e8786e8dbe1fa';
const COMPANY_NEWS_REFRESH_MS = 10 * 60 * 1000; // 10 minutes
const MACRO_NEWS_REFRESH_MS    = 30 * 60 * 1000; // 30 minutes — 48 req/day, within free tier

// Yahoo Finance search endpoint for company news
async function fetchCompanyNews(symbol, count = 2) {
  const target = `https://query1.finance.yahoo.com/v1/finance/search?q=${symbol}&newsCount=${count}&quotesCount=0&enableFuzzyQuery=false`;
  for (const makeProxy of PROXIES) {
    try {
      const res = await fetch(makeProxy(target), { signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const text = await res.text();
      let data;
      try {
        const outer = JSON.parse(text);
        data = typeof outer.contents === 'string' ? JSON.parse(outer.contents) : outer;
      } catch { data = JSON.parse(text); }
      const news = data?.news || [];
      return news.slice(0, count).map(n => ({
        title: n.title,
        url: n.link,
        source: n.publisher,
        time: n.providerPublishTime ? new Date(n.providerPublishTime * 1000) : null,
      }));
    } catch { /* try next proxy */ }
  }
  return [];
}

// NewsAPI for macro topics
async function fetchMacroNews(query, count = 1) {
  if (!NEWSAPI_KEY || NEWSAPI_KEY === 'YOUR_NEWSAPI_KEY_HERE') return [];
  try {
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&language=en&sortBy=publishedAt&pageSize=${count}&apiKey=${NEWSAPI_KEY}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.articles || []).slice(0, count).map(a => ({
      title: a.title,
      url: a.url,
      source: a.source?.name,
      time: a.publishedAt ? new Date(a.publishedAt) : null,
    }));
  } catch { return []; }
}

function timeAgo(date) {
  if (!date) return '';
  const mins = Math.floor((Date.now() - date) / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function renderNewsItem(item, tag = '') {
  if (!item) return '';
  const tagHtml = tag ? `<span class="news-tag">${tag}</span>` : '';
  const timeHtml = item.time ? `<span class="news-time">${timeAgo(item.time)}</span>` : '';
  const sourceHtml = item.source ? `<span class="news-source">${item.source}</span>` : '';
  return `
    <a class="news-item" href="${item.url}" target="_blank" rel="noopener noreferrer">
      <div class="news-meta">${tagHtml}${sourceHtml}${timeHtml}</div>
      <div class="news-title">${item.title}</div>
    </a>`;
}

function renderTickerNews(symbol, articles) {
  const container = document.getElementById(`news-${symbol}`);
  if (!container) return;
  if (!articles.length) {
    container.innerHTML = '<div class="news-empty">No recent news</div>';
    return;
  }
  container.innerHTML = articles.map(a => renderNewsItem(a)).join('');
}

function renderMacroNews(defence, fed, tariffs) {
  const container = document.getElementById('news-macro');
  if (!container) return;
  const items = [
    ...defence.map(a => renderNewsItem(a, '🛡 Defence')),
    ...fed.map(a => renderNewsItem(a, '🏦 Fed')),
    ...tariffs.map(a => renderNewsItem(a, '📦 Tariffs')),
  ].filter(Boolean);
  container.innerHTML = items.length
    ? items.join('')
    : '<div class="news-empty">Add your NewsAPI key to see macro headlines</div>';
}

async function fetchAllNews() {
  document.getElementById('newsUpdated').textContent = 'Fetching…';

  // Company news — parallel fetch for all 4 tickers
  const companyResults = await Promise.allSettled(
    TICKERS.map(t => fetchCompanyNews(t.symbol, 2))
  );
  companyResults.forEach((r, i) => {
    renderTickerNews(TICKERS[i].symbol, r.status === 'fulfilled' ? r.value : []);
  });

    document.getElementById('newsUpdated').textContent = timeNow();
}

// Separate macro fetch — single NewsAPI call, split locally
async function fetchAndRenderMacro() {
  // One combined query — 1 API call instead of 3, stays within free tier at 30min refresh
  const combined = await fetchMacroNews(
    'defence war geopolitical OR "Federal Reserve" "interest rates" OR tariffs semiconductor export',
    10 // fetch up to 10, we'll pick the most relevant below
  );

  // Split by keyword matching into categories
  const defence = combined.filter(a =>
    /defence|defense|war|geopolit|military|nato|ukraine|russia|israel|conflict/i.test(a.title)
  ).slice(0, 2);

  const fed = combined.filter(a =>
    /federal reserve|fed |interest rate|fomc|powell|monetary policy/i.test(a.title)
  ).slice(0, 1);

  const tariffs = combined.filter(a =>
    /tariff|trade war|export|sanction|semiconductor|chip ban|restriction/i.test(a.title)
  ).slice(0, 1);

  renderMacroNews(defence, fed, tariffs);
  document.getElementById('macroUpdated').textContent = timeNow();
}

// Init news — company every 10 min, macro every 30 min (1 API call each time)
(async () => {
  await fetchAllNews();
  await fetchAndRenderMacro();
  setInterval(fetchAllNews, COMPANY_NEWS_REFRESH_MS);
  setInterval(fetchAndRenderMacro, MACRO_NEWS_REFRESH_MS);
})();

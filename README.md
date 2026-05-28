# MarketPulse PWA

A lightweight Progressive Web App for live EUR/USD currency conversion and stock price tracking.

## Features

- 🔄 **EUR ↔ USD converter** — real-time exchange rate, updates every 60 seconds
- 📈 **Stock watchlist** — live prices for AXTI, LITE, AAOI, COHR
- 📲 **Installable PWA** — works offline (shell cached), add to home screen
- ⚡ **Auto-refresh** — prices update every 60 seconds automatically

## Tickers

| Symbol | Exchange | Company |
|--------|----------|---------|
| AXTI   | NASDAQ   | AXT Inc. |
| LITE   | NASDAQ   | Lumentum Holdings |
| AAOI   | NASDAQ   | Applied Optoelectronics |
| COHR   | NYSE     | Coherent Corp. |

## Data Sources

- **Currency**: [exchangerate-api.com](https://exchangerate-api.com) (free, no key) with [frankfurter.app](https://frankfurter.app) as fallback
- **Stocks**: Yahoo Finance v8 API via [allorigins.win](https://allorigins.win) CORS proxy

> ⚠️ Stock data is sourced from public Yahoo Finance endpoints and may be delayed 15 minutes. Not financial advice.

## Deploy to GitHub Pages

1. Push all files to a GitHub repo
2. Go to **Settings → Pages**
3. Set source to `main` branch, root `/`
4. Your app will be live at `https://<username>.github.io/<repo>/`

## Files

```
├── index.html      # App shell
├── style.css       # Styles
├── app.js          # Logic (currency + stocks)
├── sw.js           # Service worker (offline support)
├── manifest.json   # PWA manifest
└── icons/
    ├── icon-192.png
    └── icon-512.png
```

## Local Development

Just open `index.html` in a browser, or serve with any static server:

```bash
npx serve .
# or
python3 -m http.server 8080
```

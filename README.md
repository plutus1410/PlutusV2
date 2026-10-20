## PLUTUS — Your AI Stock Analysis Companion

A futuristic, dark-mode dashboard that turns Yahoo Finance data into plain-English, gamified insights. **Facts only — no buy/sell/hold calls.** Fully responsive for desktop, tablet and mobile.

### Dashboard sections (in order)
- **About the Company** — business summary (with Read more), sector, industry, HQ, employees, website
- **Health Scan** — 0–100 score ring, six power stats and a radar chart (each compared with the industry average)
- **Key Numbers** — 12 KPI cards with tap/hover explanations, each with its industry average
- **Trajectory** — price (1Y/5Y), P/E history (with industry-average line), and Yearly/Quarterly business charts
- **Peer Arena** — companies from the **same industry**, medals, head-to-head chart and comparison table with an Industry average row
- **Strengths & Weaknesses** — plain-English facts, including "VS INDUSTRY" items

Search favours Indian listings (NSE, then BSE), marked with an IN tag, and matches on the **company name** (not the ticker).

### What changed in v4
1. Top bar (logo + search) is now fixed to the top of the screen on the stock page.
2. Search ranks results by company name only; ticker is shown as secondary text.
3. Achievements removed from Health Scan.
4. Peers are real industry peers (verified against Yahoo's industry label), chosen closest in size.
5. Company logo beside the name in search suggestions, the stock header and the peer table.
6. Industry average shown for every metric (strip, power stats, KPI cards, radar, P/E and margin charts, peer table).

### Structure
index.html
css/style.css
js/config.js      ← WORKER_URL, LOGO_SOURCES
js/analysis.js    ← metrics, scores, peer ranks, strengths/weaknesses
js/app.js         ← UI, search, logos, industry peers, routing, charts
worker/worker.js  ← Cloudflare Worker (deploy on Cloudflare, not GitHub)

### Deploy
- **Worker (re-deploy — it changed in v4):** Cloudflare → Workers → your worker → Edit code → paste worker/worker.js → Deploy. v4 adds POST support for Yahoo's screener (used to list companies in the same industry). Without the update the site still works, but peer discovery falls back to less complete sources.
- Put the Worker URL in js/config.js (WORKER_URL).
- **GitHub Pages:** upload the folder contents (with index.html at the top level) → Settings → Pages → Deploy from branch main / root.
- _(Recommended)_ Set ALLOWED_ORIGINS = ['https://<user>.github.io'] in the Worker and redeploy.
Run locally: python -m http.server 8080.

### Notes
- Industry average = simple average of up to 6 listed peers in the same industry (closest in size), computed the same way as the company's own figures. EPS is per-share and isn't comparable across companies, so it shows n/a.
- Logos come from the company's website domain via public favicon services (see LOGO_SOURCES in config.js); a dedicated logo API can be added there. If none is found, an initials badge is shown.
- Yahoo's free data covers about 4–5 annual periods and up to 8 quarters. Many Indian companies publish cash flow and balance sheets only half-yearly or yearly, so those quarterly charts may say "No quarterly data published".
- Yahoo's endpoints are unofficial and can change without notice.
- Educational use only. Not investment advice.

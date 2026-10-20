/* ============================================================
   PLUTUS — UI, data fetching, routing, charts
   ============================================================ */
(function () {
  'use strict';

  const CFG = window.APP_CONFIG || {};
  const A = window.Analysis;
  const { fmtMoney, fmtPrice, fmtPct, fmtX, isNum } = A;
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isMobile = () => window.matchMedia('(max-width: 640px)').matches;
  const state = { charts: [], lastHits: {}, model: null, ind: null, peerCmp: null };

  /* ====================== DATA LAYER ====================== */
  const YH = 'https://query2.finance.yahoo.com';
  const YH1 = 'https://query1.finance.yahoo.com';
  const ttl = (CFG.CACHE_MINUTES || 15) * 60e3;
  function cacheGet(k) {
    try { const x = JSON.parse(sessionStorage.getItem(k)); if (x && Date.now() - x.t < ttl) return x.d; } catch (e) { /* ignore */ }
    return null;
  }
  function cacheSet(k, d) { try { sessionStorage.setItem(k, JSON.stringify({ t: Date.now(), d })); } catch (e) { /* quota */ } }
  async function yfetch(url) {
    const key = 'yf:' + url;
    const hit = cacheGet(key); if (hit) return hit;
    const routes = CFG.WORKER_URL
      ? [CFG.WORKER_URL.replace(/\/+$/, '') + '/?url=' + encodeURIComponent(url)]
      : (CFG.PUBLIC_PROXIES || []).map((p) => p + encodeURIComponent(url));
    let lastErr = new Error('No proxy configured');
    for (const r of routes) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), CFG.REQUEST_TIMEOUT_MS || 15000);
        try {
          const res = await fetch(r, { signal: ctrl.signal });
          if (!res.ok) { const er = new Error('HTTP ' + res.status); er.retry = res.status === 429 || res.status >= 500; throw er; }
          const data = await res.json();
          cacheSet(key, data);
          return data;
        } catch (e) {
          lastErr = e;
          // Yahoo sometimes rate-limits (429) or hiccups (5xx) when many peer requests fire together: wait briefly and try once more
          if (!(e.retry || e.name === 'AbortError' || e instanceof TypeError)) break;
          await new Promise((done) => setTimeout(done, 700));
        } finally { clearTimeout(timer); }
      }
    }
    throw lastErr;
  }
  // POST (only the Worker supports it; used for the industry screener)
  async function ypost(url, body) {
    if (!CFG.WORKER_URL) throw new Error('POST needs the Worker');
    const key = 'yp:' + url + JSON.stringify(body);
    const hit = cacheGet(key); if (hit) return hit;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CFG.REQUEST_TIMEOUT_MS || 15000);
    try {
      const res = await fetch(CFG.WORKER_URL.replace(/\/+$/, '') + '/?url=' + encodeURIComponent(url), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      cacheSet(key, data);
      return data;
    } finally { clearTimeout(timer); }
  }
  const Yahoo = {
    search: (q) => yfetch(`${YH}/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=20&newsCount=0&listsCount=0&enableFuzzyQuery=true&region=IN&lang=en-IN`),
    recs: (s) => yfetch(`${YH}/v6/finance/recommendationsbysymbol/${encodeURIComponent(s)}`),
    chart: (s, range, interval) => yfetch(`${YH}/v8/finance/chart/${encodeURIComponent(s)}?range=${range}&interval=${interval}&includePrePost=false&events=div%2Csplit`),
    timeseries: (s) => {
      const day = 86400;
      const p2 = Math.floor(Date.now() / 1000 / day) * day + day;
      const p1 = p2 - 10 * 365 * day;
      return yfetch(`${YH}/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(s)}?symbol=${encodeURIComponent(s)}&type=${A.TIMESERIES_TYPES.join(',')}&period1=${p1}&period2=${p2}&merge=false`);
    },
    summary: (s) => yfetch(`${YH}/v10/finance/quoteSummary/${encodeURIComponent(s)}?modules=price,summaryDetail,defaultKeyStatistics,financialData,assetProfile`),
    profile: (s) => yfetch(`${YH}/v10/finance/quoteSummary/${encodeURIComponent(s)}?modules=assetProfile`),
    industry: (key) => yfetch(`${YH}/v1/finance/industries/${encodeURIComponent(key)}?formatted=true&withReturns=false&lang=en-US&region=US`),
    screener: (body) => ypost(`${YH1}/v1/finance/screener?formatted=false&useRecordsResponse=false&lang=en-US&region=US&corsDomain=finance.yahoo.com`, body)
  };

  // Run fn over items with limited concurrency; never throws (each slot is {ok, v|e})
  async function pool(items, limit, fn) {
    const out = new Array(items.length); let i = 0;
    const run = async () => {
      while (i < items.length) {
        const k = i++;
        try { out[k] = { ok: true, v: await fn(items[k], k) }; } catch (e) { out[k] = { ok: false, e }; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return out;
  }

    /* ====================== COMPANY LOGOS ====================== */
  const LOGO_TEMPLATES = (() => {
    const t = [], k = CFG.LOGODEV_KEY;
    if (k) {
      t.push('https://img.logo.dev/ticker/{symbol}?token=' + encodeURIComponent(k) + '&size=128&format=png&fallback=404');
      t.push('https://img.logo.dev/{domain}?token=' + encodeURIComponent(k) + '&size=128&format=png&fallback=404');
    }
    return t.concat((CFG.LOGO_SOURCES && CFG.LOGO_SOURCES.length) ? CFG.LOGO_SOURCES : [
      'https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&url=https://{domain}&size=128',
      'https://icons.duckduckgo.com/ip3/{domain}.ico'
    ]);
  })();
  const logoCandidates = (d, s) => LOGO_TEMPLATES
    .filter((t) => (d || !t.includes('{domain}')) && (s || !t.includes('{symbol}')))
    .map((t) => t.replace('{domain}', encodeURIComponent(d || '')).replace('{symbol}', encodeURIComponent(s || '')));
  const domainOf = (url) => {
    if (!url) return '';
    try { return new URL(/^https?:/i.test(url) ? url : 'https://' + url).hostname.replace(/^www\./i, ''); } catch (e) { return ''; }
  };
  const initials = (name) => {
    const w = String(name || '').replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
    if (!w.length) return '?';
    return (w.length === 1 ? w[0].slice(0, 2) : w[0][0] + w[1][0]).toUpperCase();
  };
  function logoHTML(domain, name, size, sym) {
    const c = logoCandidates(domain, sym);
    return `<span class="logo ${size || ''} ${c.length ? '' : 'nologo'}" data-d="${esc(domain || '')}" data-s="${esc(sym || '')}" data-n="0">${c.length ? `<img src="${esc(c[0])}" alt="" loading="lazy" decoding="async">` : ''}<b>${esc(initials(name))}</b></span>`;
  }
  function applyLogo(wrap, domain) {
    if (!wrap || !domain) return;
    wrap.dataset.d = domain;
    if (!wrap.classList.contains('nologo') && wrap.querySelector('img')) return;
    const c = logoCandidates(domain, wrap.dataset.s); if (!c.length) return;
    wrap.dataset.n = '0'; wrap.classList.remove('nologo');
    let img = wrap.querySelector('img');
    if (!img) { img = document.createElement('img'); img.alt = ''; img.decoding = 'async'; wrap.insertBefore(img, wrap.firstChild); }
    img.src = c[0];
  }
  function logoFail(img) {
    const w = img.closest && img.closest('.logo'); if (!w) return;
    const n = (+w.dataset.n || 0) + 1; w.dataset.n = String(n);
    const c = logoCandidates(w.dataset.d, w.dataset.s);
    if (c[n]) img.src = c[n]; else w.classList.add('nologo');
  }
  document.addEventListener('error', (e) => { if (e.target instanceof HTMLImageElement) logoFail(e.target); }, true);
  document.addEventListener('load', (e) => { const t = e.target; if (t instanceof HTMLImageElement && t.closest('.logo') && t.naturalWidth && t.naturalWidth < 8) logoFail(t); }, true);
  if (CFG.LOGODEV_KEY) document.addEventListener('DOMContentLoaded', () => {
    const f = document.querySelector('.foot');
    if (f) f.insertAdjacentHTML('beforeend', '<p style="margin-top:8px"><a href="https://logo.dev" target="_blank" rel="noopener" style="color:inherit">Logos provided by Logo.dev</a></p>');
  });

  // Company website domains: a few well-known seeds, then looked up from Yahoo and remembered
  const SEED_DOMAINS = { 'RELIANCE.NS': 'ril.com', 'TCS.NS': 'tcs.com', 'HDFCBANK.NS': 'hdfcbank.com', 'INFY.NS': 'infosys.com', 'TATAMOTORS.NS': 'tatamotors.com', 'ITC.NS': 'itcportal.com' };
  const DOM_KEY = 'plutus:dom';
  const domCache = (() => { try { return JSON.parse(localStorage.getItem(DOM_KEY)) || {}; } catch (e) { return {}; } })();
  function saveDom(sym, d) { domCache[sym] = d; try { localStorage.setItem(DOM_KEY, JSON.stringify(domCache)); } catch (e) { /* ignore */ } }
  function knownDomain(it) {
    if (it.domain != null) return it.domain;
    if (SEED_DOMAINS[it.symbol]) return SEED_DOMAINS[it.symbol];
    if (domCache[it.symbol] !== undefined) return domCache[it.symbol];
    return null; // unknown yet
  }
  const domInflight = {};
  function resolveDomain(sym) {
    if (domInflight[sym]) return domInflight[sym];
    domInflight[sym] = (async () => {
      try {
        const S = A.parseSummary(await Yahoo.profile(sym));
        const d = domainOf(S.assetProfile && S.assetProfile.website);
        saveDom(sym, d);
        return d;
      } catch (e) { return ''; } finally { delete domInflight[sym]; }
    })();
    return domInflight[sym];
  }
  let domQueue = 0; const domWaiters = [];
  async function limitedResolve(sym) {
    if (domQueue >= 4) await new Promise((r) => domWaiters.push(r));
    domQueue++;
    try { return await resolveDomain(sym); } finally { domQueue--; const n = domWaiters.shift(); if (n) n(); }
  }

  /* ====================== FUZZY SEARCH (by company name) ====================== */
  const RECENT_KEY = 'plutus:recent';
  const getRecent = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch (e) { return []; } };
  const pushRecent = (it) => {
    const r = getRecent().filter((x) => x.symbol !== it.symbol);
    const d = knownDomain(it);
    r.unshift({ ...it, domain: d == null ? undefined : d });
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(r.slice(0, 6))); } catch (e) { /* ignore */ }
  };
  const isIndian = (sym) => /\.(NS|BO)$/.test(sym || '');

  // Normalise a company name (or the typed query) so "Tata Motors Ltd." and "tata motors" compare cleanly
  const LEGAL = /\b(limited|ltd|inc|incorporated|corp|corporation|co|company|plc|ag|nv|sa|llc|lp|pvt|private)\b/g;
  const norm = (s) => {
    const t = String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const u = t.replace(LEGAL, ' ').replace(/\s+/g, ' ').trim();
    return u || t;
  };
  function highlight(text, q) {
    const t = esc(text); if (!q) return t;
    const words = q.trim().split(/\s+/).filter((w) => w.length > 1).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!words.length) return t;
    return t.replace(new RegExp('(' + words.join('|') + ')', 'ig'), '<mark>$1</mark>');
  }
  // Rank Yahoo's results by how well the COMPANY NAME matches what was typed (the ticker is never used for matching)
  function rankByName(quotes, query) {
    const q = norm(query);
    if (!q || !quotes.length) return quotes;
    const bonus = (x) => (/\.NS$/.test(x.symbol) ? 0.12 : /\.BO$/.test(x.symbol) ? 0.08 : 0); // favour Indian listings: NSE, then BSE
    const nameBoost = (n) => (n.startsWith(q) ? 0.45 : n.split(' ').some((w) => w.startsWith(q)) ? 0.3 : n.includes(q) ? 0.18 : 0);
    const docs = quotes.map((x) => ({ ...x, n1: norm(x.name), n2: norm(x.short) }));
    if (!window.Fuse) {
      const hits = docs.filter((d) => d.n1.includes(q) || d.n2.includes(q));
      return (hits.length ? hits : docs).sort((a, b) => bonus(b) - bonus(a));
    }
    const fuse = new Fuse(docs, { keys: [{ name: 'n1', weight: 0.65 }, { name: 'n2', weight: 0.35 }], threshold: 0.42, ignoreLocation: true, includeScore: true, minMatchCharLength: 2 });
    const hits = fuse.search(q)
      .map((h) => ({ item: h.item, s: h.score - Math.max(nameBoost(h.item.n1), nameBoost(h.item.n2)) - bonus(h.item) }))
      .sort((a, b) => a.s - b.s).map((h) => h.item);
    // If nothing matches by name, fall back to Yahoo's own order so the user still sees something
    return hits.length ? hits : docs.sort((a, b) => bonus(b) - bonus(a));
  }

  function attachSearch(input, list) {
    let items = [], active = -1, timer = null, seq = 0, header = '';
    const open = () => list.classList.add('open');
    const close = () => { list.classList.remove('open'); active = -1; };

    function hydrateLogos() {
      const snap = items;
      snap.forEach((it, i) => {
        if (knownDomain(it) !== null) return;
        limitedResolve(it.symbol).then((d) => {
          if (!d || snap !== items) return;
          it.domain = d;
          applyLogo(list.querySelector(`li[data-i="${i}"] .logo`), d);
        });
      });
    }
    function renderItems(q) {
      if (!items.length) { list.innerHTML = `<li class="s-info">No listed companies match “${esc(q)}”. Check the spelling of the company name.</li>`; open(); return; }
      list.innerHTML = (header ? `<li class="s-head">${header}</li>` : '') + items.map((it, i) => {
        const dom = knownDomain(it);
        return `<li role="option" data-i="${i}" class="${i === active ? 'active' : ''}">
           ${logoHTML(dom, it.name, 'md', it.symbol)}
           <span class="s-main">
             <span class="s-name">${highlight(it.name, q)}</span>
             <span class="s-sub">${isIndian(it.symbol) ? '<b class="in-tag">IN</b>' : ''}<span class="s-sym">${esc(it.symbol)}</span>${it.exch ? ' · ' + esc(it.exch) : ''}</span>
           </span>
         </li>`;
      }).join('');
      open();
      const a = list.querySelector('li.active'); if (a) a.scrollIntoView({ block: 'nearest' });
      hydrateLogos();
    }
    function showRecent() {
      const r = getRecent();
      if (!r.length) return close();
      items = r; active = -1; header = 'RECENT'; renderItems('');
    }
    async function run(q) {
      const my = ++seq;
      header = '';
      list.innerHTML = '<li class="s-info">Scanning markets…</li>'; open();
      try {
        const data = await Yahoo.search(q);
        if (my !== seq) return;
        const quotes = (data.quotes || [])
          .filter((x) => x.symbol && x.quoteType === 'EQUITY')
          .map((x) => ({ symbol: x.symbol, name: x.longname || x.shortname || x.symbol, short: x.shortname || '', exch: x.exchDisp || x.exchange || '', sector: x.sectorDisp || x.sector || '', industry: x.industryDisp || x.industry || '' }));
        items = rankByName(quotes, q).slice(0, 10); active = items.length ? 0 : -1;
        renderItems(q);
      } catch (e) {
        if (my !== seq) return;
        list.innerHTML = `<li class="s-info">Can’t reach the data service right now (${esc(e.message)}).</li>`; open();
      }
    }
    function choose(i) {
      const it = items[i]; if (!it) return;
      state.lastHits[it.symbol] = it; pushRecent(it);
      input.value = ''; close(); input.blur();
      location.hash = '#/s/' + encodeURIComponent(it.symbol);
    }
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (!q) { seq++; return showRecent(); }
      timer = setTimeout(() => run(q), 230);
    });
    input.addEventListener('focus', () => { if (!input.value.trim()) showRecent(); });
    input.addEventListener('keydown', (e) => {
      if (!list.classList.contains('open')) return;
      const q = input.value.trim();
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); renderItems(q); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); renderItems(q); }
      else if (e.key === 'Enter') { e.preventDefault(); choose(active >= 0 ? active : 0); }
      else if (e.key === 'Escape') close();
    });
    list.addEventListener('mousedown', (e) => { const li = e.target.closest('li[data-i]'); if (li) { e.preventDefault(); choose(+li.dataset.i); } });
    document.addEventListener('click', (e) => { if (!list.contains(e.target) && e.target !== input) close(); });
  }

  /* ====================== ROUTING ====================== */
  function route() {
    const m = location.hash.match(/^#\/s\/(.+)$/);
    if (m) { showView('dash'); loadDashboard(decodeURIComponent(m[1]).toUpperCase()); }
    else { showView('search'); if (!isMobile()) setTimeout(() => $('#mainSearch').focus(), 50); }
  }
  function showView(v) {
    $('#viewSearch').classList.toggle('hidden', v !== 'search');
    $('#viewDash').classList.toggle('hidden', v !== 'dash');
    $('#miniSearchWrap').classList.toggle('hidden', v !== 'dash');
    window.scrollTo(0, 0);
  }

  /* ====================== DASHBOARD ====================== */
  let loadSeq = 0;
  async function loadDashboard(symbol) {
    const my = ++loadSeq;
    destroyCharts();
    state.ind = null; state.peerCmp = null;
    $('#dashContent').classList.add('hidden'); $('#dashError').classList.add('hidden');
    $('#dashLoading').classList.remove('hidden'); $('#loadingSym').textContent = '· ' + symbol;
    document.title = symbol + ' — PLUTUS';
    const [c5, c1, ts, sum] = await Promise.allSettled([
      Yahoo.chart(symbol, '5y', '1wk'), Yahoo.chart(symbol, '1y', '1d'), Yahoo.timeseries(symbol), Yahoo.summary(symbol)
    ]);
    if (my !== loadSeq) return;
    const val = (r) => (r.status === 'fulfilled' ? r.value : null);
    $('#dashLoading').classList.add('hidden');
    const chartOk = (r) => { const v = val(r); return v && v.chart && v.chart.result && v.chart.result[0]; };
    if (!chartOk(c5) && !chartOk(c1)) {
      const reason = c1.status === 'rejected' ? c1.reason.message : 'Symbol not found';
      return showError(symbol, reason);
    }
    let model;
    try { model = A.buildModel(symbol, val(c5), val(c1), val(ts), val(sum), state.lastHits[symbol]); }
    catch (e) { console.error(e); return showError(symbol, 'Could not process the data for this company.'); }
    state.model = model;
    document.title = model.name + ' (' + symbol + ') — PLUTUS';
    render(model, { summaryOk: !!val(sum) && model.hasProfile });
    loadPeers(model, my);
  }
  function showError(symbol, reason) {
    const el = $('#dashError');
    el.innerHTML = `<h2>Signal lost</h2><p>We couldn’t load data for <b>${esc(symbol)}</b>.<br>${esc(reason)}</p>
      <button onclick="location.hash='#/'">← New search</button>`;
    el.classList.remove('hidden');
  }

  const colorFor = (s) => (s == null ? 'var(--dim)' : s >= 70 ? 'var(--good)' : s >= 45 ? 'var(--warn)' : 'var(--bad)');
  const hexFor = (s) => (s == null ? '#4b515b' : s >= 70 ? '#2ee6a6' : s >= 45 ? '#ffc857' : '#ff5a6e');
  const signCls = (v) => (!isNum(v) ? 'muted' : v > 0 ? 'good' : v < 0 ? 'bad' : 'muted');

  /* ---------- industry-average comparison ---------- */
  // Every metric that is shown for the company is also computed (the same way) for its industry peers.
  const pillarScore = (m, k) => { const p = m.scores.pillars.find((x) => x.key === k); return p ? p.score : null; };
  const IND = {
    mc:  { get: (m) => m.marketCap, f: 'money', cur: 'px', better: null },
    rev: { get: (m) => m.revLast, f: 'money', cur: 'fin', better: null },
    ni:  { get: (m) => m.niLast, f: 'money', cur: 'fin', better: null },
    nm:  { get: (m) => m.netMargin, f: 'pct', better: 'high' },
    pe:  { get: (m) => (m.negEarnings ? null : A.validPe(m.pe)), f: 'x', better: 'low' },
    roe: { get: (m) => m.roe, f: 'pct', better: 'high' },
    de:  { get: (m) => (m.isFinancial ? null : m.de), f: 'x2', better: 'low', skipFin: true },
    eqa: { get: (m) => m.equityToAssets, f: 'pct', better: 'high' },
    fcf: { get: (m) => m.fcfLast, f: 'money', cur: 'fin', better: null },
    cr:  { get: (m) => (m.isFinancial ? null : m.currentRatio), f: 'x2', better: 'high', skipFin: true },
    eps: { noAvg: true },
    dy:  { get: (m) => m.divYield, f: 'pct2', better: 'high' },
    r1:  { get: (m) => m.ret1y, f: 'pct', better: 'high' },
    vol: { get: (m) => m.vol, f: 'pct', better: 'low' },
    pos: { get: (m) => m.pos52, f: 'pct0', better: null },
    overall: { get: (m) => m.scores.overall, f: 'pts', better: 'high' }
  };
  const specFor = (k) => (k.startsWith('p_') ? { get: (m) => pillarScore(m, k.slice(2)), f: 'pts', better: 'high' } : IND[k]);
  const allIndKeys = (m) => [...Object.keys(IND), ...m.scores.pillars.map((p) => 'p_' + p.key)];

  function fmtBy(spec, v, m) {
    switch (spec.f) {
      case 'money': return fmtMoney(v, spec.cur === 'px' ? m.currency : m.finCurrency);
      case 'pct': return fmtPct(v, 1);
      case 'pct2': return fmtPct(v, 2);
      case 'pct0': return fmtPct(v, 0);
      case 'x': return fmtX(v, 1);
      case 'x2': return fmtX(v, 2);
      case 'pts': return String(Math.round(v));
      default: return String(v);
    }
  }
  // How the company's value sits against the industry average, with a colour only when "better/worse" is meaningful
  function vsAvg(v, a, spec) {
    if (!isNum(v) || !isNum(a)) return null;
    const d = v - a, ad = Math.abs(d); let txt, tiny;
    if (spec.f === 'pct' || spec.f === 'pct2' || spec.f === 'pct0') { txt = `${(ad * 100).toFixed(1)} pts`; tiny = ad < 0.005; }
    else if (spec.f === 'pts') { txt = `${Math.round(ad)} pts`; tiny = ad < 2; }
    else {
      if (a === 0) return null;
      const rel = ad / Math.abs(a);
      txt = `${(rel * 100).toFixed(0)}%`; tiny = rel < 0.03;
    }
    let cls = 'muted';
    if (!tiny && spec.better) cls = ((spec.better === 'high') === (d > 0)) ? 'good' : 'bad';
    return { txt: tiny ? '≈ in line' : `${d > 0 ? '▲' : '▼'} ${txt} ${d > 0 ? 'above' : 'below'}`, cls };
  }
  const indBox = (key) => `<div class="ind load" data-ind="${key}"><span class="ind-l">Industry avg</span><span class="ind-v">…</span></div>`;

  function computeIndustryAvg(models) {
    const avg = {};
    allIndKeys(state.model).forEach((k) => {
      const spec = specFor(k); if (!spec || spec.noAvg) return;
      // money amounts (market cap, revenue, profit, cash flow) are only averaged across peers reporting in the same currency
      const usable = (x) => spec.f !== 'money' || (spec.cur === 'px' ? x.currency === state.model.currency : x.finCurrency === state.model.finCurrency);
      const vs = models.filter(usable).map((x) => spec.get(x)).filter(isNum);
      avg[k] = vs.length >= 2 ? vs.reduce((a, b) => a + b, 0) / vs.length : null;
    });
    return avg;
  }
  function fillIndustryUI() {
    const m = state.model; if (!m) return;
    const ind = state.ind;
    document.querySelectorAll('#dashContent [data-ind]').forEach((el) => {
      const key = el.dataset.ind, spec = specFor(key);
      el.classList.remove('load');
      const lbl = `<span class="ind-l">Industry avg${key === 'pos' ? ' position' : ''}</span>`;
      if (!spec) { el.innerHTML = ''; return; }
      if (spec.noAvg) { el.innerHTML = lbl + '<span class="ind-v muted">n/a · per-share values aren’t comparable across companies</span>'; return; }
      if (!ind) { el.innerHTML = lbl + '<span class="ind-v muted">n/a</span>'; return; }
      if (spec.skipFin && m.isFinancial) { el.innerHTML = lbl + '<span class="ind-v muted">n/a for financials</span>'; return; }
      const a = ind.avg[key];
      if (!isNum(a)) { el.innerHTML = lbl + '<span class="ind-v muted">n/a</span>'; return; }
      const c = vsAvg(spec.get(m), a, spec);
      el.innerHTML = lbl + `<span class="ind-v">${esc(fmtBy(spec, a, m))}</span>` + (c ? `<span class="vs ${c.cls}">${c.txt}</span>` : '');
    });
  }

  function aboutSection(m, idx) {
    // Website: shown as "Website  domain ↗" so it lines up with the other label/value facts
    const siteHost = domainOf(m.website);
    const siteHref = m.website ? (/^https?:/i.test(m.website) ? m.website : 'https://' + m.website) : '';
    const facts = [
      m.sector ? `<span class="fact"><span class="fk">Sector</span> <b>${esc(m.sector)}</b></span>` : '',
      m.industry ? `<span class="fact"><span class="fk">Industry</span> <b>${esc(m.industry)}</b></span>` : '',
      m.city || m.country ? `<span class="fact"><span class="fk">HQ</span> <b>${esc([m.city, m.country].filter(Boolean).join(', '))}</b></span>` : '',
      m.employees ? `<span class="fact"><span class="fk">Employees</span> <b>${Number(m.employees).toLocaleString(m.currency === 'INR' ? 'en-IN' : 'en-US')}</b></span>` : '',
      isNum(m.beta) ? `<span class="fact"><span class="fk">Beta</span> <b>${m.beta.toFixed(2)}</b></span>` : '',
      siteHref ? `<span class="fact"><span class="fk">Website</span> <b><a href="${esc(siteHref)}" target="_blank" rel="noopener">${esc(siteHost || m.website)} ↗</a></b></span>` : ''
    ].join('');
    if (!m.summary && !facts) return '';
    return `<section class="section about reveal">
      <div class="section-head"><span class="idx">${idx}</span><h2>About the Company</h2><p>What the business does</p></div>
      ${m.summary ? `<p class="about-text clamp" id="aboutText">${esc(m.summary)}</p><button class="more-btn hidden" id="aboutMore">Read more ↓</button>` : ''}
      ${facts ? `<div class="facts">${facts}</div>` : ''}
    </section>`;
  }

  function render(m, opts) {
    const c = m.finCurrency, pc = m.currency;
    const S = m.scores;
    const posPct = isNum(m.pos52) ? (m.pos52 * 100).toFixed(1) : null;
    let n = 0; const idx = () => String(++n).padStart(2, '0');
    const notices = [];
    if (!opts.summaryOk) notices.push('Company profile & key statistics are temporarily unavailable — some figures are computed from statements instead.');
    if (!m.hasFundamentals) notices.push('Yahoo Finance has no annual financial statements for this listing, so growth, profit and balance-sheet metrics can’t be shown.');
    if (!m.sameCur && m.hasFundamentals) notices.push(`Financial statements are reported in ${c} while the share trades in ${pc}; the P/E history chart is hidden to avoid mixing currencies.`);
    const about = aboutSection(m, '01');
    if (about) n = 1;
    const dom = domainOf(m.website) || (domCache[m.symbol] || '');
    if (domainOf(m.website)) saveDom(m.symbol, domainOf(m.website));

    const html = `
    <section class="identity reveal">
      <div class="ident-row">
        ${logoHTML(dom, m.name, 'lg', m.symbol)}
        <div class="ident-txt">
          <div class="meta"><b>${esc(m.symbol)}</b> · ${esc(m.exchange)}</div>
          <h1>${esc(m.name)}</h1>
        </div>
      </div>
      <div class="price-block">
        <div class="price">${fmtPrice(m.price, pc)}</div>
        <div class="chg ${signCls(m.changePct)}">${isNum(m.change) ? (m.change > 0 ? '▲ ' : m.change < 0 ? '▼ ' : '') + Math.abs(m.change).toFixed(2) : ''} ${isNum(m.changePct) ? '(' + fmtPct(m.changePct, 2, true) + ')' : ''} <span class="muted">today</span></div>
      </div>
    </section>
    ${notices.map((x) => `<div class="notice">${esc(x)}</div>`).join('')}
    <div class="strip reveal">
      <div><div class="k">Market Cap</div><div class="v">${fmtMoney(m.marketCap, pc)}</div>${indBox('mc')}</div>
      <div><div class="k">P/E Ratio</div><div class="v">${m.negEarnings ? 'n/a <span class="muted" style="font-size:12px">(loss)</span>' : fmtX(m.pe, 1)}</div>${indBox('pe')}</div>
      <div><div class="k">1-Year Return</div><div class="v ${signCls(m.ret1y)}">${fmtPct(m.ret1y, 1, true)}</div>${indBox('r1')}</div>
      <div><div class="k">Dividend Yield</div><div class="v">${isNum(m.divYield) ? fmtPct(m.divYield, 2) : '—'}</div>${indBox('dy')}</div>
      <div><div class="k">52-Week Range</div>
        ${posPct != null ? `<div class="range"><span style="left:${posPct}%"></span></div>
        <div class="range-lbl"><span>${fmtPrice(m.low52, pc)}</span><span>${fmtPrice(m.high52, pc)}</span></div>` : '<div class="v">—</div>'}
        ${indBox('pos')}
      </div>
    </div>

    ${about}

    <section class="section reveal">
      <div class="section-head"><span class="idx">${idx()}</span><h2>Health Scan</h2><p>Six power stats, scored 0–100 from reported numbers</p></div>
      <div class="health">
        <div class="panel ring-wrap">
          <div class="panel-title">Overall Health Score</div>
          <div class="ring">
            <svg viewBox="0 0 200 200"><circle class="track" cx="100" cy="100" r="88"/><circle class="bar" id="ringBar" cx="100" cy="100" r="88"
              stroke="${hexFor(S.overall)}" stroke-dasharray="${2 * Math.PI * 88}" stroke-dashoffset="${2 * Math.PI * 88}"/></svg>
            <div class="center"><div class="num" id="ringNum">0</div><div class="of">OF 100</div></div>
          </div>
          <div class="tier ${S.tier.cls}">${S.tier.label}</div>
          ${indBox('overall')}
          <div class="ring-note">Average of the six stats. Describes financial health — not whether the share is a good buy.</div>
        </div>
        <div class="panel">
          <div class="panel-title">Power Stats</div>
          ${S.pillars.map((p) => {
            const lit = p.score == null ? 0 : Math.round(p.score / 10);
            return `<div class="pillar">
              <div class="pillar-top"><span class="pillar-name">${p.name}</span><span class="pillar-score" style="color:${colorFor(p.score)}">${p.score == null ? 'N/A' : p.score}</span></div>
              <div class="pillar-hint">${p.hint}</div>
              <div class="segs">${Array.from({ length: 10 }, (_, i) => `<i style="${i < lit ? 'background:' + hexFor(p.score) : ''}"></i>`).join('')}</div>
              ${indBox('p_' + p.key)}
            </div>`;
          }).join('')}
        </div>
      </div>
    </section>

    <section class="section reveal">
      <div class="section-head"><span class="idx">${idx()}</span><h2>Key Numbers</h2><p>Latest financial year · tap ⓘ for a plain-English meaning</p></div>
      <div class="kpis">${kpiCards(m).join('')}</div>
    </section>

    <section class="section reveal">
      <div class="section-head"><span class="idx">${idx()}</span><h2>Trajectory</h2><p>How the business and the share price have moved over time</p></div>
      <div class="charts">
        ${chartCard('chPrice', 'Share Price', 'What one share has cost in the market over time.', m.takeaways.price, true,
          '<div class="toggle" id="priceToggle"><button data-r="1y">1Y</button><button data-r="5y" class="on">5Y</button></div>')}
        ${chartCard('chPE', 'P/E Ratio History', 'How many years of profit investors pay for in the share price (price ÷ latest annual earnings per share). Dashed line = 5-year median; dotted green line = industry average P/E.', m.takeaways.pe, true)}
        <div class="period-bar">
          <div><span class="pb-title">Business Results</span><span class="pb-sub" id="periodNote"></span></div>
          <div class="toggle big" id="periodToggle"><button data-p="annual" class="on">YEARLY</button><button data-p="quarterly">QUARTERLY</button></div>
        </div>
        ${chartCard('chRev', 'Revenue vs Net Profit', 'Sales (everything customers paid) vs. what was left after all costs and taxes.', m.takeaways.revenue)}
        ${chartCard('chMargin', 'Profit Margins', 'Out of every 100 of sales, how much remains as profit at each stage. Dashed white line = industry average net margin (yearly view).', m.takeaways.margins)}
        ${chartCard('chEPS', 'Earnings per Share', 'Profit belonging to each single share.', m.takeaways.eps)}
        ${chartCard('chCash', 'Cash Flow', 'Cash generated by operations, and what is left after investing in the business (free cash flow).', m.takeaways.cash)}
        ${chartCard('chDebt', 'Debt vs Shareholders’ Equity', 'Money borrowed vs. money that belongs to the owners.', m.takeaways.debt, true)}
      </div>
    </section>

    <section class="section reveal">
      <div class="section-head"><span class="idx">${idx()}</span><h2>Peer Arena</h2><p>How it stacks up against companies in the same industry</p></div>
      <div id="peerWrap"><div class="peer-loading"><div class="orbit sm"><span></span></div><span>Finding industry peers…</span></div></div>
    </section>

    <section class="section reveal">
      <div class="section-head"><span class="idx">${idx()}</span><h2>Strengths &amp; Weaknesses</h2><p>Facts that stand out — you decide what matters to you</p></div>
      <div class="sw" id="swWrap">
        ${swCol('s', 'Strengths', m.strengths, 'good')}
        ${swCol('w', 'Weaknesses', m.weaknesses, 'bad')}
      </div>
      <div class="verdict-note">PLUTUS does not tell you to buy, sell or hold. Every investor has different goals, time horizons and risk tolerance. Use these facts as a starting point, compare with similar companies, and read the company’s official reports before deciding.</div>
    </section>`;

    const root = $('#dashContent');
    root.innerHTML = html;
    root.classList.remove('hidden');

    // About: show "Read more" only if text is actually clamped
    const at = $('#aboutText'), mb = $('#aboutMore');
    if (at && mb) {
      requestAnimationFrame(() => { if (at.scrollHeight > at.clientHeight + 4) mb.classList.remove('hidden'); });
      mb.addEventListener('click', () => { const c2 = at.classList.toggle('clamp'); mb.textContent = c2 ? 'Read more ↓' : 'Show less ↑'; });
    }
    // KPI tooltips: tap-to-toggle for touch screens
    root.querySelectorAll('.kpi .info').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const card = b.closest('.kpi'); const was = card.classList.contains('tip-open');
      root.querySelectorAll('.kpi.tip-open').forEach((k) => k.classList.remove('tip-open'));
      if (!was) card.classList.add('tip-open');
    }));
    document.addEventListener('click', () => root.querySelectorAll('.kpi.tip-open').forEach((k) => k.classList.remove('tip-open')));

    requestAnimationFrame(() => {
      const C = 2 * Math.PI * 88, bar = $('#ringBar');
      if (bar && isNum(S.overall)) bar.style.strokeDashoffset = C * (1 - S.overall / 100);
      countUp($('#ringNum'), S.overall);
    });
    observeReveal();
    drawCharts(m);
  }

  function countUp(el, target) {
    if (!el) return;
    if (!isNum(target)) { el.textContent = '—'; return; }
    const t0 = performance.now(), dur = 1300;
    const step = (t) => { const p = Math.min(1, (t - t0) / dur); el.textContent = Math.round(target * (1 - Math.pow(1 - p, 3))); if (p < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
  function observeReveal() {
    const els = document.querySelectorAll('.reveal');
    if (!('IntersectionObserver' in window)) { els.forEach((e) => e.classList.add('in')); return; }
    const io = new IntersectionObserver((ents) => ents.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } }), { threshold: 0.05 });
    els.forEach((e) => io.observe(e));
  }

  /* ---------- KPI cards ---------- */
  function kpiCards(m) {
    const c = m.finCurrency;
    const lvl = (v, good, bad, higherBetter = true) => (!isNum(v) ? '' : higherBetter ? (v >= good ? 'good' : v <= bad ? 'bad' : 'warn') : (v <= good ? 'good' : v >= bad ? 'bad' : 'warn'));
    const card = (k, v, sub, dot, tip, ik) => `<div class="kpi"><div class="k"><span class="dot ${dot}"></span><span class="k-label">${k}</span><button class="info" aria-label="What is ${k}?">i</button><div class="tip">${tip}</div></div><div class="v">${v}</div><div class="sub">${sub}</div>${indBox(ik)}</div>`;
    const yoy = (g) => (isNum(g) ? `<span class="${signCls(g)}">${fmtPct(g, 1, true)}</span> vs last year` : 'vs last year: —');
    const fin = m.isFinancial;
    return [
      card('Revenue', fmtMoney(m.revLast, c), yoy(m.revYoY), lvl(m.revYoY, 0.08, 0), 'Total money the company earned from selling its products or services in the year. Growing revenue means more customers or higher prices.', 'rev'),
      card('Net Profit', fmtMoney(m.niLast, c), isNum(m.niYoY) ? yoy(m.niYoY) : (isNum(m.niLast) && m.niLast < 0 ? '<span class="bad">Net loss</span>' : '—'), isNum(m.niLast) && m.niLast < 0 ? 'bad' : lvl(m.niYoY, 0.08, 0), 'What is left after paying every cost, interest and tax. This is the company’s “take-home pay”.', 'ni'),
      card('Net Margin', fmtPct(m.netMargin), isNum(m.netMarginPrev) ? `prev. year ${fmtPct(m.netMarginPrev)}` : '—', lvl(m.netMargin, 0.12, 0.04), 'Profit kept from every 100 of sales. 20% means 20 of every 100 is profit. Higher = more efficient business.', 'nm'),
      card('P/E Ratio', m.negEarnings ? 'n/a' : fmtX(m.pe, 1), isNum(m.peMedian) && isNum(m.pe) ? `5-yr median ${fmtX(m.peMedian, 1)}` : isNum(m.fwdPe) ? `forward ${fmtX(m.fwdPe, 1)}` : '—', m.negEarnings ? 'bad' : lvl(m.pe, 18, 40, false), 'Share price ÷ profit per share. A P/E of 20 means you pay 20 years of today’s profit. Higher = more expensive (often because growth is expected).', 'pe'),
      card('ROE', fmtPct(m.roe), 'profit ÷ shareholders’ money', lvl(m.roe, 0.15, 0.06), 'Return on Equity: how much profit the company makes with the money its owners have put in. 20% means 20 of profit for every 100 of owners’ money.', 'roe'),
      card(fin ? 'Equity / Assets' : 'Debt / Equity', fin ? fmtPct(m.equityToAssets) : fmtX(m.de, 2), fin ? 'capital cushion (financial co.)' : 'borrowed per 1 of owners’ money', fin ? lvl(m.equityToAssets, 0.12, 0.06) : lvl(m.de, 0.5, 1.5, false), fin ? 'For banks and insurers, borrowing is the business. This shows what share of assets is funded by owners — a bigger cushion absorbs losses better.' : 'How much the company has borrowed compared with what its owners have put in. 0.5× means 50 of debt for every 100 of equity. Lower = less risk from lenders.', fin ? 'eqa' : 'de'),
      card('Free Cash Flow', fmtMoney(m.fcfLast, c), isNum(m.fcfMargin) ? `${fmtPct(m.fcfMargin)} of revenue` : '—', isNum(m.fcfLast) ? (m.fcfLast > 0 ? 'good' : 'bad') : '', 'Cash left over after running the business and paying for new equipment. It can fund dividends, buybacks or growth without borrowing.', 'fcf'),
      card('Current Ratio', fin ? 'n/a' : fmtX(m.currentRatio, 2), fin ? 'not meaningful for financials' : 'short-term assets ÷ bills', fin ? '' : lvl(m.currentRatio, 1.5, 1), 'Can the company pay bills due within a year? Above 1× means it has more near-cash assets than short-term bills.', 'cr'),
      card('EPS (TTM)', isNum(m.ttmEps) ? m.ttmEps.toFixed(2) : '—', `${esc(c)} per share · last 12 months`, isNum(m.ttmEps) ? (m.ttmEps > 0 ? 'good' : 'bad') : '', 'Earnings per share: total profit divided by the number of shares. Your “slice” of profit for each share you own.', 'eps'),
      card('Dividend Yield', isNum(m.divYield) ? fmtPct(m.divYield, 2) : '—', isNum(m.divYield) && m.divYield > 0 ? 'cash paid yearly ÷ price' : 'no regular dividend', isNum(m.divYield) && m.divYield >= 0.015 ? 'good' : '', 'Cash the company pays shareholders each year as a % of the share price. 2% means about 2 per year for every 100 invested.', 'dy'),
      card('1-Year Return', fmtPct(m.ret1y, 1, true), isNum(m.ret5y) ? `5-yr ${fmtPct(m.ret5y, 0, true)}` : 'price change', lvl(m.ret1y, 0.1, -0.1), 'How much the share price changed over the past 12 months (excluding dividends). Past moves do not predict future ones.', 'r1'),
      card('Volatility', fmtPct(m.vol, 0), isNum(m.maxDD) ? `worst dip ${fmtPct(m.maxDD, 0)}` : '—', lvl(m.vol, 0.25, 0.45, false), 'How wildly the price moved over the last year. 30% means it typically swings about ±30% in a year. Higher = bumpier ride.', 'vol')
    ];
  }

  function chartCard(id, title, what, takeaway, wide, extra) {
    return `<div class="chart-card ${wide ? 'wide' : ''}">
      <h3>${title}${extra || ''}</h3>
      <p class="what">${what}</p>
      <div class="chart-box" id="box-${id}"><canvas id="${id}"></canvas></div>
      <div class="takeaway ${takeaway ? '' : 'hidden'}" id="tk-${id}">${esc(takeaway || '')}</div>
    </div>`;
  }
  function swCol(cls, title, items, color) {
    return `<div class="sw-col ${cls}">
      <h3 class="${color}">${title} <span class="count">${items.length}</span></h3>
      ${items.length ? items.map((x) => `<div class="sw-item"><span class="bar"></span><div><div class="t">${esc(x.title)}${x.peer ? '<span class="peer-chip">VS INDUSTRY</span>' : ''}</div><div class="d">${esc(x.text)}</div></div><span class="m">${esc(x.metric)}</span></div>`).join('')
        : `<div class="sw-empty">Nothing stands out ${cls === 's' ? 'strongly on the positive side' : 'as a clear weak spot'} based on the available data.</div>`}
    </div>`;
  }

  /* ====================== INDUSTRY PEERS ====================== */
  const toIndustryKey = (s) => String(s || '').toLowerCase().replace(/&/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const sameText = (a, b) => !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

  // ----- listing country: derived from the ticker's exchange suffix (no suffix = US exchanges) -----
  const SUFFIX_COUNTRY = {
    NS: 'IN', BO: 'IN', L: 'GB', T: 'JP', HK: 'HK', DE: 'DE', F: 'DE', SG: 'DE', TO: 'CA', V: 'CA', NE: 'CA', CN: 'CA', AX: 'AU', NZ: 'NZ',
    PA: 'FR', MI: 'IT', MC: 'ES', AS: 'NL', BR: 'BE', LS: 'PT', ST: 'SE', CO: 'DK', HE: 'FI', OL: 'NO', VI: 'AT', SW: 'CH', IR: 'IE',
    SS: 'CN', SZ: 'CN', KS: 'KR', KQ: 'KR', TW: 'TW', TWO: 'TW', SI: 'SG', SA: 'BR', MX: 'MX', JO: 'ZA', TA: 'IL', BK: 'TH', JK: 'ID',
    KL: 'MY', SR: 'SA', IS: 'TR', WA: 'PL', AT: 'GR'
  };
  const COUNTRY_NAME = {
    US: 'the United States', IN: 'India', GB: 'the United Kingdom', JP: 'Japan', HK: 'Hong Kong', DE: 'Germany', CA: 'Canada', AU: 'Australia', NZ: 'New Zealand',
    FR: 'France', IT: 'Italy', ES: 'Spain', NL: 'the Netherlands', BE: 'Belgium', PT: 'Portugal', SE: 'Sweden', DK: 'Denmark', FI: 'Finland', NO: 'Norway',
    AT: 'Austria', CH: 'Switzerland', IE: 'Ireland', CN: 'China', KR: 'South Korea', TW: 'Taiwan', SG: 'Singapore', BR: 'Brazil', MX: 'Mexico', ZA: 'South Africa',
    IL: 'Israel', TH: 'Thailand', ID: 'Indonesia', MY: 'Malaysia', SA: 'Saudi Arabia', TR: 'Turkey', PL: 'Poland', GR: 'Greece'
  };
  const marketOf = (sym) => {
    const i = String(sym || '').lastIndexOf('.');
    if (i < 0) return 'US';
    const suf = sym.slice(i + 1).toUpperCase();
    return SUFFIX_COUNTRY[suf] || 'X:' + suf;
  };
  const countryName = (code) => COUNTRY_NAME[code] || '';

  // field: 'industry' (same industry) or 'sector' (wider fallback). Always restricted to the company's listing country.
  function screenerBody(m, field) {
    const ops = [{ operator: 'EQ', operands: [field, field === 'sector' ? m.sector : m.industry] }];
    const mk = marketOf(m.symbol);
    if (/\.NS$/.test(m.symbol)) ops.push({ operator: 'EQ', operands: ['exchange', 'NSI'] });
    else if (/\.BO$/.test(m.symbol)) ops.push({ operator: 'EQ', operands: ['exchange', 'BSE'] });
    else if (mk.length === 2) ops.push({ operator: 'EQ', operands: ['region', mk.toLowerCase()] });
    return { size: 40, offset: 0, sortField: 'intradaymarketcap', sortType: 'DESC', quoteType: 'EQUITY', topOperator: 'AND', query: { operator: 'AND', operands: ops }, userId: '', userIdType: 'guid' };
  }
  function collectSymbols(node, out, depth) {
    if (!node || depth > 8) return out;
    if (Array.isArray(node)) node.forEach((n) => collectSymbols(n, out, depth + 1));
    else if (typeof node === 'object') {
      if (typeof node.symbol === 'string' && node.symbol && node.symbol[0] !== '^') out.push({ symbol: node.symbol, name: node.name || node.longName || node.shortName || '' });
      Object.values(node).forEach((v) => { if (v && typeof v === 'object') collectSymbols(v, out, depth + 1); });
    }
    return out;
  }
  const rawNum = (v) => (isNum(v) ? v : v && isNum(v.raw) ? v.raw : null);

  // Collect candidate companies. Several sources, because any single one can be unavailable or return too few names.
  // `diag` records what each source returned so a "no peers" result can be explained instead of silently empty.
  async function gatherCandidates(m, diag) {
    const out = new Map();
    const myMarket = marketOf(m.symbol);
    const sameMkt = (x) => marketOf(x) === myMarket; // peers must be listed in the same country
    diag.market = myMarket;
    const add = (sym, name, mc, src) => { if (sym && sym !== m.symbol && sameMkt(sym) && !out.has(sym)) out.set(sym, { symbol: sym, name, marketCap: mc, src }); };
    const indCount = () => [...out.values()].filter((c) => c.src === 'screener' || c.src === 'industry').length;
    const runScreener = async (field, src) => {
      try {
        const r = await Yahoo.screener(screenerBody(m, field));
        const res = r && r.finance && r.finance.result && r.finance.result[0];
        const list = (res && (res.quotes || res.records)) || [];
        list.forEach((q) => add(q.symbol, q.longName || q.shortName || q.displayName || '', rawNum(q.marketCap), src));
        diag[src] = list.length;
      } catch (e) { diag[src] = 'error: ' + e.message; }
    };
    // 1) Yahoo screener: every listed company in this industry (needs the updated Worker)
    if (m.industry) await runScreener('industry', 'screener');
    // 2) Yahoo's industry page: the industry's top companies
    if (m.industry && indCount() < 6) {
      try {
        const r = await Yahoo.industry(m.industryKey || toIndustryKey(m.industry));
        const l = collectSymbols(r, [], 0);
        l.forEach((x) => add(x.symbol, x.name, null, 'industry'));
        diag.industryPage = l.length;
      } catch (e) { diag.industryPage = 'error: ' + e.message; }
    }
    // 3) Yahoo's "similar companies" (kept only if they pass the industry/sector check below)
    if (out.size < 8) {
      try {
        const r = await Yahoo.recs(m.symbol);
        const list = (r.finance && r.finance.result && r.finance.result[0] && r.finance.result[0].recommendedSymbols) || [];
        list.forEach((x) => add(x.symbol, '', null, 'recs'));
        diag.similar = list.length;
      } catch (e) { diag.similar = 'error: ' + e.message; }
    }
    // 4) Same SECTOR: fallback pool for companies whose exact industry has few (or no) listed peers, e.g. Apple
    if (m.sector && indCount() < 6) await runScreener('sector', 'screenerSector');
    const logGap = (c) => (isNum(c.marketCap) && isNum(m.marketCap) && c.marketCap > 0 && m.marketCap > 0 ? Math.abs(Math.log(c.marketCap / m.marketCap)) : 99);
    const prio = { screener: 0, industry: 1, recs: 2, screenerSector: 3 };
    const arr = [...out.values()].sort((a, b) => prio[a.src] - prio[b.src] || logGap(a) - logGap(b));
    diag.candidates = arr.length;
    return arr.slice(0, 18);
  }

  // Returns { models, level: 'industry' | 'sector' | 'similar' } or null
  async function findIndustryPeers(m, my, diag) {
    const cands = await gatherCandidates(m, diag);
    if (my !== loadSeq || !cands.length) return null;
    const sums = await pool(cands, 4, (c) => Yahoo.summary(c.symbol));
    if (my !== loadSeq) return null;
    diag.profiles = `${sums.filter((x) => x.ok).length}/${cands.length}`;
    const seen = new Set([norm(m.name)]);
    const rows = [];
    // .NS listings first so the NSE copy of a dual-listed company wins
    cands.map((c, i) => ({ c, s: sums[i] })).sort((a, b) => (/\.NS$/.test(b.c.symbol) ? 1 : 0) - (/\.NS$/.test(a.c.symbol) ? 1 : 0)).forEach(({ c, s }) => {
      if (!s.ok || marketOf(c.symbol) !== marketOf(m.symbol)) return;
      const S = A.parseSummary(s.v), pr = S.price || {}, ap = S.assetProfile || {};
      const nm = pr.longName || pr.shortName || c.name || c.symbol;
      const key = norm(nm); if (seen.has(key)) return; // same company listed twice
      const mc = rawNum(pr.marketCap) ?? c.marketCap;
      rows.push({ c, S, nm, key, mc, industry: ap.industry || '', sector: ap.sector || '', cur: pr.currency });
      seen.add(key);
    });
    let pick, level;
    const inInd = m.industry ? rows.filter((r) => sameText(r.industry, m.industry)) : [];
    const inSec = m.sector ? rows.filter((r) => !sameText(r.industry, m.industry) && sameText(r.sector, m.sector)) : [];
    diag.sameIndustry = inInd.length; diag.sameSector = inSec.length;
    if (inInd.length >= 3) { pick = inInd; level = 'industry'; }
    else if (inInd.length + inSec.length >= 3) { pick = [...inInd, ...inSec]; level = 'sector'; }
    else if (inInd.length >= 2) { pick = inInd; level = 'industry'; }
    else if (inInd.length + inSec.length >= 2) { pick = [...inInd, ...inSec]; level = 'sector'; }
    else if (!m.industry && !m.sector && rows.length >= 2) { pick = rows; level = 'similar'; }
    else return null;
    // Keep the 6 closest in size (same-industry names always come first)
    const gap = (r) => (isNum(r.mc) && isNum(m.marketCap) && r.mc > 0 && m.marketCap > 0 ? Math.abs(Math.log(r.mc / m.marketCap)) : 99);
    pick = pick.sort((a, b) => (level === 'sector' ? (sameText(b.industry, m.industry) - sameText(a.industry, m.industry)) : 0) || gap(a) - gap(b)).slice(0, 6);
    // Full models for each peer so every metric is computed exactly like the main company's
    const built = await pool(pick, 3, async (r) => {
      const [c5, c1, ts] = await Promise.allSettled([Yahoo.chart(r.c.symbol, '5y', '1wk'), Yahoo.chart(r.c.symbol, '1y', '1d'), Yahoo.timeseries(r.c.symbol)]);
      const val = (x) => (x.status === 'fulfilled' ? x.value : null);
      const sumRes = sums[cands.indexOf(r.c)].v;
      return A.buildModel(r.c.symbol, val(c5), val(c1), val(ts), sumRes, { name: r.nm });
    });
    if (my !== loadSeq) return null;
    // Peers that report or trade in another currency (e.g. a Japanese company's US listing) are kept: ratios and percentages are
    // comparable; only their money amounts are left out of the averages (see computeIndustryAvg).
    const models = built.filter((x) => x.ok).map((x) => x.v).filter((x) => x.hasFundamentals || isNum(x.marketCap));
    diag.peersBuilt = `${models.length}/${pick.length}`;
    if (models.length < 2) return null;
    return { models, level };
  }

  async function loadPeers(m, my) {
    const diag = {};
    const fail = (msg) => {
      if (my !== loadSeq) return;
      state.ind = null; state.peerCmp = null;
      const detail = Object.entries(diag).map(([k, v]) => `${k}: ${v}`).join(' · ');
      const hint = Object.values(diag).some((v) => /HTTP (400|403|404|405)/.test(String(v))) ? ' The peer-lookup request was refused — make sure the latest worker.js is deployed on Cloudflare.' : '';
      const w = $('#peerWrap'); if (w) w.innerHTML = `<div class="nodata"><div>${esc(msg)}${hint ? `<div class="diag">${esc(hint.trim())}</div>` : ''}${detail ? `<div class="diag">Lookup details — ${esc(detail)}</div>` : ''}</div></div>`;
      fillIndustryUI();
    };
    try {
      const found = await findIndustryPeers(m, my, diag);
      if (my !== loadSeq) return;
      console.info('[PLUTUS peers]', m.symbol, m.industry, diag);
      const where = countryName(marketOf(m.symbol));
      if (!found) return fail(m.industry ? `Couldn’t find enough peers for “${m.industry}”${where ? ' listed in ' + where : ' in the same market'} right now.` : 'Yahoo Finance has no industry information for this company.');
      state.ind = { models: found.models, level: found.level, n: found.models.length, avg: computeIndustryAvg(found.models) };
      fillIndustryUI();
      refreshIndustryCharts();
      const mainRow = A.peerRowFromModel(m, true);
      const peerRows = found.models.map((x) => { const r = A.peerRowFromModel(x, false); if (x.currency !== m.currency) r.marketCap = null; return r; });
      const cmp = A.peerCompare(mainRow, peerRows, m.isFinancial);
      state.peerCmp = cmp;
      renderPeers(m, cmp, found.level);
      const sw = $('#swWrap');
      if (sw && (cmp.strengths.length || cmp.weaknesses.length)) {
        const tag = (arr) => arr.map((x) => ({ ...x, peer: true }));
        sw.innerHTML = swCol('s', 'Strengths', [...m.strengths, ...tag(cmp.strengths)], 'good') + swCol('w', 'Weaknesses', [...m.weaknesses, ...tag(cmp.weaknesses)], 'bad');
      }
    } catch (e) { console.error(e); diag.error = e.message; fail('Couldn’t load industry peers (' + e.message + ').'); }
  }

  const fmtMetric = (mt, v, cur) => (!isNum(v) ? '—' : mt.fmt === 'pct' ? fmtPct(v, 1) : mt.fmt === 'x' ? fmtX(v, 1) : fmtMoney(v, cur));
  const shortSym = (s) => s.replace(/\.(NS|BO)$/, '');
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  function renderPeers(m, cmp, level) {
    const cur = m.currency, nPeers = cmp.rows.length - 1;
    const medal = (r) => (r == null ? '' : r === 1 ? 'gold' : r === 2 ? 'silver' : r === 3 ? 'bronze' : '');
    const tiles = cmp.ranks.map((r) => `
      <div class="rank-tile ${medal(r.rank)}">
        <div class="rt-name">${r.name}</div>
        <div class="rt-rank">${r.rank == null ? '—' : '#' + r.rank}<span>${r.rank == null ? 'no data' : 'of ' + r.of}</span></div>
        <div class="rt-val">${fmtMetric(r, r.value, cur)} <span class="muted">industry avg ${fmtMetric(r, r.avg, cur)}</span></div>
        <div class="rt-best">${r.best}: <b>${r.leader ? esc(r.leader.isMain ? 'This company' : clip(r.leader.name, 26)) : '—'}</b></div>
      </div>`).join('');
    const cols = A.PEER_METRICS.filter((mt) => !(m.isFinancial && mt.key === 'de'));
    const row = (r) => {
      const dom = domainOf(r.website);
      const cell = `<span class="pcell">${r.isMain ? '<span class="you">◉</span>' : ''}${logoHTML(dom, r.name, 'sm', r.symbol)}<span class="ptxt"><b>${esc(shortSym(r.symbol))}</b><span class="pname">${esc(r.name)}</span></span></span>`;
      return `<tr class="${r.isMain ? 'main' : ''}"><td>${r.isMain ? cell : `<a href="#/s/${encodeURIComponent(r.symbol)}">${cell}</a>`}</td>${cols.map((c) => `<td>${fmtMetric(c, r[c.key], cur)}</td>`).join('')}</tr>`;
    };
    const avgTr = `<tr class="avg"><td><span class="pcell"><span class="ptxt"><b>Industry average</b><span class="pname">${nPeers} industry peers</span></span></span></td>${cols.map((c) => `<td>${fmtMetric(c, cmp.avgRow[c.key], cur)}</td>`).join('')}</tr>`;
    const table = `<div class="peer-table-wrap"><table class="peer-table">
      <thead><tr><th>Company</th>${cols.map((c) => `<th>${c.label}</th>`).join('')}</tr></thead>
      <tbody>${cmp.rows.map(row).join('')}${avgTr}</tbody></table></div>
      <div class="scroll-hint">← Swipe the table to see all columns →</div>`;
    const btns = cols.filter((c) => c.key !== 'marketCap').map((c, i) => `<button data-k="${c.key}" class="${i === 0 ? 'on' : ''}">${c.name.toUpperCase()}</button>`).join('');
    const cn = countryName(marketOf(m.symbol)), where = cn ? ` listed in <b>${esc(cn)}</b>` : ' listed in the same market';
    const intro = level === 'industry'
      ? `Compared with <b>${nPeers}</b> companies${where} in the same industry — <b>${esc(m.industry)}</b> — chosen for being closest in size.`
      : level === 'sector'
        ? `Few or no other companies${where} share its exact industry (<b>${esc(m.industry)}</b>), so the peer group is drawn from the wider sector — <b>${esc(m.sector)}</b> — with same-industry names first. All peers are${where}.`
        : `Yahoo Finance doesn’t label this company’s industry, so these are similar companies suggested by Yahoo.`;
    $('#peerWrap').innerHTML = `
      <p class="peer-intro">${intro} The <b>industry average</b> is the simple average of these peers. <b>#1</b> means best in the group on that measure (for Debt and P/E, lowest counts as #1). Medals are facts, not recommendations.</p>
      <div class="rank-grid">${tiles}</div>
      <div class="chart-card wide peer-chart">
        <h3>Head to Head<div class="toggle" id="peerToggle">${btns}</div></h3>
        <div class="chart-box" id="box-chPeer"><canvas id="chPeer"></canvas></div>
      </div>
      ${table}`;
    const draw = (key) => {
      resetBox('chPeer');
      const mt = A.PEER_METRICS.find((x) => x.key === key);
      const rows = [...cmp.rows, ...(isNum(cmp.avgRow[key]) ? [cmp.avgRow] : [])].filter((r) => isNum(r[key]))
        .sort((a, b) => (mt.better === 'high' ? b[key] - a[key] : a[key] - b[key]));
      if (!rows.length) return noData('chPeer');
      const val = (v) => (mt.fmt === 'pct' ? +(v * 100).toFixed(2) : +v.toFixed(2));
      const unit = mt.fmt === 'pct' ? '%' : '×';
      const bg = (r) => (r.isMain ? '#3ea6ff' : r.isAvg ? '#9d8cff' : '#262b34');
      mk('chPeer', { type: 'bar',
        data: { labels: rows.map((r) => (r.isAvg ? 'Industry average' : clip(r.name, isMobile() ? 16 : 28))), datasets: [{ label: mt.label, data: rows.map((r) => val(r[key])),
          backgroundColor: rows.map(bg), borderColor: rows.map((r) => (r.isMain ? '#3ea6ff' : r.isAvg ? '#9d8cff' : '#3a404b')), borderWidth: 1, borderRadius: 2, maxBarThickness: 26 }] },
        options: { indexAxis: 'y', plugins: { legend: { display: false }, tooltip: { callbacks: { label: (x) => `${mt.label}: ${x.parsed.x}${unit}` } } },
          scales: { x: { ticks: { maxTicksLimit: isMobile() ? 4 : 8, callback: (v) => v + unit } }, y: { grid: { display: false }, ticks: { color: '#eef0f3', autoSkip: false } } } } });
    };
    draw(cols.find((c) => c.key !== 'marketCap').key);
    window.__plutusPeerRedraw = () => { const on = $('#peerToggle button.on'); if (on && $('#box-chPeer')) draw(on.dataset.k); };
    $('#peerToggle').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; $('#peerToggle').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); draw(b.dataset.k); });
  }

  /* ---------- charts ---------- */
  function destroyCharts() { state.charts.forEach((c) => c.destroy()); state.charts = []; }
  function setupChartDefaults() {
    if (!window.Chart) return;
    const mob = isMobile();
    Chart.defaults.color = '#7f8692';
    Chart.defaults.font.family = '"Helvetica Neue", Helvetica, Arial, sans-serif';
    Chart.defaults.font.size = mob ? 10 : 11;
    Chart.defaults.borderColor = '#14171d';
    Chart.defaults.plugins.legend.position = 'top';
    Chart.defaults.plugins.legend.labels.boxWidth = 10;
    Chart.defaults.plugins.legend.labels.boxHeight = 10;
    Chart.defaults.plugins.legend.labels.padding = mob ? 8 : 12;
    Chart.defaults.plugins.tooltip.backgroundColor = '#0b0e13';
    Chart.defaults.plugins.tooltip.borderColor = '#3ea6ff';
    Chart.defaults.plugins.tooltip.borderWidth = 1;
    Chart.defaults.plugins.tooltip.padding = 10;
    Chart.defaults.maintainAspectRatio = false;
    Chart.defaults.responsive = true;
  }
  const grad = (hex, a1 = 0.35) => (ctx) => {
    const { chart } = ctx; const { ctx: g, chartArea } = chart;
    if (!chartArea) return 'transparent';
    const gr = g.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
    gr.addColorStop(0, hex + Math.round(a1 * 255).toString(16).padStart(2, '0')); gr.addColorStop(1, hex + '00');
    return gr;
  };
  const dLabel = (t, withDay) => new Date(t).toLocaleDateString('en-GB', withDay ? { day: '2-digit', month: 'short', year: '2-digit' } : { month: 'short', year: '2-digit' });
  function resetBox(id) {
    const old = state.charts.find((x) => x.canvas && x.canvas.id === id);
    if (old) { old.destroy(); state.charts = state.charts.filter((x) => x !== old); }
    const box = document.getElementById('box-' + id); if (box) box.innerHTML = `<canvas id="${id}"></canvas>`;
  }
  function setTake(id, text) { const el = document.getElementById('tk-' + id); if (!el) return; el.textContent = text || ''; el.classList.toggle('hidden', !text); }
  function noData(id, msg) {
    const cv = document.getElementById(id); if (!cv) return;
    cv.parentElement.innerHTML = `<div class="nodata">${esc(msg || 'No data available')}</div>`;
  }
  function mk(id, cfg) {
    const cv = document.getElementById(id); if (!cv || !window.Chart) return null;
    const ch = new Chart(cv, cfg); state.charts.push(ch); return ch;
  }
  const anyNum = (arr) => (arr || []).some(isNum);
  const findChart = (id) => state.charts.find((c) => c.canvas && c.canvas.id === id);

  // Industry-average overlay on the P/E chart (added once the peers have loaded)
  const peIndDataset = (len, v) => ({ label: 'Industry avg P/E', data: Array.from({ length: len }, () => +v.toFixed(2)), borderColor: '#2ee6a6', borderDash: [2, 4], borderWidth: 1.3, pointRadius: 0, isInd: true });
  function refreshIndustryCharts() {
    const ind = state.ind, m = state.model; if (!ind || !m) return;
    const pe = findChart('chPE');
    if (pe && isNum(ind.avg.pe) && !pe.data.datasets.some((d) => d.isInd)) { pe.data.datasets.push(peIndDataset(pe.data.labels.length, ind.avg.pe)); pe.update(); }
    const on = $('#periodToggle button.on'); drawBusiness(m, on ? on.dataset.p : 'annual');
  }

  function drawCharts(m) {
    setupChartDefaults();
    const pc = m.currency, mob = isMobile();
    const hasInd = !!state.ind;
    // Price
    const drawPrice = (range) => {
      resetBox('chPrice');
      const pts = range === '1y' ? m.priceDaily : m.priceWeekly;
      if (!pts.length) return noData('chPrice');
      const up = pts[pts.length - 1].v >= pts[0].v, col = up ? '#2ee6a6' : '#ff5a6e';
      mk('chPrice', {
        type: 'line',
        data: { labels: pts.map((p) => dLabel(p.t, range === '1y')), datasets: [{ label: 'Price', data: pts.map((p) => p.v), borderColor: col, backgroundColor: grad(col, 0.28), fill: true, borderWidth: 1.6, pointRadius: 0, tension: 0.15 }] },
        options: { interaction: { mode: 'index', intersect: false }, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (x) => fmtPrice(x.parsed.y, pc) } } },
          scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: mob ? 4 : 8, maxRotation: 0 } }, y: { position: 'right', ticks: { maxTicksLimit: mob ? 5 : 8, callback: (v) => fmtPrice(v, pc).replace(/\.00$/, '') } } } }
      });
    };
    drawPrice('5y');
    const tg = $('#priceToggle');
    if (tg) tg.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; tg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); drawPrice(b.dataset.r); });
    // P/E history
    if (m.peHistory.length > 5) {
      const ph = m.peHistory;
      mk('chPE', { type: 'line',
        data: { labels: ph.map((p) => dLabel(p.t)), datasets: [
          { label: 'P/E', data: ph.map((p) => +p.v.toFixed(2)), borderColor: '#9d8cff', backgroundColor: grad('#9d8cff', 0.22), fill: true, borderWidth: 1.6, pointRadius: 0, tension: 0.15 },
          { label: '5-yr median', data: ph.map(() => +m.peMedian.toFixed(2)), borderColor: '#ffc857', borderDash: [6, 6], borderWidth: 1, pointRadius: 0 },
          ...(hasInd && isNum(state.ind.avg.pe) ? [peIndDataset(ph.length, state.ind.avg.pe)] : [])] },
        options: { interaction: { mode: 'index', intersect: false }, plugins: { tooltip: { callbacks: { label: (x) => `${x.dataset.label}: ${x.parsed.y.toFixed(1)}×` } } },
          scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: mob ? 4 : 8, maxRotation: 0 } }, y: { position: 'right', ticks: { maxTicksLimit: mob ? 5 : 8, callback: (v) => v + '×' } } } } });
    } else noData('chPE', m.negEarnings ? 'Not meaningful — company has losses' : !m.sameCur ? 'Hidden — currency mismatch' : 'Not enough earnings history');

    drawBusiness(m, 'annual');
    const pt = $('#periodToggle');
    if (pt) pt.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      pt.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      drawBusiness(m, b.dataset.p);
    });
  }

  function quarterTakeaways(m) {
    const q = m.quarterly, t = {}, c = m.finCurrency, n = q.revenue.length;
    const yoy = (arr) => (n >= 5 && isNum(arr[n - 1]) && isNum(arr[n - 5]) && arr[n - 5] > 0 ? arr[n - 1] / arr[n - 5] - 1 : null);
    if (n) {
      const rg = yoy(q.revenue), ng = yoy(q.netIncome);
      t.revenue = `Latest quarter (${q.labels[n - 1]}): revenue ${fmtMoney(q.revenue[n - 1], c)}, net profit ${fmtMoney(q.netIncome[n - 1], c)}` +
        (isNum(rg) ? ` · revenue ${fmtPct(rg, 1, true)} vs same quarter last year` : '') + (isNum(ng) ? `, profit ${fmtPct(ng, 1, true)}` : '') + '.';
      if (isNum(q.netMarginS[n - 1])) t.margins = `Net margin in the latest quarter: ${fmtPct(q.netMarginS[n - 1])}${n >= 5 && isNum(q.netMarginS[n - 5]) ? ` (same quarter last year ${fmtPct(q.netMarginS[n - 5])})` : ''}.`;
      if (isNum(q.eps[n - 1])) t.eps = `Latest quarterly EPS: ${q.eps[n - 1].toFixed(2)} ${c}${n >= 5 && isNum(q.eps[n - 5]) ? ` vs ${q.eps[n - 5].toFixed(2)} a year earlier` : ''}.`;
    }
    t.cash = anyNum(q.ocf) ? '' : 'Many companies (including most Indian listings) publish cash flow only half-yearly or yearly — switch to Yearly.';
    t.debt = anyNum(q.debt) ? '' : 'Quarterly balance-sheet data isn’t published for this company — switch to Yearly.';
    return t;
  }

  function drawBusiness(m, period) {
    const c = m.finCurrency, mob = isMobile();
    const D = period === 'quarterly' ? m.quarterly : m.annual, L = D.labels;
    const moneyTick = { maxTicksLimit: mob ? 5 : 7, callback: (v) => fmtMoney(v, c) };
    const moneyTip = { callbacks: { label: (x) => `${x.dataset.label}: ${fmtMoney(x.parsed.y, c)}` } };
    const xs = { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true } };
    const bar = mob ? 18 : 34;
    ['chRev', 'chMargin', 'chEPS', 'chCash', 'chDebt'].forEach(resetBox);
    const note = $('#periodNote');
    if (note) note.textContent = period === 'quarterly' ? `Quarterly · last ${L.length} reported quarters` : `Yearly · last ${L.length} financial years`;
    const T = period === 'quarterly' ? quarterTakeaways(m) : m.takeaways;
    setTake('chRev', T.revenue); setTake('chMargin', T.margins); setTake('chEPS', T.eps); setTake('chCash', T.cash); setTake('chDebt', T.debt);
    const nd = period === 'quarterly' ? 'No quarterly data published' : 'No data available';
    const negCol = (arr, pos) => arr.map((v) => (isNum(v) && v < 0 ? '#ff5a6e' : pos));

    if (anyNum(D.revenue) || anyNum(D.netIncome)) mk('chRev', { type: 'bar',
      data: { labels: L, datasets: [
        { label: 'Revenue', data: D.revenue, backgroundColor: '#3ea6ff', borderRadius: 2, maxBarThickness: bar },
        { label: 'Net Profit', data: D.netIncome, backgroundColor: negCol(D.netIncome, '#2ee6a6'), borderRadius: 2, maxBarThickness: bar }] },
      options: { plugins: { tooltip: moneyTip }, scales: { x: xs, y: { ticks: moneyTick } } } });
    else noData('chRev', nd);

    const pctData = (arr) => arr.map((v) => (isNum(v) ? +(v * 100).toFixed(2) : null));
    const mSets = [['Gross', D.grossMarginS, '#9d8cff'], ['Operating', D.opMarginS, '#3ea6ff'], ['Net', D.netMarginS, '#2ee6a6']]
      .filter(([, a]) => anyNum(a)).map(([l, a, col]) => ({ label: l, data: pctData(a), borderColor: col, backgroundColor: col, borderWidth: 2, pointRadius: mob ? 2 : 3, tension: 0.25, spanGaps: true }));
    if (state.ind && period === 'annual' && isNum(state.ind.avg.nm) && mSets.length) {
      mSets.push({ label: 'Industry net margin', data: L.map(() => +(state.ind.avg.nm * 100).toFixed(2)), borderColor: '#ffffff', borderDash: [5, 5], borderWidth: 1, pointRadius: 0 });
    }
    if (mSets.length) mk('chMargin', { type: 'line', data: { labels: L, datasets: mSets },
      options: { plugins: { tooltip: { callbacks: { label: (x) => `${x.dataset.label}: ${x.parsed.y.toFixed(1)}%` } } }, scales: { x: xs, y: { ticks: { maxTicksLimit: 6, callback: (v) => v + '%' } } } } });
    else noData('chMargin', nd);

    if (anyNum(D.eps)) mk('chEPS', { type: 'bar',
      data: { labels: L, datasets: [{ label: 'EPS (' + c + ')', data: D.eps, backgroundColor: negCol(D.eps, '#9d8cff'), borderRadius: 2, maxBarThickness: mob ? 24 : 40 }] },
      options: { plugins: { legend: { display: false } }, scales: { x: xs, y: { ticks: { maxTicksLimit: 6 } } } } });
    else noData('chEPS', nd);

    if (anyNum(D.ocf) || anyNum(D.fcf)) mk('chCash', { type: 'bar',
      data: { labels: L, datasets: [
        { label: 'Operating Cash Flow', data: D.ocf, backgroundColor: '#3ea6ff', borderRadius: 2, maxBarThickness: bar },
        { label: 'Free Cash Flow', data: D.fcf, backgroundColor: negCol(D.fcf, '#2ee6a6'), borderRadius: 2, maxBarThickness: bar }] },
      options: { plugins: { tooltip: moneyTip }, scales: { x: xs, y: { ticks: moneyTick } } } });
    else noData('chCash', nd);

    // Debt vs Equity: this card is full-width, so with a fixed max bar width Chart.js would centre each bar in a much
    // wider slot and leave a big gap between the pair. Sizing the group to the bar width keeps the two bars side by
    // side, exactly like Revenue vs Net Profit.
    if (anyNum(D.debt) || anyNum(D.equity)) {
      const boxW = (document.getElementById('box-chDebt') || {}).clientWidth || 600;
      const slot = Math.max(40, (boxW - 70) / Math.max(1, L.length));
      const barPct = 0.9;
      const catPct = Math.min(0.8, Math.max(0.2, (2 * bar) / (barPct * slot)));
      mk('chDebt', { type: 'bar',
        data: { labels: L, datasets: [
          { label: 'Total Debt', data: D.debt, backgroundColor: '#ff5a6e', borderRadius: 2, maxBarThickness: bar, barPercentage: barPct, categoryPercentage: catPct },
          { label: 'Shareholders’ Equity', data: D.equity, backgroundColor: '#2ee6a6', borderRadius: 2, maxBarThickness: bar, barPercentage: barPct, categoryPercentage: catPct }] },
        options: { plugins: { tooltip: moneyTip }, scales: { x: xs, y: { ticks: moneyTick } } } });
    } else noData('chDebt', nd);
  }

  // Redraw charts when crossing the mobile/desktop breakpoint (rotation, window resize)
  let lastMob = null, rT = null;
  window.addEventListener('resize', () => {
    clearTimeout(rT);
    rT = setTimeout(() => {
      const mob = isMobile();
      if (lastMob !== null && mob !== lastMob && state.model && !$('#dashContent').classList.contains('hidden')) {
        destroyCharts(); drawCharts(state.model);
        const pt = $('#periodToggle'); if (pt) pt.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', i === 0));
        const tg = $('#priceToggle'); if (tg) tg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.r === '5y'));
        if (window.__plutusPeerRedraw) window.__plutusPeerRedraw();
      }
      lastMob = mob;
    }, 200);
  });

  /* ====================== INIT ====================== */
  function init() {
    lastMob = isMobile();
    attachSearch($('#mainSearch'), $('#mainSuggest'));
    attachSearch($('#miniSearch'), $('#miniSuggest'));
    $('#quickChips').addEventListener('click', (e) => { const b = e.target.closest('button[data-s]'); if (b) location.hash = '#/s/' + encodeURIComponent(b.dataset.s); });
    window.addEventListener('hashchange', route);
    route();
  }
  document.addEventListener('DOMContentLoaded', init);
})();

/* ============================================================
   PLUTUS — "Latest In News" sidebar (self-contained add-on)
   ------------------------------------------------------------
   Shows the 5 latest headlines for the stock being viewed:
     - company headlines come first (newest first);
     - if the company has fewer than 5, the remaining slots are filled
       with the latest headlines about its INDUSTRY.
   Headlines come from Yahoo Finance's search endpoint through the same
   Cloudflare Worker the rest of the site uses (no Worker change needed).
   It reads the stock from the page address (#/s/SYMBOL), so it does not
   depend on any other PLUTUS script.
   ============================================================ */
(function () {
  'use strict';

  const CFG = window.APP_CONFIG || {};
  const TOTAL = 5;              // headlines shown in total (company first, then industry fills any gap)
  const FETCH_COUNT = 15;       // fetched per query, then sorted by time and trimmed
  const CACHE_MS = 10 * 60e3;   // browser-side cache per query
  const YH = 'https://query2.finance.yahoo.com';

  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------- where is the company listed? (used to keep industry news local) ---------- */
  const MARKETS = {
    NS: 'India', BO: 'India', L: 'United Kingdom', T: 'Japan', HK: 'Hong Kong', DE: 'Germany', F: 'Germany', TO: 'Canada', V: 'Canada',
    AX: 'Australia', PA: 'France', MI: 'Italy', MC: 'Spain', AS: 'Netherlands', SW: 'Switzerland', ST: 'Sweden', SS: 'China', SZ: 'China',
    KS: 'South Korea', TW: 'Taiwan', SI: 'Singapore', SA: 'Brazil', JO: 'South Africa'
  };
  const listingCountry = (sym) => { const i = sym.lastIndexOf('.'); return i < 0 ? '' : (MARKETS[sym.slice(i + 1).toUpperCase()] || ''); }; // '' = US / unknown
  const regionOf = (sym) => (/\.(NS|BO)$/i.test(sym) ? { region: 'IN', lang: 'en-IN' } : { region: 'US', lang: 'en-US' });

  /* ---------- data ---------- */
  async function getJSON(url) {
    const key = 'plutus:news:' + url;
    try { const c = JSON.parse(sessionStorage.getItem(key)); if (c && Date.now() - c.t < CACHE_MS) return c.d; } catch (e) { /* ignore */ }
    const routes = CFG.WORKER_URL
      ? [CFG.WORKER_URL.replace(/\/+$/, '') + '/?url=' + encodeURIComponent(url)]
      : (CFG.PUBLIC_PROXIES || []).map((p) => p + encodeURIComponent(url));
    let lastErr = new Error('No data route configured');
    for (const r of routes) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), CFG.REQUEST_TIMEOUT_MS || 15000);
        try {
          const res = await fetch(r, { signal: ctrl.signal });
          if (!res.ok) { const er = new Error('HTTP ' + res.status); er.retry = res.status === 429 || res.status >= 500; throw er; }
          const d = await res.json();
          try { sessionStorage.setItem(key, JSON.stringify({ t: Date.now(), d })); } catch (e) { /* quota */ }
          return d;
        } catch (e) {
          lastErr = e;
          if (!(e.retry || e.name === 'AbortError' || e instanceof TypeError)) break;
          await sleep(700);
        } finally { clearTimeout(timer); }
      }
    }
    throw lastErr;
  }

  const toMs = (t) => (typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : 0);
  function pickThumb(n) {
    const rs = n && n.thumbnail && Array.isArray(n.thumbnail.resolutions) ? n.thumbnail.resolutions.filter((x) => x && x.url) : [];
    if (!rs.length) return '';
    const small = rs.filter((x) => (x.width || 0) >= 100).sort((a, b) => (a.width || 0) - (b.width || 0))[0];
    return (small || rs[0]).url;
  }
  const normTitle = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  function parseNews(res) {
    const arr = (res && Array.isArray(res.news)) ? res.news : [];
    return arr.filter((n) => n && n.title && /^https?:\/\//i.test(n.link || ''))
      .map((n) => ({ id: n.uuid || n.link, title: String(n.title), link: n.link, publisher: n.publisher || '', time: toMs(n.providerPublishTime), img: pickThumb(n) }));
  }
  // Merge lists, drop duplicates (same link or same headline), newest first
  function mergeNews(lists, exclude) {
    const seen = new Set((exclude || []).flatMap((x) => [x.id, normTitle(x.title)]));
    const out = [];
    for (const it of lists.flat().sort((a, b) => b.time - a.time)) {
      const k = normTitle(it.title);
      if (seen.has(it.id) || seen.has(k)) continue;
      seen.add(it.id); seen.add(k); out.push(it);
    }
    return out;
  }
  const searchNews = (q, sym) => {
    const { region, lang } = regionOf(sym);
    return getJSON(`${YH}/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=0&newsCount=${FETCH_COUNT}&listsCount=0&enableFuzzyQuery=false&region=${region}&lang=${lang}`).then(parseNews);
  };
  const profileOf = (sym) => getJSON(`${YH}/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=price,assetProfile`).then((r) => {
    const s = (r && r.quoteSummary && r.quoteSummary.result && r.quoteSummary.result[0]) || {};
    const pr = s.price || {}, ap = s.assetProfile || {};
    return { name: pr.longName || pr.shortName || '', industry: ap.industry || '', sector: ap.sector || '' };
  });
  // "Banks - Regional" -> "Banks Regional industry India"
  const industryQuery = (industry, country) => `${industry.replace(/[&\-\u2013\u2014/,]+/g, ' ').replace(/\s+/g, ' ').trim()} industry${country ? ' ' + country : ''}`;

  /* ---------- display ---------- */
  function ago(ms) {
    if (!ms) return '';
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    if (s < 7 * 86400) return Math.round(s / 86400) + ' d ago';
    return new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
  }
  const itemHTML = (n) => `<li><a class="news-item" href="${esc(n.link)}" target="_blank" rel="noopener noreferrer">
      <span class="ni-txt"><span class="ni-title">${esc(n.title)}</span>
        <span class="ni-meta"><span class="ni-tag ni-tag-${n.kind}">${n.kind === 'co' ? 'Company' : 'Industry'}</span>${n.publisher ? `<span class="ni-pub">${esc(n.publisher)}</span>` : ''}${n.time ? `<span class="ni-time">${esc(ago(n.time))}</span>` : ''}</span></span>
      ${n.img ? `<span class="ni-img"><img src="${esc(n.img)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer"></span>` : ''}
    </a></li>`;
  const skelItems = (n) => Array.from({ length: Math.max(0, n) }, () => '<li class="news-skel"><span></span><span></span></li>').join('');

  // items: headlines to show; pending: how many placeholder rows to add below them; note: optional message under the list
  function render(items, pending, note, retry) {
    const body = $('#newsBody'); if (!body) return;
    const list = items.length || pending ? `<ul class="news-list">${items.map(itemHTML).join('')}${skelItems(pending || 0)}</ul>` : '';
    body.innerHTML = list + (note ? `<p class="news-empty">${esc(note)}</p>` : '') + (retry ? '<button type="button" class="news-retry" data-retry="1">Try again</button>' : '');
  }
  function setSub(text) { const el = $('#newsSub'); if (el) el.textContent = text || ''; }

  /* ---------- controller ---------- */
  let seq = 0, current = '';
  async function load(sym) {
    const my = ++seq; current = sym;
    if (!$('#newsBody')) return;
    const country = listingCountry(sym);
    setSub(sym);
    render([], TOTAL);

    // company headlines by ticker; the company profile (name, industry) is fetched in parallel
    const byTicker = searchNews(sym, sym);
    const prof = profileOf(sym).catch(() => ({ name: '', industry: '', sector: '' }));
    let company = [], companyFailed = false;
    try { company = mergeNews([await byTicker]); } catch (e) { companyFailed = true; }
    if (my !== seq) return;
    if (company.length < TOTAL) { // thin ticker coverage: top up with a search by company name
      const p = await prof; if (my !== seq) return;
      if (p.name) {
        try { company = mergeNews([company, await searchNews(p.name, sym)]); companyFailed = false; } catch (e) { /* keep what we have */ }
        if (my !== seq) return;
      }
    }
    company = company.slice(0, TOTAL).map((x) => ({ ...x, kind: 'co' }));
    const p = await prof; if (my !== seq) return;
    const coName = p.name || sym;
    const need = TOTAL - company.length;
    if (need <= 0) { setSub(coName); render(company, 0); return; } // company alone fills all 5 slots: no industry request needed

    // fewer than 5 company headlines: show them now, keep placeholders for the rest, then fill with industry news
    setSub(coName);
    render(company, need);
    const label = p.industry || p.sector;
    if (!label) { render(company, 0, company.length ? 'Industry information isn\u2019t available to fill the remaining slots.' : 'No recent headlines found for this company.', companyFailed); return; }
    let lists = [], indFailed = false, shown = label;
    try { lists.push(await searchNews(industryQuery(label, country), sym)); } catch (e) { indFailed = true; }
    if (my !== seq) return;
    if (!lists.flat().length && p.industry && p.sector) { // nothing for the exact industry: widen to the sector
      try { lists = [await searchNews(industryQuery(p.sector, country), sym)]; shown = p.sector; indFailed = false; } catch (e) { /* keep failed flag */ }
      if (my !== seq) return;
    }
    const fill = mergeNews(lists, company).slice(0, need).map((x) => ({ ...x, kind: 'ind' }));
    const all = company.concat(fill);
    if (fill.length) setSub(`${coName} + ${shown} industry${country ? ' \u00b7 ' + country : ''}`);
    const failed = indFailed || (companyFailed && !company.length);
    render(all, 0, !all.length ? (failed ? 'News is unavailable right now.' : 'No recent headlines found.') : (failed && all.length < TOTAL ? 'Some headlines couldn\u2019t be loaded.' : ''), failed && all.length < TOTAL);
  }

  /* ---------- mount + routing ---------- */
  function mount() {
    const view = $('#viewDash');
    if (!view || $('#newsSide')) return;
    view.classList.add('has-news');
    view.insertAdjacentHTML('beforeend', `<aside class="news" id="newsSide" aria-label="Latest in news">
        <div class="news-head"><span class="news-dot" aria-hidden="true"></span><h2>Latest In News</h2></div>
        <p class="news-sub" id="newsSub"></p>
        <div class="news-body" id="newsBody"></div>
        <p class="news-foot">Company headlines first; industry headlines fill any remaining slots. Via Yahoo Finance. Links open the publisher\u2019s site. Not investment advice.</p>
      </aside>`);
    $('#newsSide').addEventListener('click', (e) => { if (e.target.closest('[data-retry]') && current) load(current); });
    // broken thumbnails: just remove the picture
    $('#newsSide').addEventListener('error', (e) => { if (e.target instanceof HTMLImageElement) { const w = e.target.closest('.ni-img'); if (w) w.remove(); } }, true);
  }
  function route() {
    const m = location.hash.match(/^#\/s\/(.+)$/);
    if (!m) { seq++; current = ''; return; }
    load(decodeURIComponent(m[1]).toUpperCase());
  }
  function init() { mount(); window.addEventListener('hashchange', route); route(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();

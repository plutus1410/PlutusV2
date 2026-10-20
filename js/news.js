/* ============================================================
   PLUTUS — "Latest In News" sidebar (self-contained add-on)
   ------------------------------------------------------------
   Shows the 5 latest headlines for the stock being viewed:
     - company headlines come first (newest first);
     - if the company has fewer than 5, the remaining slots are filled
       with the latest headlines about its INDUSTRY.
   v5: headlines come from Bing News RSS (free, no API key) through the
   same Cloudflare Worker. Each headline gets a thumbnail:
     1) the picture supplied by the feed itself, else
     2) the article's own og:image, fetched by the Worker (?og=...).
   The company name / industry (used only to build the search words)
   still come from the Yahoo profile lookup already used by the site.
   It reads the stock from the page address (#/s/SYMBOL).
   ============================================================ */
(function () {
  'use strict';
  const CFG = window.APP_CONFIG || {};
  const TOTAL = 5;              // headlines shown in total (company first, then industry fills any gap)
  const FETCH_COUNT = 15;       // asked of Bing per query (Bing returns about 10-14), then sorted by time and trimmed
  const CACHE_MS = 10 * 60e3;   // browser-side cache per query
  const YH = 'https://query2.finance.yahoo.com';
  const BING = 'https://www.bing.com/news/search';
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const workerBase = () => (CFG.WORKER_URL || '').replace(/\/+$/, '');

  /* ---------- where is the company listed? (used to keep industry news local) ---------- */
  const MARKETS = {
    NS: 'India', BO: 'India', L: 'United Kingdom', T: 'Japan', HK: 'Hong Kong', DE: 'Germany', F: 'Germany', TO: 'Canada', V: 'Canada',
    AX: 'Australia', PA: 'France', MI: 'Italy', MC: 'Spain', AS: 'Netherlands', SW: 'Switzerland', ST: 'Sweden', SS: 'China', SZ: 'China',
    KS: 'South Korea', TW: 'Taiwan', SI: 'Singapore', SA: 'Brazil', JO: 'South Africa'
  };
  const listingCountry = (sym) => { const i = sym.lastIndexOf('.'); return i < 0 ? '' : (MARKETS[sym.slice(i + 1).toUpperCase()] || ''); }; // '' = US / unknown
  const isIndia = (sym) => /\.(NS|BO)$/i.test(sym);
  const baseTicker = (sym) => sym.replace(/\.[A-Za-z]+$/, '');
  const marketOf = (sym) => (isIndia(sym) ? 'en-IN' : 'en-US');

  /* ---------- data ---------- */
  // Fetch through the Worker (or the public CORS proxies if no Worker is set); text = true for RSS/XML
  async function getData(url, text) {
    const key = 'plutus:news:' + (text ? 't:' : 'j:') + url;
    try { const c = JSON.parse(sessionStorage.getItem(key)); if (c && Date.now() - c.t < CACHE_MS) return c.d; } catch (e) { /* ignore */ }
    const routes = CFG.WORKER_URL
      ? [workerBase() + '/?url=' + encodeURIComponent(url)]
      : (CFG.PUBLIC_PROXIES || []).map((p) => p + encodeURIComponent(url));
    let lastErr = new Error('No data route configured');
    for (const r of routes) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), CFG.REQUEST_TIMEOUT_MS || 15000);
        try {
          const res = await fetch(r, { signal: ctrl.signal });
          if (!res.ok) { const er = new Error('HTTP ' + res.status); er.retry = res.status === 429 || res.status >= 500; throw er; }
          const d = text ? await res.text() : await res.json();
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

  const normTitle = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  // Bing wraps every link: bing.com/news/apiclick.aspx?...&url=<publisher link>. Unwrap to the real article address.
  function realLink(l) {
    try {
      const u = new URL(l);
      if (/(^|\.)bing\.com$/i.test(u.hostname)) {
        const t = u.searchParams.get('url');
        if (t && /^https?:\/\//i.test(t)) return t;
      }
    } catch (e) { /* keep as is */ }
    return l;
  }
  function fixImg(s) {
    s = String(s || '').trim();
    if (!s) return '';
    if (s.startsWith('//')) s = 'https:' + s;
    else if (s.startsWith('/')) s = 'https://www.bing.com' + s;
    return /^https?:\/\//i.test(s) ? s.replace(/^http:\/\//i, 'https://') : '';
  }
  // Bing News RSS -> [{ id, title, link, publisher, time, img }]
  function parseNews(xml) {
    if (!xml || xml.indexOf('<item') < 0) return [];
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    if (doc.querySelector('parsererror')) return [];
    return Array.from(doc.querySelectorAll('item')).map((it) => {
      const txt = (name, local) => {
        const e = it.getElementsByTagName(name)[0] || (local && it.getElementsByTagNameNS('*', local)[0]);
        return e ? (e.textContent || '').trim() : '';
      };
      const enc = it.getElementsByTagName('enclosure')[0];
      const link = realLink(txt('link'));
      const pub = Date.parse(txt('pubDate'));
      return {
        id: link, title: txt('title'), link,
        publisher: txt('News:Source', 'Source'),
        time: isFinite(pub) ? pub : 0,
        img: fixImg(txt('News:Image', 'Image') || (enc && enc.getAttribute('url')))
      };
    }).filter((n) => n.title && /^https?:\/\//i.test(n.link));
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
  const searchNews = (q, sym) =>
    getData(`${BING}?q=${encodeURIComponent(q)}&format=rss&setmkt=${marketOf(sym)}&count=${FETCH_COUNT}&qft=${encodeURIComponent('sortbydate="1"')}`, true).then(parseNews);

  const profileOf = (sym) => getData(`${YH}/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=price,assetProfile`).then((r) => {
    const s = (r && r.quoteSummary && r.quoteSummary.result && r.quoteSummary.result[0]) || {};
    const pr = s.price || {}, ap = s.assetProfile || {};
    return { name: pr.longName || pr.shortName || '', industry: ap.industry || '', sector: ap.sector || '' };
  });

  // ---- search words ----
  const stripLegal = (n) => String(n || '').replace(/\b(limited|ltd|incorporated|inc|corporation|corp|plc|company|co|pvt|private|llc|ag|nv)\b\.?/gi, ' ').replace(/[.,]+/g, ' ').replace(/\s+/g, ' ').trim();
  const companyQuery = (name, sym) => (stripLegal(name) ? `"${stripLegal(name)}" ${isIndia(sym) ? 'shares' : 'stock'}` : tickerQuery(sym));
  const tickerQuery = (sym) => `${baseTicker(sym)} ${isIndia(sym) ? 'share price' : 'stock'}`;
  // "Banks - Regional" -> "Banks Regional industry India"
  const industryQuery = (industry, country) => `${industry.replace(/[&\-\u2013\u2014/,]+/g, ' ').replace(/\s+/g, ' ').trim()} industry${country ? ' ' + country : ''}`;

  /* ---------- thumbnails ---------- */
  // Ask the Worker for the article's own picture (og:image). Cached in the browser; "" = none found.
  async function ogImage(link) {
    if (!workerBase()) return '';
    const key = 'plutus:og:' + link;
    try { const c = JSON.parse(sessionStorage.getItem(key)); if (c && typeof c.d === 'string') return c.d; } catch (e) { /* ignore */ }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 9000);
    try {
      const res = await fetch(workerBase() + '/?og=' + encodeURIComponent(link), { signal: ctrl.signal });
      if (!res.ok) return '';
      const d = await res.json();
      const img = fixImg(d && d.image);
      try { sessionStorage.setItem(key, JSON.stringify({ d: img })); } catch (e) { /* quota */ }
      return img;
    } catch (e) { return ''; } finally { clearTimeout(timer); }
  }
  const thumbHTML = (src) => `<span class="ni-img"><img src="${esc(src)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer"></span>`;
  // After the list is drawn, add pictures to the rows that came without one
  function backfillThumbs(items) {
    const mySeq = seq;
    items.filter((n) => !n.img && !n.imgTried).forEach(async (n) => {
      n.imgTried = true;
      const img = await ogImage(n.link);
      if (!img || mySeq !== seq) return;
      n.img = img;
      const a = Array.from(document.querySelectorAll('#newsBody a.news-item')).find((el) => el.dataset.id === n.id);
      if (a && !a.querySelector('.ni-img')) a.insertAdjacentHTML('beforeend', thumbHTML(img));
    });
  }

  /* ---------- display ---------- */
  function ago(ms) {
    if (!ms) return '';
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    if (s < 7 * 86400) return Math.round(s / 86400) + ' d ago';
    return new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
  }
  const itemHTML = (n) => `<li><a class="news-item" data-id="${esc(n.id)}" href="${esc(n.link)}" target="_blank" rel="noopener noreferrer">
      <span class="ni-txt"><span class="ni-title">${esc(n.title)}</span>
        <span class="ni-meta"><span class="ni-tag ni-tag-${n.kind}">${n.kind === 'co' ? 'Company' : 'Industry'}</span>${n.publisher ? `<span class="ni-pub">${esc(n.publisher)}</span>` : ''}${n.time ? `<span class="ni-time">${esc(ago(n.time))}</span>` : ''}</span></span>
      ${n.img ? thumbHTML(n.img) : ''}
    </a></li>`;
  const skelItems = (n) => Array.from({ length: Math.max(0, n) }, () => '<li class="news-skel"><span></span><span></span></li>').join('');
  // items: headlines to show; pending: how many placeholder rows to add below them; note: optional message under the list
  function render(items, pending, note, retry) {
    const body = $('#newsBody'); if (!body) return;
    const list = items.length || pending ? `<ul class="news-list">${items.map(itemHTML).join('')}${skelItems(pending || 0)}</ul>` : '';
    body.innerHTML = list + (note ? `<p class="news-empty">${esc(note)}</p>` : '') + (retry ? '<button type="button" class="news-retry" data-retry="1">Try again</button>' : '');
    backfillThumbs(items);
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
    // the company name (from the Yahoo profile) makes a much better news search than the ticker
    const p = await profileOf(sym).catch(() => ({ name: '', industry: '', sector: '' }));
    if (my !== seq) return;
    let company = [], companyFailed = false;
    try { company = mergeNews([await searchNews(companyQuery(p.name, sym), sym)]); } catch (e) { companyFailed = true; }
    if (my !== seq) return;
    if (company.length < TOTAL && p.name) { // thin coverage: top up with a ticker search
      try { company = mergeNews([company, await searchNews(tickerQuery(sym), sym)]); companyFailed = false; } catch (e) { /* keep what we have */ }
      if (my !== seq) return;
    }
    company = company.slice(0, TOTAL).map((x) => ({ ...x, kind: 'co' }));
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
        <p class="news-foot">Company headlines first; industry headlines fill any remaining slots. Via Bing News. Links open the publisher\u2019s site. Not investment advice.</p>
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

/* ============================================================
   PLUTUS — Cloudflare Worker proxy for Yahoo Finance (free tier)
   • Adds CORS headers so the GitHub Pages site can call Yahoo
   • Handles Yahoo's cookie + "crumb" handshake (needed for
     quoteSummary: company profile, P/E, dividend, peers, etc.)
   • Only forwards to Yahoo Finance data hosts (not an open proxy)
   • Caches GET responses at the edge for 10 minutes
   • v4: also forwards POST to Yahoo's screener endpoint only
     (used to list companies in the same industry for peers)
   ============================================================ */

// After your site is live, lock this down, e.g. ['https://<user>.github.io']
const ALLOWED_ORIGINS = ['*'];
const ALLOWED_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
const ALLOWED_POST_PATHS = ['/v1/finance/screener'];
const CACHE_SECONDS = 600;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

let session = null; // { cookie, crumb, ts }

async function getSession(force) {
  if (!force && session && Date.now() - session.ts < 30 * 60e3) return session;
  const r = await fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': UA }, redirect: 'manual' });
  const setCookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [r.headers.get('set-cookie') || ''];
  const cookie = setCookies.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
  const c = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, Cookie: cookie } });
  const crumb = (await c.text()).trim();
  if (!c.ok || !crumb || crumb.includes('<') || crumb.length > 40) throw new Error('crumb handshake failed');
  session = { cookie, crumb, ts: Date.now() };
  return session;
}

// init (optional): { method, body } for POST requests
async function callYahoo(target, force, init) {
  let s = null;
  try { s = await getSession(force); } catch (e) { /* some endpoints work without a crumb */ }
  const u = new URL(target);
  if (s && s.crumb) u.searchParams.set('crumb', s.crumb);
  const headers = { 'User-Agent': UA, Accept: 'application/json' };
  if (s && s.cookie) headers.Cookie = s.cookie;
  const opts = { headers };
  if (init && init.method === 'POST') {
    opts.method = 'POST';
    opts.body = init.body;
    headers['Content-Type'] = 'application/json';
  }
  return fetch(u.toString(), opts);
}

function corsHeaders(req) {
  const origin = req.headers.get('Origin') || '';
  const allow = ALLOWED_ORIGINS.includes('*') ? '*' : ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return { 'Access-Control-Allow-Origin': allow, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' };
}

const json = (obj, status, extra) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...extra } });

export default {
  async fetch(req, env, ctx) {
    const cors = corsHeaders(req);
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'GET' && req.method !== 'POST') return json({ error: 'GET or POST only' }, 405, cors);

    const target = new URL(req.url).searchParams.get('url');
    if (!target) return json({ ok: true, usage: '?url=<encoded Yahoo Finance URL>' }, 200, cors);
    let parsed;
    try { parsed = new URL(target); } catch (e) { return json({ error: 'bad url' }, 400, cors); }
    if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.includes(parsed.hostname)) return json({ error: 'host not allowed' }, 403, cors);

    // ---- POST: screener only (no edge caching) ----
    if (req.method === 'POST') {
      if (!ALLOWED_POST_PATHS.includes(parsed.pathname)) return json({ error: 'POST not allowed for this path' }, 403, cors);
      const body = await req.text();
      if (body.length > 20000) return json({ error: 'body too large' }, 413, cors);
      let res = await callYahoo(parsed.toString(), false, { method: 'POST', body });
      if (res.status === 401 || res.status === 403) res = await callYahoo(parsed.toString(), true, { method: 'POST', body });
      const text = await res.text();
      return new Response(text, { status: res.status, headers: { 'Content-Type': 'application/json', ...cors } });
    }

    // ---- GET (cached) ----
    const cache = caches.default;
    const cacheKey = new Request('https://plutus-cache/' + encodeURIComponent(parsed.toString()));
    const cached = await cache.match(cacheKey);
    if (cached) return new Response(cached.body, { status: cached.status, headers: { ...Object.fromEntries(cached.headers), ...cors, 'X-Cache': 'HIT' } });

    let res = await callYahoo(parsed.toString(), false);
    if (res.status === 401 || res.status === 403) res = await callYahoo(parsed.toString(), true);
    const body = await res.text();
    const out = new Response(body, { status: res.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_SECONDS}`, ...cors } });
    if (res.ok) ctx.waitUntil(cache.put(cacheKey, out.clone()));
    return out;
  }
};

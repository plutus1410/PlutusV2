/* ============================================================
   PLUTUS — configuration
   ------------------------------------------------------------
   Yahoo Finance blocks direct browser calls (CORS), so requests
   go through your Cloudflare Worker (see /worker/worker.js).
   If WORKER_URL is empty, the app falls back to public CORS
   proxies — unreliable, demo only.
   ============================================================ */
window.APP_CONFIG = {
  WORKER_URL: "https://plutus-proxy.plutus1410.workers.dev",
  LOGODEV_KEY: "pk_bhlc52p0TIy8HasyFvNnVA",
  PUBLIC_PROXIES: [
    "https://api.allorigins.win/raw?url=",
    "https://corsproxy.io/?url="
  ],
  CACHE_MINUTES: 15,      // browser-side cache per Yahoo response
  REQUEST_TIMEOUT_MS: 15000,

  // Company logos. Yahoo Finance has no logo API, so logos are looked up by the
  // company's website domain. Sources are tried in order; if all fail, a
  // coloured initials badge is shown. Use {domain} as the placeholder.
  // To use a dedicated logo service, put it first, e.g.
  //   "https://img.logo.dev/{domain}?token=YOUR_PUBLISHABLE_TOKEN&size=128"
  LOGO_SOURCES: [
    "https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&url=https://{domain}&size=128",
    "https://icons.duckduckgo.com/ip3/{domain}.ico"
  ]
};

// config.js - Configuration constants
export const CONFIG = {
  MAX_NETWORK_LOG_SIZE: 2000,
  MAX_XHR_BODIES_SIZE: 200,
  MAX_BODY_CHARS: 100000,
  MAX_PERSISTED_NETWORK_ENTRIES: 200,
  MAX_PERSISTED_ACTION_ENTRIES: 200,
  MAX_XHR_BODIES: 200,
  // [NEW] script-body capture (see background/script-capture.js): webRequest never exposes
  // response bodies for ANY resource type, including scripts -- xhrBodies only exists because
  // page-hook.js separately wraps fetch()/XMLHttpRequest in the page itself and messages the
  // body back. A plain <script src="..."> load isn't fetch/XHR, so it was never caught either
  // way -- the site's own app bundle (where a decrypt/signing routine like vidnest.fun's or
  // moviesapi.to's actually lives) just didn't show up anywhere in a recording, full stop.
  // Capped independently from xhrBodies: a modern SPA can load 20-60+ script chunks per page
  // (confirmed directly in real captures -- vidcore.io alone loaded 11 in one page load), most
  // of them small webpack/CSS-module shims, not worth an unbounded cap.
  MAX_SCRIPT_BODIES: 60,
  MAX_RETRIES: 3,
  MAX_SCREENSHOTS: 20,
  AUTO_CLEANUP_INTERVAL: 60000,
  SNAPSHOT_COOLDOWN_MS: 2000,
};

// Site detection patterns
export const ARABIC_MOVIE_SITES = [
  'wecima.cx', 'wecima.me', 'wecima.click', 'wecima.bid', 'wecima.site', 'wecima.xyz',
  'mycima.cx', 'mycima.me', 'mycima.xyz',
  // [FIX] arabseed's actual current domain (confirmed live, 2026-10-12) and the mirror/CDN
  // domain its own pages load images from -- neither was in this list, which only had the
  // older arabseed.cam/arabseeds.cam domains (still kept below, in STREAMING_SITES/
  // CONTENT_DOMAINS, in case those come back). Without this, arabseed.living's own API/page
  // requests never got tagged isArabicApi, even though the site itself is squarely what this
  // extension is for.
  'arabseed.living', 'arabseed.men'
];

export const SAVEFILES_DOMAINS = [
  'savefiles.com', 's1.savefiles.com', 's2.savefiles.com'
];

export const YTS_API_PATTERNS = [
  /torrentio\.strem\.(fun|io)\/stream\//i,
  /moonlighthathel\.org/i,
  /andthoughmy\.org/i,
  /ghabovethec\.info/i,
  /vidsrcme\.ru\/api\.php/i,
  /vidsrc\.(to|mov)\/api\//i,
  /en\.yts\.lu\/api\//i,
  /en\.yify\.sc\/api\//i,
  /yts\.lu\/api\/v2\/list_movies/i,
  /yts\.lu\/api\/v2\/movie_details/i,
  /yify\.sc\/api\/v2\/list_movies/i,
  /yify\.sc\/api\/v2\/movie_details/i,
  /en\.yts\.lu\/browse/i,
  /en\.yify\.sc\/browse/i,
  /yts\.mx\/api\/v2\/list_movies/i,
  /yts\.mx\/api\/v2\/movie_details/i,
  /api\.themoviedb\.org\//i,
];

export const ARABIC_API_PATTERNS = [
  /wecima\.cx\/watch\//i,
  /wecima\.cx\/movies\//i,
  /mycima\.cx\/watch\//i,
  /mycima\.cx\/movies\//i,
  /\/watch\/.*-(\d{4})-/i,
];

export const SUSPECTED_BACKEND_DOMAINS = [
  'moonlighthathel.org',
  'andthoughmy.org',
  'ghabovethec.info',
];

export const TORRENT_BODY_PATTERNS = [
  /infoHash["'\s:]+[a-f0-9]{32,40}/i,
  /magnet:\?xt=urn:btih:/i,
  /"fileIdx"\s*:\s*/i,
  /"streams"\s*:\s*\[/i,
  /"seeders"\s*:\s*/i,
  /"peers"\s*:\s*/i,
  /btih:[a-fA-F0-9]{32,40}/i,
];

export const DOWNLOAD_PATTERNS = [
  /savefiles\.com\/v\//i,
  /\.(mp4|mkv|avi|mov|wmv|flv|webm|m4v|mpg|mpeg)(\?|$)/i,
  /\/download\//i,
  /\/dl\//i,
  /\/get\//i,
];

export const CLOUDFLARE_CHALLENGE_HEADERS = ['cf-challenge', 'cf-mitigated'];
export const CLOUDFLARE_CHALLENGE_STATUSES = [403, 503, 429];
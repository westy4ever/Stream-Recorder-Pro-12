// config.js - Configuration constants
export const CONFIG = {
  MAX_NETWORK_LOG_SIZE: 2000,
  MAX_XHR_BODIES_SIZE: 200,
  MAX_BODY_CHARS: 100000,
  MAX_PERSISTED_NETWORK_ENTRIES: 200,
  MAX_PERSISTED_ACTION_ENTRIES: 200,
  MAX_XHR_BODIES: 200,
  MAX_RETRIES: 3,
  MAX_SCREENSHOTS: 20,
  AUTO_CLEANUP_INTERVAL: 60000,
  SNAPSHOT_COOLDOWN_MS: 2000,
};

// Site detection patterns
export const ARABIC_MOVIE_SITES = [
  'wecima.cx', 'wecima.me', 'wecima.click', 'wecima.bid', 'wecima.site', 'wecima.xyz',
  'mycima.cx', 'mycima.me', 'mycima.xyz'
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
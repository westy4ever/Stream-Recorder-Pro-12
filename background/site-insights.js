// site-insights.js - higher-level findings for the extractor generator (v4.5.0)
//
// Added after a real movy.sx capture produced an extractor that could not work:
// it picked a subtitle API as "search", offered the trailer as the stream, read
// HTML on a Next.js site whose data lives in __NEXT_DATA__ JSON, and never
// noticed the encrypted /seed + /<server>/sources calls that really produced the
// playlist. Every function here is pure (captured data in, plain object out) so
// export-generator.js can call it on any capture, live or imported.

// ── 3. trailers are never the stream ─────────────────────────────────────────
const TRAILER_RE = /(^|\.)imdb-video\.|media-imdb\.com|(^|\/\/)trailers?\.|\/trailers?\/|youtube\.com|youtu\.be|ytimg\.com|vimeocdn\.com|getOldestTrailer/i;

export function isTrailerUrl(u) {
  return typeof u === 'string' && TRAILER_RE.test(u);
}

const STATIC_RE = /\.(js|css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|map)(\?|$)/i;
const NOISE_RE = /google|doubleclick|analytics|gtag|facebook|cloudflareinsights|sentry|hotjar|\/track\b|\/collect\b|\/beacon|ipwho|ipinfo|\/api\/geo/i;
const MEDIA_RE = /\.(m3u8|mpd)(\?|$)|\.mp4(\?|$)|\/index[^/]*\.m3u8|master\.m3u8/i;
const SEGMENT_RE = /\/seg-\d+|\.m4s(\?|$)|\.ts(\?|$)|\/init[^/]*\.mp4|thumbs?\//i;

function host(u) { try { return new URL(u).hostname; } catch (e) { return ''; } }
function path(u) { try { return new URL(u).pathname; } catch (e) { return ''; } }
function ts(e) { return Number(e && (e.timestamp || e.time || 0)) || 0; }

function bodiesByUrl(xhrBodies) {
  const map = new Map();
  for (const b of (xhrBodies || [])) {
    if (b && b.url && typeof b.body === 'string' && !map.has(b.url)) map.set(b.url, b.body);
  }
  return map;
}

// ── 1. Next.js sites: page data is JSON, not HTML ────────────────────────────
function parseNextData(html) {
  const m = /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html || '');
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (e) { return null; }
}

function looksLikeItem(o) {
  return o && typeof o === 'object' && !Array.isArray(o)
    && ('id' in o || 'slug' in o) && ('title' in o || 'name' in o);
}

function describeSections(pageProps) {
  // top-level arrays of items, and arrays of {name, <list>} section objects
  const out = [];
  for (const [key, val] of Object.entries(pageProps || {})) {
    if (!Array.isArray(val) || !val.length) continue;
    if (looksLikeItem(val[0])) {
      out.push({ key, sub: null, count: val.length, itemKeys: Object.keys(val[0]).slice(0, 12) });
      continue;
    }
    if (val[0] && typeof val[0] === 'object') {
      for (const sec of val.slice(0, 20)) {
        if (!sec || typeof sec !== 'object') continue;
        const listKey = Object.keys(sec).find(k => Array.isArray(sec[k]) && sec[k].length && looksLikeItem(sec[k][0]));
        if (listKey) {
          out.push({ key, sub: { nameField: 'name' in sec ? 'name' : ('title' in sec ? 'title' : null),
                                 name: sec.name || sec.title || '', listKey },
                     count: sec[listKey].length, itemKeys: Object.keys(sec[listKey][0]).slice(0, 12) });
        }
      }
    }
  }
  return out.slice(0, 25);
}

export function detectNextJs(networkLog, xhrBodies, frameDocuments) {
  let found = null;
  const docs = [];
  for (const d of (frameDocuments || [])) if (d && d.html) docs.push({ url: d.url, html: d.html });
  for (const b of (xhrBodies || [])) if (b && typeof b.body === 'string' && b.body.includes('__NEXT_DATA__')) docs.push({ url: b.url, html: b.body });
  for (const d of docs) {
    const nd = parseNextData(d.html);
    if (!nd) continue;
    const sections = describeSections(nd.props && nd.props.pageProps);
    if (!found || sections.length > found.sections.length) {
      found = { buildId: nd.buildId || '', page: nd.page || '', pageUrl: d.url || '',
                locale: nd.locale || '', sections };
    }
  }
  const dataRoutes = [];
  for (const e of (networkLog || [])) {
    const m = e && e.url && /\/_next\/data\/([^/]+)\/(.+?\.json)/.exec(e.url);
    if (!m) continue;
    if (found && !found.buildId) found.buildId = m[1];
    const route = m[2].replace(/\/\d+(\.json)/, '/{id}$1').replace(/\?.*$/, '');
    if (!dataRoutes.includes(route)) dataRoutes.push(route);
  }
  if (!found && !dataRoutes.length) return null;
  found = found || { buildId: '', page: '', pageUrl: '', locale: '', sections: [] };
  found.dataRoutes = dataRoutes.slice(0, 15);
  return found;
}

// ── 4. TMDB-numbered sites ───────────────────────────────────────────────────
export function detectTmdbSite(networkLog, actions, nextInfo) {
  const evidence = [];
  const urls = [];
  for (const a of (actions || [])) { if (a && a.href) urls.push(a.href); if (a && a.url) urls.push(a.url); }
  for (const e of (networkLog || [])) if (e && e.url && (e.type === 'main_frame' || /\/_next\/data\//.test(e.url))) urls.push(e.url);
  let movie = null, tv = null;
  for (const u of urls) {
    const p = path(u);
    let m = /\/movies?\/(\d{2,8})(?:[/.?]|$)/.exec(p); if (m && !movie) movie = { sample: u, id: m[1] };
    m = /\/(?:tv|series|shows?)\/(\d{2,8})(?:[/.?]|$)/.exec(p); if (m && !tv) tv = { sample: u, id: m[1] };
  }
  if (movie) evidence.push('detail URL ' + path(movie.sample));
  if (tv) evidence.push('detail URL ' + path(tv.sample));
  const tmdbHosts = new Set();
  for (const e of (networkLog || [])) {
    const h = host(e && e.url);
    if (/api\.themoviedb\.org/.test(h)) tmdbHosts.add(h);
    else if (/image\.tmdb\.org/.test(decodeURIComponent((e && e.url) || ''))) tmdbHosts.add('image.tmdb.org' + (h && !/tmdb/.test(h) ? ' via ' + h : ''));
    if (e && e.url && /tmdbId=|tmdb_id=/.test(e.url)) evidence.push('request carries tmdbId: ' + path(e.url));
  }
  if (tmdbHosts.size) evidence.push('TMDB images/API used (' + [...tmdbHosts].slice(0, 3).join(', ') + ')');
  if (nextInfo && nextInfo.sections.some(s => s.itemKeys.includes('genre_ids') || s.itemKeys.includes('vote_average'))) {
    evidence.push('page data items carry TMDB fields (genre_ids / vote_average)');
  }
  if (!(movie || tv) || evidence.length < 2) return null;
  const clean = (p) => p.replace(/^\/_next\/data\/[^/]+(\/[a-z]{2}(-[A-Z]{2})?)?/, '').replace(/\.json$/, '');
  return { moviePattern: movie ? clean(path(movie.sample)).replace(movie.id, '{tmdb_id}') : null,
           tvPattern: tv ? clean(path(tv.sample)).replace(tv.id, '{tmdb_id}') : null,
           evidence: [...new Set(evidence)].slice(0, 6) };
}

// ── 2. where did the playlist come from? ─────────────────────────────────────
function looksEncrypted(body) {
  const t = (body || '').trim();
  if (t.length < 120 || /^[{[<]/.test(t)) return false;
  if (!/^[A-Za-z0-9+/_=-]+$/.test(t.slice(0, 400))) return false;
  return true;
}

function scriptSnippets(scriptBodies, needle, extra) {
  const out = [];
  for (const s of (scriptBodies || [])) {
    const body = s && typeof s.body === 'string' ? s.body : '';
    if (!body) continue;
    let i = body.indexOf(needle);
    if (i < 0) continue;
    // prefer an occurrence that has the decoder keyword nearby
    let best = i;
    while (i >= 0) {
      const win = body.slice(Math.max(0, i - 3000), i + 1500);
      if (extra.some(k => win.includes(k))) { best = i; break; }
      i = body.indexOf(needle, i + needle.length);
    }
    let k = -1, kw = '';
    for (const word of extra) {            // in priority order: "decrypt" first
      const j = body.lastIndexOf(word, best + 1500);
      if (j >= 0 && Math.abs(j - best) < 4000) { k = j; kw = word; break; }
    }
    const center = k >= 0 ? k : best;
    out.push({ script: s.url || '(inline)', keyword: kw || needle,
               // a decoder usually ends with its error/return text: show mostly what comes before
               snippet: kw === 'decrypt' ? body.slice(Math.max(0, center - 1500), center + 300)
                                         : body.slice(Math.max(0, center - 700), center + 700) });
    if (out.length >= 2) break;
  }
  return out;
}

export function traceStreamOrigin(networkLog, xhrBodies, scriptBodies) {
  const log = (networkLog || []).filter(e => e && e.url).slice().sort((a, b) => ts(a) - ts(b));
  const first = log.find(e => MEDIA_RE.test(e.url) && !SEGMENT_RE.test(e.url) && !isTrailerUrl(e.url));
  if (!first) return null;
  const bodies = bodiesByUrl(xhrBodies);
  const result = { playlistUrl: first.url, playlistHost: host(first.url) };

  // (a) a reply that literally contains the playlist URL (or its path)
  const p = path(first.url);
  for (const [u, body] of bodies) {
    if (u === first.url || isTrailerUrl(u)) continue;
    if (body.includes(first.url) || (p.length > 12 && body.includes(p))) {
      result.origin = { url: u, plain: true };
      return result;
    }
  }
  // (b) otherwise the last API call before the playlist that returned something
  const t0 = ts(first);
  const before = log.filter(e => ts(e) <= t0 && e.url !== first.url
    && /xmlhttprequest|fetch|other/i.test(e.type || 'xmlhttprequest')
    && !STATIC_RE.test(e.url) && !NOISE_RE.test(e.url) && !isTrailerUrl(e.url)
    && !MEDIA_RE.test(e.url) && !/\/_next\/data\//.test(e.url) && !/subtitles?/i.test(e.url)
    && host(e.url) !== result.playlistHost);
  let pick = null;
  for (let i = before.length - 1; i >= 0 && i >= before.length - 12; i--) {
    const e = before[i];
    const body = bodies.get(e.url);
    if (body === undefined) continue;
    if (!pick || (looksEncrypted(body) && !pick.encrypted)) {
      pick = { url: e.url, method: e.method || 'GET', encrypted: looksEncrypted(body),
               bodySample: body.trim().slice(0, 90), t: ts(e) };
      if (pick.encrypted) break;
    }
  }
  if (!pick) return result;
  result.origin = pick;
  // a setup call just before it on the same host (e.g. /seed, /token, /key)
  const prev = before.filter(e => host(e.url) === host(pick.url) && ts(e) < pick.t && ts(e) > pick.t - 15000 && e.url !== pick.url).pop();
  if (prev) {
    result.setup = { url: prev.url, method: prev.method || 'GET', bodySample: (bodies.get(prev.url) || '').trim().slice(0, 120) };
    // is a value from the setup reply reused in the main call?
    const val = /"(?:seed|token|key|nonce|t)"\s*:\s*"([^"]{6,})"/.exec(result.setup.bodySample || '');
    if (val && pick.url.includes(encodeURIComponent(val[1]).slice(0, 12))) {
      result.setup.reusedValue = val[1];
    }
  }
  if (pick.encrypted) {
    const segs = path(pick.url).split('/').filter(Boolean);
    const needle = '/' + segs.slice(-1)[0];            // e.g. "/sources"
    result.decoderHints = scriptSnippets(scriptBodies, needle, ['decrypt', 'atob', 'TextDecoder', 'fromCharCode', 'charCodeAt']);
  }
  return result;
}

// ── 5. the request that really answers the site's search box ────────────────
export function findRealSearch(actions, networkLog) {
  const typed = [];
  for (const a of (actions || [])) {
    if (!a) continue;
    if (a.type === 'type' && a.value) typed.push({ v: String(a.value), t: Number(a.timestamp) || 0 });
    if (a.type === 'submit' && a.value) {
      try {
        const data = JSON.parse(a.value);
        for (const v of Object.values(data)) if (typeof v === 'string' && v.length >= 2) typed.push({ v, t: Number(a.timestamp) || 0 });
      } catch (e) { /* not JSON */ }
    }
  }
  for (const { v, t } of typed) {
    const forms = [v, encodeURIComponent(v), v.replace(/ /g, '+'), encodeURIComponent(v).replace(/%20/g, '+')]
      .map(s => s.toLowerCase());
    for (const e of (networkLog || [])) {
      if (!e || !e.url || ts(e) < t - 1000 || STATIC_RE.test(e.url) || NOISE_RE.test(e.url)) continue;
      const low = e.url.toLowerCase();
      if (!forms.some(f => low.includes(f))) continue;
      // the typed text must BE a parameter value or a path segment, not just
      // appear inside a longer one (a title=... on a stream API is not a search)
      let param = null, segment = false;
      try {
        const u = new URL(e.url);
        for (const [k, val] of u.searchParams) if (val.toLowerCase() === v.toLowerCase()) { param = k; break; }
        segment = u.pathname.split('/').some(sg => forms.includes(sg.toLowerCase()));
      } catch (err) { /* ignore */ }
      if (!param && !segment) continue;
      let template = e.url;
      for (const f of [encodeURIComponent(v), v.replace(/ /g, '+'), v]) template = template.split(f).join('{query}');
      return { url: e.url, method: e.method || 'GET', typed: v, param, template };
    }
  }
  return null;
}

// ── 6. server names shown in the player <-> the API paths they call ─────────
export function mapServerLabels(networkLog, frameDocuments, xhrBodies) {
  const html = [];
  for (const d of (frameDocuments || [])) if (d && d.html) html.push(d.html);
  for (const b of (xhrBodies || [])) if (b && typeof b.body === 'string' && b.body.length > 2000 && /<html|<div/i.test(b.body)) html.push(b.body);
  if (!html.length) return null;
  const all = html.join('\n');
  const groups = {};
  for (const e of (networkLog || [])) {
    if (!e || !e.url || STATIC_RE.test(e.url) || NOISE_RE.test(e.url) || isTrailerUrl(e.url)) continue;
    const segs = path(e.url).split('/').filter(Boolean);
    if (segs.length < 2 || !/^[a-z][a-z-]{2,20}$/i.test(segs[0])) continue;
    const key = host(e.url) + '/{server}/' + segs.slice(1).join('/');
    (groups[key] = groups[key] || new Set()).add(segs[0]);
  }
  const STOP = new Set(['api', 'v1', 'v2', 'v3', 'static', 'assets', 'search', 'en', 'ar', 'fr', 'de', 'es',
    'pt', 'img', 'images', 'media', 'cdn', 'data', 'track', 'seed', 'vd', 'vdb', 'mp4', 'hls', 'embed', 'e']);
  let best = null;
  for (const [key, names] of Object.entries(groups)) {
    for (const name of names) {
      if (STOP.has(name.toLowerCase())) continue;
      const re = new RegExp('<([a-z]+)([^>]*)>\\s*' + name + '\\s*</\\1>', 'i');
      const m = re.exec(all);
      if (!m) continue;
      // every label rendered with the same tag+class is probably another server
      const cls = /class=["']([^"']+)["']/.exec(m[2]);
      let labels = [];
      if (cls) {
        const re2 = new RegExp('<' + m[1] + '[^>]*class=["\']' + cls[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\'][^>]*>\\s*([^<]{2,30}?)\\s*</' + m[1] + '>', 'gi');
        let mm;
        while ((mm = re2.exec(all)) !== null) if (!labels.includes(mm[1])) labels.push(mm[1]);
      }
      // quality buttons and on/off toggles share the menu's styling; they aren't servers
      labels = labels.filter(l => !/^(\d{3,4}p|4k|hd|sd|auto|off|on|default|none)$/i.test(l.trim()));
      if (!labels.length) labels = [name];
      const cand = { pattern: 'https://' + key, requested: [...names], labels: labels.slice(0, 40),
                     paths: labels.map(l => l.toLowerCase().replace(/\s+/g, '-')) };
      if (!best || cand.labels.length > best.labels.length) best = cand;
    }
  }
  return best;
}

// ── 7. names the generated file may import from NovaPlay's extractors/base.py ─
// Kept in sync by hand with base.py's re-export block (2026-10-19).
export const NOVAPLAY_BASE_NAMES = new Set([
  'BaseExtractor', 'is_landscape_shaped',
  'log', 'fetch', 'fetch_json', 'UA', 'TIMEOUT', 'set_browser_proxy', 'get_proxy_used',
  'set_curl_failed_needs_proxy', 'get_curl_failed_needs_proxy', 'clear_cookies',
  'get_cookie_header_for_url', 'validate_manifest', '_BROWSER_PROXY_URL', '_fetch_via_browser_proxy',
  'find_m3u8', 'find_m3u8_all', 'find_mp4', 'find_mp4_all', '_best_media_url', '_correct_stream_url',
  '_extract_quality_from_streamruby_url', '_is_placeholder_media_url', '_label_quality_variant',
  '_label_quality_variants', 'get_last_quality_variants', 'get_synthesized_variants', '_quality_tls',
  'extract_iframes', '_QUALITY_SUFFIX_LABELS',
  'resolve_host', 'resolve_iframe_chain', 'resolve_generic_embed', 'extract_stream', 'extract_stream_all',
  'HOST_RESOLVERS', 'find_packed_links', '_unpack_all', 'decode_packer', 'Unbaser',
  '_parse_hls_master_variants', 'extract_stream_urls_from_text',
]);

export function checkNovaPlayCompat(code) {
  const warnings = [];
  const re = /^from \.base import (\(([\s\S]*?)\)|[^\n]+)/gm;
  let m;
  while ((m = re.exec(code)) !== null) {
    const list = m[2] !== undefined ? m[2] : m[1];
    for (const raw of list.split(/[,\n]/)) {
      const name = raw.replace(/#.*$/, '').trim().split(/\s+as\s+/)[0];
      if (name && !NOVAPLAY_BASE_NAMES.has(name)) {
        warnings.push(`Imports "${name}" from .base, which NovaPlay's extractors/base.py does not provide -- the file would fail to load.`);
      }
    }
  }
  if (/\bBeautifulSoup\(/.test(code) && !/^(from bs4 import|BeautifulSoup\s*=)/m.test(code)) {
    warnings.push('Uses BeautifulSoup without importing it (NovaPlay boxes usually have no bs4).');
  }
  if (/self\.main_url \+ ['"]https?:/.test(code)) {
    warnings.push('Joins self.main_url with an absolute URL -- the request would go to "https://sitehttps://...".');
  }
  const defs = { get_categories: /def get_categories\(self, mtype="movie"\)/, get_category_items: /def get_category_items\(self, url, page=1\)/,
                 search: /def search\(self, query, page=1\)/, get_page: /def get_page\(self, url, m_type=None\)/,
                 extract_stream: /def extract_stream\(self, url\)/ };
  for (const [name, sig] of Object.entries(defs)) {
    if (new RegExp('def ' + name + '\\(').test(code) && !sig.test(code)) {
      warnings.push(`${name}() does not use NovaPlay's signature -- the plugin calls it as ${sig.source.replace(/\\/g, '').replace(/^def /, '')}.`);
    }
  }
  return warnings;
}


// ── TMDB sites: turn the traced stream API call into a per-server URL template ─
// e.g. https://api.x/miami/sources?title=…&tmdbId=1148365&seed=… becomes
//      base  https://api.x/{server}/sources
//      params [["title","{title}"],["tmdbId","{tmdb_id}"], …]  (seed dropped: it
//      comes from the setup call each time)
export function buildServerTemplate(streamOrigin, serverMap) {
  if (!streamOrigin || !streamOrigin.origin || !serverMap) return null;
  let u;
  try { u = new URL(streamOrigin.origin.url); } catch (e) { return null; }
  const segs = u.pathname.split('/').filter(Boolean);
  if (!segs.length || !serverMap.requested.map(x => x.toLowerCase()).includes(segs[0].toLowerCase())) return null;
  const base = u.origin + '/{server}/' + segs.slice(1).join('/');
  const reused = streamOrigin.setup && streamOrigin.setup.reusedValue;
  const params = [];
  let tmdbValue = null, titleEncodings = 1, setupParam = null;
  for (const [k, v] of u.searchParams) {
    if (reused && v === reused) { setupParam = k; continue; }
    let tpl = v;
    if (/tmdb/i.test(k)) { tpl = '{tmdb_id}'; tmdbValue = v; }
    else if (/imdb/i.test(k)) tpl = '{imdb_id}';
    else if (/^year$|release.?year/i.test(k)) tpl = '{year}';
    else if (/title|^name$/i.test(k)) { tpl = '{title}'; if (/%[0-9A-F]{2}/i.test(v)) titleEncodings = 2; }
    else if (/media.?type|^type$/i.test(k) && /^(movie|tv|series|show)$/i.test(v)) tpl = '{media_type}';
    else if (/season/i.test(k)) tpl = '{season}';
    else if (/episode/i.test(k)) tpl = '{episode}';
    params.push([k, tpl]);
  }
  let setupUrl = null;
  if (streamOrigin.setup && tmdbValue) {
    setupUrl = streamOrigin.setup.url.split(tmdbValue).join('{tmdb_id}');
  }
  const setupKey = reused ? (/"([A-Za-z_]+)"\s*:\s*"[^"]*"/.exec(streamOrigin.setup.bodySample || '') || [])[1] : null;
  return { base, params, titleEncodings, setupParam, setupUrl, setupKey,
           encrypted: !!streamOrigin.origin.encrypted };
}

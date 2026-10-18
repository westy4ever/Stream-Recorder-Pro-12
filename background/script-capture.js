// script-capture.js - captures <script src="..."> body content
//
// [NEW] Why this file exists: chrome.webRequest (network-capture.js) can never expose
// response body content for ANY resource type, script included -- that's a hard browser
// API limitation, not a gap in this extension's own logic. The only body-capture path
// that existed before this file was page-hook.js, which runs in the page's own JS
// context (manifest.json's "world": "MAIN") and monkey-patches window.fetch/XHR there,
// then relays what it captured back via chrome.runtime.sendMessage({type:
// "xhrResponseBody", ...}) -- see message-handlers.js. A plain <script src="..."> tag
// load is neither a fetch() nor an XMLHttpRequest call made by the page's own code; it's
// the browser's native script loader, so neither capture path above ever saw its body.
// Confirmed directly against a real need: moviesapi.to's and vidnest.fun's actual
// decrypt/signing logic lives in exactly this kind of script-tag-loaded app bundle, and
// it never once showed up in any real recording taken with this extension, regardless of
// how long or thorough the session was.
//
// The fix: this extension already declares host_permissions: ["<all_urls>"] in
// manifest.json. A fetch() issued directly from the background service worker (an
// extension-privileged context, not the page) is not subject to the ORIGINATING PAGE's
// CORS restrictions, so the background can independently re-fetch any script URL it
// already observed via webRequest's onCompleted and just read its text -- no new
// permissions, and no chrome.debugger API (which would show the user an intrusive "this
// extension is debugging this browser" banner for the whole tab).
import { state, scheduleSave } from './state.js';
import { CONFIG } from './config.js';
import { pendingDownloadFilenames } from './screenshot.js';

// Scripts already captured this session, by URL -- avoids re-fetching (and re-storing)
// the same webpack chunk every time a site's SPA router re-requests the same page.
const _seenScriptUrls = new Set();

/**
 * [FIX] Must be called when a new recording starts. _seenScriptUrls is module-level, so it
 * used to survive across recordings for the whole life of the service worker: any script
 * URL seen during an EARLIER session was silently skipped in every later one. Re-record
 * the same player page (the normal workflow when a first capture missed something) and
 * scriptBodies came back completely empty, with nothing anywhere saying why.
 */
// [NEW] scripts that never contain a site's player/extraction logic. Captured in full they
// only bloat the export (cast SDKs alone were ~90 KB in a real capture), so they're skipped.
// Matched on hostname suffix; CDNs that DO host site code (jsdelivr, unpkg, cdnjs) are
// deliberately not listed.
const NOISE_SCRIPT_HOSTS = [
  'googletagmanager.com', 'google-analytics.com', 'googlesyndication.com',
  'doubleclick.net', 'gstatic.com', 'cloudflareinsights.com', 'facebook.net',
  'hotjar.com', 'clarity.ms', 'yandex.ru', 'mc.yandex.ru', 'histats.com',
  'disqus.com', 'addthis.com', 'sharethis.com'
];

function isNoiseScript(url) {
  try {
    const u = new URL(url);
    // the extension's own injected files (websocket-hook.js etc.) are not site code
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
    const host = u.hostname.toLowerCase();
    if (NOISE_SCRIPT_HOSTS.some(h => host === h || host.endsWith('.' + h))) return true;
    // self-hosted analytics, e.g. umami.<site>/script.js
    if (/^(umami|analytics|stats|plausible|matomo)\./.test(host)) return true;
    return false;
  } catch (e) {
    return false;
  }
}

export function resetScriptCapture() {
  _seenScriptUrls.clear();
}

// [FIX] a failed re-fetch used to vanish without trace (console.debug only), so an empty
// scriptBodies export was indistinguishable from "this page loaded no scripts". Failures
// are now recorded as body-less entries carrying the reason -- every consumer
// (export-generator.js) already skips entries whose body is empty, so nothing downstream
// changes, but the export itself now shows which scripts were attempted and why they failed.
function _recordFailure(entry, url, status, error) {
  try {
    const s = state;
    if (!s.recording) return;
    s.scriptBodies.push({
      timestamp: Date.now(),
      tabId: entry && entry.tabId,
      url,
      status: status || 0,
      size: 0,
      truncated: false,
      body: null,
      error: String(error || 'unknown error').slice(0, 300)
    });
    if (s.scriptBodies.length > CONFIG.MAX_SCRIPT_BODIES) s.scriptBodies.shift();
    scheduleSave();
  } catch (e) {}
}

/**
 * Fire-and-forget: given a completed webRequest entry for a script resource, fetch its
 * body independently from the background and add it to state.scriptBodies. Never throws
 * -- a failure here (CORS quirk, network blip, a script that 404s on re-fetch because it
 * was cache-busted with a one-time query param) must never interrupt the actual
 * recording, so every failure path below is caught and silently dropped.
 *
 * @param {object} entry - the s.pending[...] entry built in network-capture.js's
 *   onBeforeRequest, as it stands by onCompleted (has .url, .finalUrl, .tabId, .statusCode).
 */
export async function captureScriptBody(entry) {
  try {
    const url = entry.finalUrl || entry.url;
    if (!url || isNoiseScript(url)) return;

    const s = state;
    // [FIX] check recording BEFORE marking the URL as seen -- otherwise a script that
    // finished loading just after Stop was marked seen and then never captured again.
    if (!s.recording || _seenScriptUrls.has(url)) return;
    _seenScriptUrls.add(url);

    let resp;
    try {
      resp = await fetch(url, { credentials: "omit" });
    } catch (e) {
      _recordFailure(entry, url, 0, 'fetch failed: ' + (e && e.message));
      return;
    }
    if (!resp.ok) {
      _recordFailure(entry, url, resp.status, 'HTTP ' + resp.status + ' on background re-fetch');
      return;
    }
    const text = await resp.text();
    if (!text) {
      _recordFailure(entry, url, resp.status, 'empty body on background re-fetch');
      return;
    }

    const cap = Math.max(CONFIG.MAX_BODY_CHARS, CONFIG.MAX_SCRIPT_BODY_CHARS || 0);
    const truncated = text.length > cap;
    s.scriptBodies.push({
      timestamp: Date.now(),
      tabId: entry.tabId,
      url,
      status: resp.status,
      size: text.length,
      truncated,
      body: truncated ? text.substring(0, cap) : text
    });
    if (s.scriptBodies.length > CONFIG.MAX_SCRIPT_BODIES) s.scriptBodies.shift();

    scheduleSave();

    // [NEW] player bundles with a hidden bytecode VM (VidCore / VidFast style) get saved
    // in full as separate files, so a site rebuild can be fixed from this one file.
    if (looksLikeBytecodeVM(text)) savePlayerFiles(entry, url, text);
  } catch (e) {
    _recordFailure(entry, entry && (entry.finalUrl || entry.url), 0, e && e.message);
    // Silent by design -- see function doc above. Left as a console.debug (not warn/error)
    // so it doesn't look like a real problem in the extension's own console during normal
    // use, while still being visible if someone's actively debugging this file.
    console.debug('[script-capture] skipped', entry && entry.url, e && e.message);
  }
}


// ═══ PLAYER-VM AUTO-SAVE ═══
// VidCore / VidFast (and anything built with the same obfuscator) hide their request
// logic in a small stack machine inside one Next.js chunk:
//   function*t(r,l,h){var f=r,u=[],p=[];function m(){if(f>=l)throw Error("");var e=f;return s[f++]^...}
// NovaPlay's extractors/jsvm.py reads that chunk directly, so when the site rebuilds,
// that single file (untruncated) plus the page that loaded it is all that's needed.
// Saved to Downloads/StreamRecorder-VM/, once per chunk URL (the URL carries a content
// hash, so a new build is a new URL and gets saved again).
const VM_HEADER_RE = /function\*[\w$]+\([\w$]+,[\w$]+,[\w$]+\)\{(?:let [\w$]+=[\w$]+;)?var [\w$]+=[\w$]+,[\w$]+=\[\],[\w$]+=\[\];function [\w$]+\(\)\{if\([\w$]+>=[\w$]+\)throw Error\(""\)/;
const VM_SAVED_KEY = 'vmSavedChunks';
const _vmSavingNow = new Set();

export function looksLikeBytecodeVM(text) {
  return typeof text === 'string' && text.length > 50000 && text.indexOf('function*') !== -1 &&
    text.indexOf('fromCharCode') !== -1 && VM_HEADER_RE.test(text);
}

function _vmFileBase(url) {
  try {
    const u = new URL(url);
    const file = (u.pathname.split('/').pop() || 'chunk.js').replace(/[^\w.\-]/g, '_');
    return u.hostname.replace(/[^\w.\-]/g, '_') + '_' + file.replace(/\.js$/, '');
  } catch (e) {
    return 'player_' + Date.now();
  }
}

function _downloadText(content, filename, mimeType) {
  return new Promise((resolve) => {
    try {
      const base64 = btoa(unescape(encodeURIComponent(content)));
      chrome.downloads.download({ url: `data:${mimeType};base64,${base64}`, filename, saveAs: false, conflictAction: 'uniquify' }, (id) => {
        if (chrome.runtime.lastError || !id) {
          console.warn('[vm-save] download failed:', filename, chrome.runtime.lastError && chrome.runtime.lastError.message);
          resolve(false);
          return;
        }
        pendingDownloadFilenames[id] = filename;   // Brave ignores `filename` for data: URLs otherwise
        resolve(true);
      });
    } catch (e) {
      console.warn('[vm-save] could not save', filename, e && e.message);
      resolve(false);
    }
  });
}

async function savePlayerFiles(entry, url, text) {
  if (_vmSavingNow.has(url)) return;
  _vmSavingNow.add(url);
  try {
    const stored = await chrome.storage.local.get(VM_SAVED_KEY);
    const saved = (stored && stored[VM_SAVED_KEY]) || {};
    if (saved[url]) return;
    const base = 'StreamRecorder-VM/' + _vmFileBase(url);
    const ok = await _downloadText(text, base + '.js', 'text/javascript');
    if (!ok) return;
    saved[url] = Date.now();
    const keys = Object.keys(saved);
    if (keys.length > 200) {          // keep the list small
      keys.sort((a, b) => saved[a] - saved[b]).slice(0, keys.length - 200).forEach(k => delete saved[k]);
    }
    await chrome.storage.local.set({ [VM_SAVED_KEY]: saved });
    console.log('[vm-save] saved player VM chunk', url);

    // The page that loaded it carries the token the VM starts from ("en"). Its frame
    // document is captured at DOMContentLoaded, usually a moment after this chunk,
    // so wait a little before looking for it.
    setTimeout(() => _savePlayerPage(entry, url, base), 8000);
  } catch (e) {
    console.warn('[vm-save] failed for', url, e && e.message);
  } finally {
    _vmSavingNow.delete(url);
  }
}

function _savePlayerPage(entry, chunkUrl, base) {
  try {
    const origin = new URL(chunkUrl).origin;
    const docs = (state.frameDocuments || []).filter(d => {
      try { return new URL(d.url).origin === origin && (!entry.tabId || d.tabId === entry.tabId); } catch (e) { return false; }
    });
    const info = {
      savedAt: new Date().toISOString(),
      chunkUrl,
      tabId: entry.tabId,
      pageUrl: docs.length ? docs[docs.length - 1].url : null,
      note: 'Saved by Stream Recorder Pro: player chunk with a bytecode VM. Send the .js (and the _page.html) to update NovaPlay.'
    };
    _downloadText(JSON.stringify(info, null, 2), base + '_info.json', 'application/json');
    if (docs.length) {
      const best = docs.reduce((a, b) => (b.size > a.size ? b : a));
      _downloadText(best.html || '', base + '_page.html', 'text/html');
    }
  } catch (e) {
    console.warn('[vm-save] page save failed', e && e.message);
  }
}

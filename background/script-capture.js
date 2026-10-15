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

// Scripts already captured this session, by URL -- avoids re-fetching (and re-storing)
// the same webpack chunk every time a site's SPA router re-requests the same page.
const _seenScriptUrls = new Set();

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
    if (!url || _seenScriptUrls.has(url)) return;
    _seenScriptUrls.add(url);

    const s = state;
    if (!s.recording) return;

    const resp = await fetch(url, { credentials: "omit" });
    if (!resp.ok) return;
    const text = await resp.text();
    if (!text) return;

    const truncated = text.length > CONFIG.MAX_BODY_CHARS;
    s.scriptBodies.push({
      timestamp: Date.now(),
      tabId: entry.tabId,
      url,
      status: resp.status,
      size: text.length,
      truncated,
      body: truncated ? text.substring(0, CONFIG.MAX_BODY_CHARS) : text
    });
    if (s.scriptBodies.length > CONFIG.MAX_SCRIPT_BODIES) s.scriptBodies.shift();

    scheduleSave();
  } catch (e) {
    // Silent by design -- see function doc above. Left as a console.debug (not warn/error)
    // so it doesn't look like a real problem in the extension's own console during normal
    // use, while still being visible if someone's actively debugging this file.
    console.debug('[script-capture] skipped', entry && entry.url, e && e.message);
  }
}

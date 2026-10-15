// state.js - State management & persistence
import { CONFIG } from './config.js';

// ═══ STATE ═══
export let state = {
  recording: false,
  filterMode: "all",
  // [FIX] was false. This is the actual, empirically confirmed reason a real reverse-engineering
  // session (2026-09-22) kept needing manual re-captures after every "click reveal, form-post
  // reveal, client-side redirect reveal" pattern: the auto-recapture wiring already existed
  // (pageLoaded/action handlers already call scheduleAutoSnapshot) but was silently off unless
  // explicitly toggled on in the popup for that session. For this tool's actual purpose -- never
  // missing the revealed state of a page -- an occasional extra snapshot is a far smaller cost
  // than missing the one that matters.
  autoSnapshot: true,
  primaryDomain: null,
  actions: [],
  networkLog: [],
  pending: {},
  xhrBodies: [],
  // [NEW] see background/script-capture.js and config.js's MAX_SCRIPT_BODIES comment --
  // populated by a background-side re-fetch of <script src="..."> URLs seen via
  // network-capture.js's onCompleted, since webRequest itself never exposes body content
  // for any resource type and page-hook.js's fetch/XHR wrapping doesn't see script-tag loads.
  scriptBodies: [],
  frameDocuments: [],
  userJourney: [],
  screenshots: [],
  contentPipeline: {
    source: '',
    movieList: [],
    downloadLinks: [],
    // [NEW] separate from downloadLinks above on purpose: downloadLinks only ever gets
    // populated once a REAL chrome.downloads event fires or savefiles.com's own page is
    // scraped -- i.e. only after the user has already clicked through to a resolved file.
    // encodedLinks holds links decoded straight out of the page's DOM (Wecima's
    // data-url/data-href-encoded watch-server and download-section entries) the moment
    // they appear, before anything is clicked -- see extractWecimaEncodedLinks() in
    // content.js for why these were invisible to every other capture path.
    encodedLinks: [],
    metadata: {},
    sequence: []
  },
  allowedDomains: [],
  blockedDomains: [],
  recordTabId: null,
  // [FIX-tabfollow] "Current Tab" mode used to pin capture to the single tabId that was
  // active the instant the user clicked Start. On ad-heavy Arabic streaming sites the real
  // video/stream request very often ends up firing in a NEW tab or popup window that the
  // site opens from that original tab (a "watch now" / ad-gate click), not in the original
  // tab itself -- every one of those requests was silently dropped by shouldRecordTab()
  // with no error, producing a clean "Network: 0" for an otherwise normal-looking session.
  // recordedTabIds holds the growing set of tab ids that currently count as "the tab being
  // recorded": seeded with recordTabId when recording starts, and grown by background.js's
  // chrome.tabs.onCreated listener whenever a new tab's openerTabId is already in this set
  // (so it also follows a popup-of-a-popup, transitively). Left empty / unused in "All
  // Tabs" mode (recordTabId === null), where shouldRecordTab() already accepts everything.
  recordedTabIds: [],
  challengeSolving: {}
};

export let saveTimeout = null;

// ═══ BROADCAST ═══
export function broadcastRecordingState(isRecording) {
  try {
    chrome.tabs.query({}, (tabs) => {
      if (chrome.runtime.lastError) {
        console.warn("[broadcast] Error querying tabs:", chrome.runtime.lastError.message);
        return;
      }
      for (const tab of tabs) {
        if (!tab.id) continue;
        chrome.tabs.sendMessage(tab.id, { type: "recordingStateChanged", recording: isRecording }, () => {
          void chrome.runtime.lastError;
        });
      }
    });
  } catch (e) {
    console.warn("[broadcast] Error:", e);
  }
}

// ═══ DOMAIN HELPERS ═══
export function registrableDomain(hostname) {
  if (!hostname || hostname === '') return null;

  // ═══ FIX: Skip non-web domains ═══
  const lower = hostname.toLowerCase();
  const skipDomains = [
    'newtab', 'localhost', '127.0.0.1', '0.0.0.0',
    'extensions', 'chrome', 'chrome-extension', 'chrome://',
    'about:', 'data:', 'blob:', 'file:'
  ];

  // Check if it's a non-web domain
  for (const skip of skipDomains) {
    if (lower.includes(skip)) return null;
  }

  // Check if it's an IP address
  if (/^\d+\.\d+\.\d+\.\d+$/.test(lower)) return null;

  const parts = hostname.split('.');

  // If it's a single word domain (like 'localhost')
  if (parts.length <= 1) return null;

  // If it's a two-part domain (like 'egydead.live')
  if (parts.length === 2) return hostname;

  // For longer domains, get the last two parts (registrable domain)
  // e.g., 'tv10.egydead.live' → 'egydead.live'
  // but 'sub.domain.co.uk' → 'domain.co.uk' (needs special handling)
  // For simplicity, we'll use the last two parts for most cases
  return parts.slice(-2).join('.');
}

export function isSameSite(urlStr) {
  const s = state;
  if (!s.primaryDomain) return true;
  try {
    const urlDomain = registrableDomain(new URL(urlStr).hostname);
    if (!urlDomain) return true;
    return urlDomain === s.primaryDomain;
  } catch (e) {
    return false;
  }
}

export function setPrimaryDomainFromUrl(urlStr) {
  if (!urlStr) return false;
  try {
    const url = new URL(urlStr);
    const domain = registrableDomain(url.hostname);
    if (domain) {
      state.primaryDomain = domain;
      console.log("[primaryDomain] Set to:", domain);
      return true;
    }
  } catch (e) {
    console.warn("[primaryDomain] Failed to set from URL:", urlStr, e);
  }
  return false;
}

// ═══ URL FILTERS ═══
export function shouldRecordUrl(url) {
  try {
    const hostname = new URL(url).hostname;
    const s = state;
    if (s.blockedDomains.some(d => hostname.includes(d))) return false;
    if (s.allowedDomains.length && !s.allowedDomains.some(d => hostname.includes(d))) return false;
    return true;
  } catch { return false; }
}

export function shouldRecordTab(tabId) {
  const s = state;
  if (s.recordTabId === null) return true;
  if (tabId === s.recordTabId) return true;
  // [FIX-tabfollow] was just the strict match above against the single tab that was active
  // at Start time. Now also accepts any tab that's been folded into recordedTabIds (a
  // popup/new tab opened from the recorded tab -- see addRecordedTab() below), so the real
  // stream request isn't silently dropped when the site opens the player in a new tab.
  return s.recordedTabIds.includes(tabId);
}

// [FIX-tabfollow] called from background.js's chrome.tabs.onCreated listener. No-op in
// "All Tabs" mode (recordTabId === null) since shouldRecordTab() already accepts every tab
// there and there is nothing to track.
export function addRecordedTab(tabId) {
  const s = state;
  if (s.recordTabId === null) return;
  if (typeof tabId !== "number") return;
  if (!s.recordedTabIds.includes(tabId)) {
    s.recordedTabIds.push(tabId);
    console.log("[tab-follow] Now also recording tab:", tabId, "(followed set:", s.recordedTabIds, ")");
    scheduleSave();
  }
}

export function passesFilter(resourceType) {
  const s = state;
  if (s.filterMode === "xhr") return resourceType === "xmlhttprequest";
  return true;
}

// ═══ REQUEST HELPERS ═══
export function safeBodyToString(requestBody) {
  if (!requestBody) return null;
  try {
    if (requestBody.raw) {
      const decoder = new TextDecoder("utf-8", { fatal: false });
      const chunks = requestBody.raw
        .map((r) => (r.bytes ? decoder.decode(r.bytes) : ""))
        .join("");
      return chunks.length > CONFIG.MAX_BODY_CHARS ? chunks.slice(0, CONFIG.MAX_BODY_CHARS) + "…[truncated]" : chunks;
    }
    if (requestBody.formData) return JSON.stringify(requestBody.formData);
  } catch (e) {
    return `[unreadable body: ${e.message}]`;
  }
  return null;
}

export function headersToObject(headerArray) {
  if (!headerArray) return {};
  const obj = {};
  for (const h of headerArray) {
    obj[h.name] = h.value !== undefined ? h.value : (h.binaryValue ? "[binary]" : "");
  }
  return obj;
}

// ═══ FILENAME HELPERS ═══
export function slugifyUrlForFilename(urlStr) {
  try {
    const u = new URL(urlStr);
    let path = (u.pathname + u.search).replace(/^\/+|\/+$/g, '');
    try { path = decodeURIComponent(path); } catch (e) {}
    let slug = path
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 80)
      .replace(/^-+|-+$/g, '');
    return slug || 'home';
  } catch (e) {
    return 'page';
  }
}

export function timestampForFilename() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// ═══ STATE PERSISTENCE ═══
export function buildPersistPayload() {
  const s = state;
  return {
    recording: s.recording,
    filterMode: s.filterMode,
    autoSnapshot: s.autoSnapshot,
    primaryDomain: s.primaryDomain,
    actions: s.actions.length > CONFIG.MAX_PERSISTED_ACTION_ENTRIES
      ? s.actions.slice(-CONFIG.MAX_PERSISTED_ACTION_ENTRIES).map(a => ({
          ...a,
          text: a.text ? a.text.substring(0, 500) : undefined,
          value: a.value ? a.value.substring(0, 500) : undefined,
          pageState: a.pageState ? JSON.stringify(a.pageState).substring(0, 500) : undefined
        }))
      : s.actions.map(a => ({
          ...a,
          text: a.text ? a.text.substring(0, 500) : undefined,
          value: a.value ? a.value.substring(0, 500) : undefined,
          pageState: a.pageState ? JSON.stringify(a.pageState).substring(0, 500) : undefined
        })),
    networkLog: s.networkLog.length > CONFIG.MAX_PERSISTED_NETWORK_ENTRIES
      ? s.networkLog.slice(-CONFIG.MAX_PERSISTED_NETWORK_ENTRIES).map(n => ({
          ...n,
          requestBody: n.requestBody ? n.requestBody.substring(0, 2000) : null,
          responseBody: n.responseBody ? n.responseBody.substring(0, 2000) : null
        }))
      : s.networkLog.map(n => ({
          ...n,
          requestBody: n.requestBody ? n.requestBody.substring(0, 2000) : null,
          responseBody: n.responseBody ? n.responseBody.substring(0, 2000) : null
        })),
    pending: s.pending,
    // [FIX] confirmed directly: xhrBodies was entirely absent from this
    // function's returned object, even though every sibling collection
    // (networkLog, actions, userJourney, contentPipeline, screenshots)
    // is persisted here. Manifest V3 service workers are ephemeral by
    // design -- Chrome can and does kill and restart them mid-session,
    // routinely, not as an edge case -- and restoreState() below
    // correctly brings every one of those siblings back after a
    // restart except this one, which was simply never saved in the
    // first place. This was a second, independent path to the exact
    // same "xhrBodies came back empty" symptom investigated and fixed
    // elsewhere this session (the page-hook.js/websocket-hook.js race
    // condition) -- fixing the race alone does not help if a restart
    // during the session still discards everything captured so far.
    // [FIX] was re-truncating every body down to 2000 chars here, on
    // top of whatever cap page-hook.js already applied live (confirmed
    // up to MAX_BODY_CHARS -- 100000 by default, user-configurable up
    // to 1024000 via options.html). That silently threw away most of a
    // real captured API response on every service-worker restart --
    // confirmed directly, 2026-10-13: a real n1mwq.org /embed/playback
    // JSON response (a few KB, well under the live cap) came back cut
    // off mid-object in a downloaded recording, specifically because
    // a restart had round-tripped it through this 2000-char persist
    // cap before the download happened, forcing a manual re-capture
    // from DevTools instead of the recording just having it. The
    // extension already declares "unlimitedStorage" in its manifest
    // (chrome.storage.local has no meaningful quota under it), and
    // persistState() below still has a QUOTA_BYTES fallback to a
    // smaller "minimal" state if storage ever does fail -- so there's
    // no real budget reason to truncate harder than the live capture
    // already does. Capping at CONFIG.MAX_BODY_CHARS instead keeps
    // "what got captured" and "what survives a restart" the same
    // size, whatever the user has that set to.
    xhrBodies: s.xhrBodies.slice(-CONFIG.MAX_XHR_BODIES_SIZE).map(x => ({
      ...x,
      body: x.body ? x.body.substring(0, CONFIG.MAX_BODY_CHARS) : x.body
    })),
    // [NEW] mirrors xhrBodies immediately above, same reasoning: without this, a
    // service-worker restart mid-session would silently discard every script body
    // captured so far, same bug class as the xhrBodies persistence gap fixed earlier.
    scriptBodies: s.scriptBodies.slice(-CONFIG.MAX_SCRIPT_BODIES).map(x => ({
      ...x,
      // [FIX] must use the same (larger) cap as script-capture.js, or a service-worker
      // restart would silently re-truncate big bundles to the API-response limit.
      body: x.body ? x.body.substring(0, Math.max(CONFIG.MAX_BODY_CHARS, CONFIG.MAX_SCRIPT_BODY_CHARS)) : x.body
    })),
    frameDocuments: (s.frameDocuments || []).slice(-CONFIG.MAX_FRAME_DOCS),
    userJourney: s.userJourney.slice(-100),
    contentPipeline: {
      ...s.contentPipeline,
      movieList: s.contentPipeline.movieList ? s.contentPipeline.movieList.slice(0, 50) : [],
      downloadLinks: s.contentPipeline.downloadLinks ? s.contentPipeline.downloadLinks.slice(0, 20) : [],
      encodedLinks: s.contentPipeline.encodedLinks ? s.contentPipeline.encodedLinks.slice(-50) : [],
      sequence: s.contentPipeline.sequence ? s.contentPipeline.sequence.slice(0, 100) : []
    },
    screenshots: s.screenshots.slice(-CONFIG.MAX_SCREENSHOTS).map(s => ({
      timestamp: s.timestamp,
      tabId: s.tabId,
      dataUrl: s.dataUrl ? s.dataUrl.substring(0, 100) + '...' : null
    })),
    recordTabId: s.recordTabId,
    // [FIX-tabfollow] persisted alongside recordTabId so a service-worker restart mid-session
    // doesn't forget which popup/new tabs have already been folded into the recording scope.
    recordedTabIds: s.recordedTabIds,
    allowedDomains: s.allowedDomains,
    blockedDomains: s.blockedDomains
  };
}

export function persistState() {
  try {
    const payload = buildPersistPayload();

    try {
      chrome.storage.session.set({ srStateBackup: payload }).catch(() => {});
    } catch (e) {}

    // [FIX] every .slice(0, N) below used to take the FIRST N entries of
    // payload.* -- but payload.* (built by buildPersistPayload() above)
    // is already trimmed down to the most recent entries when it's long,
    // so re-slicing from the front here threw away exactly the newest,
    // most relevant data (the actual stream URL, captured late in a
    // session) and kept whatever was oldest instead (page-load junk:
    // ads, trackers, analytics). This is the copy that actually survives
    // a service-worker restart (chrome.storage.local, not the in-memory
    // state), so the bug only bit intermittently -- exactly when a
    // restart happened to land mid-session -- which is why "Stream
    // Links" worked sometimes and not others on the exact same site.
    // Switched every one of these to .slice(-N), keeping the most recent
    // N entries, consistent with how buildPersistPayload(), encodedLinks
    // just below, and cleanupMemory() all already do it.
    const compressed = {
      recording: payload.recording,
      filterMode: payload.filterMode,
      autoSnapshot: payload.autoSnapshot,
      primaryDomain: payload.primaryDomain,
      actions: payload.actions.slice(-50),
      networkLog: payload.networkLog.slice(-50),
      xhrBodies: payload.xhrBodies.slice(-50),
      scriptBodies: payload.scriptBodies.slice(-50),
      frameDocuments: (payload.frameDocuments || []).slice(-20),
      userJourney: payload.userJourney.slice(-50),
      contentPipeline: {
        source: payload.contentPipeline.source || '',
        movieList: payload.contentPipeline.movieList ? payload.contentPipeline.movieList.slice(-20) : [],
        downloadLinks: payload.contentPipeline.downloadLinks ? payload.contentPipeline.downloadLinks.slice(-10) : [],
        encodedLinks: payload.contentPipeline.encodedLinks ? payload.contentPipeline.encodedLinks.slice(-30) : [],
        metadata: payload.contentPipeline.metadata || {},
        sequence: payload.contentPipeline.sequence ? payload.contentPipeline.sequence.slice(-50) : []
      },
      screenshots: payload.screenshots.slice(-10),
      recordTabId: payload.recordTabId,
      recordedTabIds: payload.recordedTabIds || [],
      allowedDomains: payload.allowedDomains || [],
      blockedDomains: payload.blockedDomains || []
    };

    try {
      chrome.storage.local.set({ srState: compressed }).catch((e) => {
        if (e.message && e.message.includes('QUOTA_BYTES')) {
          console.warn('Storage quota exceeded, saving minimal state');
          const minimal = {
            recording: payload.recording,
            filterMode: payload.filterMode,
            autoSnapshot: payload.autoSnapshot,
            primaryDomain: payload.primaryDomain,
            actions: payload.actions.slice(-20),
            networkLog: payload.networkLog.slice(-20),
            recordTabId: payload.recordTabId,
            recordedTabIds: payload.recordedTabIds || [],
            allowedDomains: payload.allowedDomains || [],
            blockedDomains: payload.blockedDomains || []
          };
          chrome.storage.local.set({ srState: minimal }).catch(() => {});
        }
      });
    } catch (e) {
      console.warn('Failed to persist to local storage:', e);
    }
  } catch (e) {
    console.warn('Failed to persist recording state:', e);
  }
}

export function scheduleSave() {
  if (saveTimeout) return;
  saveTimeout = setTimeout(() => {
    saveTimeout = null;
    persistState();
  }, 1000);
}

export function restoreState(savedState) {
  if (!savedState) return;
  try {
    const s = state;
    s.recording = !!savedState.recording;
    s.filterMode = savedState.filterMode || "all";
    s.autoSnapshot = !!savedState.autoSnapshot;
    s.primaryDomain = savedState.primaryDomain || null;
    s.actions = savedState.actions || [];
    s.networkLog = savedState.networkLog || [];
    s.pending = savedState.pending || {};
    // [FIX] see buildPersistPayload() above -- this brings xhrBodies
    // back after a service-worker restart the same way every sibling
    // collection already does, instead of silently staying empty.
    s.xhrBodies = savedState.xhrBodies || [];
    // [NEW] mirrors xhrBodies restore immediately above, same reasoning.
    s.scriptBodies = savedState.scriptBodies || [];
    s.frameDocuments = savedState.frameDocuments || [];
    s.userJourney = savedState.userJourney || [];
    s.contentPipeline = savedState.contentPipeline || { source: '', movieList: [], downloadLinks: [], encodedLinks: [], metadata: {}, sequence: [] };
    // [FIX] a savedState from before this field existed (an older persisted
    // session) has a contentPipeline object but no encodedLinks key on it --
    // the `||` above only covers contentPipeline being entirely absent, not
    // this field being missing from an otherwise-present one.
    if (!s.contentPipeline.encodedLinks) s.contentPipeline.encodedLinks = [];
    s.screenshots = savedState.screenshots || [];
    s.recordTabId = savedState.recordTabId || null;
    // [FIX-tabfollow] recordTabId itself is already checked directly by shouldRecordTab(), so
    // this only needs the EXTRA followed tabs; a savedState from before this field existed
    // just has none yet, same as a fresh recording before any popup has opened.
    s.recordedTabIds = savedState.recordedTabIds || [];
    s.allowedDomains = savedState.allowedDomains || [];
    s.blockedDomains = savedState.blockedDomains || [];
  } catch (e) {
    console.warn('Failed to restore state:', e);
  }
}

// ═══ STATE-READY GATE ═══
// [FIX] Manifest V3 service workers are ephemeral: Chrome kills this one after
// ~30s of idle (routine, not an edge case -- a Wecima-style flow full of ad
// pages, countdowns, and CF challenges blows past that constantly during a
// single recording session) and the NEXT matching event (very often the very
// webRequest event that needed to be captured) is what spins a brand-new
// instance back up, re-running this whole module from scratch with `state`
// back at its hardcoded defaults (recording: false, networkLog: [], ...).
// restoreState() was previously only ever invoked from background.js's own
// top-level async IIFE, AFTER network-capture.js's listeners were already
// registered and already eligible to fire -- a real race, not a hypothetical
// one, between that chrome.storage.local.get() resolving and the very
// webRequest event that woke this worker up being dispatched to a listener
// that reads `s.recording` before the restore has landed. Exported here so
// every consumer (network-capture.js above all) can await the SAME promise
// before touching `state`, instead of each re-implementing its own restore
// call or, worse, not knowing it needs to.
export const stateReadyPromise = (async () => {
  try {
    const stored = await chrome.storage.local.get(['srState']);
    if (stored && stored.srState) {
      restoreState(stored.srState);
      console.log("Restored recording state from local storage");
      return;
    }
    const session = await chrome.storage.session.get(['srStateBackup']);
    if (session && session.srStateBackup) {
      restoreState(session.srStateBackup);
      console.log("Restored recording state from session backup");
    }
  } catch (e) {
    console.warn('Failed to restore recording state:', e);
  }
})();

export function cleanupMemory() {
  try {
    const s = state;
    if (s.networkLog.length > CONFIG.MAX_NETWORK_LOG_SIZE) {
      s.networkLog = s.networkLog.slice(-CONFIG.MAX_NETWORK_LOG_SIZE);
    }
    if (s.xhrBodies.length > CONFIG.MAX_XHR_BODIES_SIZE) {
      s.xhrBodies = s.xhrBodies.slice(-CONFIG.MAX_XHR_BODIES_SIZE);
    }
    if (s.scriptBodies.length > CONFIG.MAX_SCRIPT_BODIES) {
      s.scriptBodies = s.scriptBodies.slice(-CONFIG.MAX_SCRIPT_BODIES);
    }
    if (s.frameDocuments && s.frameDocuments.length > CONFIG.MAX_FRAME_DOCS) {
      s.frameDocuments = s.frameDocuments.slice(-CONFIG.MAX_FRAME_DOCS);
    }
    if (s.screenshots.length > CONFIG.MAX_SCREENSHOTS) {
      s.screenshots = s.screenshots.slice(-CONFIG.MAX_SCREENSHOTS);
    }
    if (s.actions.length > CONFIG.MAX_PERSISTED_ACTION_ENTRIES * 2) {
      s.actions = s.actions.slice(-CONFIG.MAX_PERSISTED_ACTION_ENTRIES);
    }
    if (s.userJourney.length > 200) {
      s.userJourney = s.userJourney.slice(-200);
    }
    if (s.contentPipeline.encodedLinks && s.contentPipeline.encodedLinks.length > 300) {
      s.contentPipeline.encodedLinks = s.contentPipeline.encodedLinks.slice(-150);
    }
    persistState();
  } catch (e) {
    console.warn('Cleanup error:', e);
  }
}

if (CONFIG && CONFIG.AUTO_CLEANUP_INTERVAL) {
  setInterval(() => {
    cleanupMemory();
  }, CONFIG.AUTO_CLEANUP_INTERVAL);
}

// popup.js – Stream Recorder Pro with ALL improvements

let currentRecordingData = null;
let streamLinks = [];
let isExporting = false;

const startBtn = document.getElementById("start");
const stopBtn = document.getElementById("stop");
const exportBtn = document.getElementById("export");
const exportMarkdownBtn = document.getElementById("exportMarkdown");
const copyBtn = document.getElementById("copy");
const solveBtn = document.getElementById("solveChallenge");
const saveSnapshotBtn = document.getElementById("saveSnapshot");
const copyStreamLinksBtn = document.getElementById("copyStreamLinks");
const extractYTSTorrentsBtn = document.getElementById("extractYTSTorrents");
const extractArabicMoviesBtn = document.getElementById("extractArabicMovies");
const extractSaveFilesBtn = document.getElementById("extractSaveFiles");
const findTorrentApiBtn = document.getElementById("findTorrentApi");
const viewPipelineBtn = document.getElementById("viewPipeline");
const statusDiv = document.getElementById("status");
const challengeStatusDiv = document.getElementById("challengeStatus");
const jsonPreview = document.getElementById("jsonPreview");
const xhrOnlyCheckbox = document.getElementById("xhrOnly");
const filterHint = document.getElementById("filterHint");
const autoSnapshotCheckbox = document.getElementById("autoSnapshot");
const hideTMDBCheckbox = document.getElementById("hideTMDB");
const recordTabSelect = document.getElementById("recordTab");
const progressFill = document.getElementById("progressFill");
const torrentResultsDiv = document.getElementById("torrentResults");
const optionsLink = document.getElementById("optionsLink");
const popOutBtn = document.getElementById("popOutBtn");
const detachedHint = document.getElementById("detachedHint");
const minimizeBtn = document.getElementById("minimizeBtn");
const recBadge = document.getElementById("recBadge");

// Popout window support
// [FIX-popoutplacement] Chrome/Brave's download-complete notification renders in the toolbar
// area (top-right, near the extensions icons), and chrome.windows.create() with no left/top
// given just lets the browser pick wherever it feels like -- which in practice often lands
// the detached window right where that notification shows up, covering it (or getting covered
// by it) every time a snapshot auto-saves. Two things fix this: (1) default to opening in the
// top-left corner instead, well clear of that area, and (2) remember wherever the user
// actually drags/resizes it to afterward (via chrome.windows.onBoundsChanged, saved to
// chrome.storage.local), so once they've found a good spot it reopens there every time instead
// of snapping back to the default.
const POPOUT_BOUNDS_KEY = "popoutBounds";
const DEFAULT_POPOUT_BOUNDS = { left: 20, top: 20, width: 500, height: 820 };

chrome.windows.getCurrent((win) => {
  if (win.type === "popup") {
    popOutBtn.style.display = "none";
    detachedHint.style.display = "block";
    // [FIX-minimize] Chrome strips the normal window chrome (menu/tabs/address bar) from a
    // popup-type window but still gives it minimize/maximize/close controls on most
    // platforms -- however those can be easy to miss or absent depending on OS theme, and the
    // user asked for an explicit, reliable way to get this out of the way of the screen
    // without closing it (losing the in-progress recording UI). chrome.windows.update's
    // "minimized" state works on popup-type windows exactly like normal ones; restoring is
    // native OS behavior afterward (taskbar entry on Windows/Linux, Dock on macOS), same as
    // any other minimized window -- nothing more for this extension to do there.
    minimizeBtn.style.display = "inline-block";

    // Debounced save of this window's current position/size, any time the user moves or
    // resizes it -- at most once per 500ms, so dragging doesn't spam chrome.storage.local.
    let saveTimeout = null;
    const saveBounds = () => {
      chrome.windows.get(win.id, (current) => {
        if (chrome.runtime.lastError || !current) return;
        chrome.storage.local.set({
          [POPOUT_BOUNDS_KEY]: {
            left: current.left, top: current.top,
            width: current.width, height: current.height
          }
        });
      });
    };
    if (chrome.windows.onBoundsChanged) {
      chrome.windows.onBoundsChanged.addListener((changedWin) => {
        if (changedWin.id !== win.id) return;
        clearTimeout(saveTimeout);
        saveTimeout = setTimeout(saveBounds, 500);
      });
    }
  }
});

minimizeBtn.onclick = () => {
  chrome.windows.getCurrent((win) => {
    chrome.windows.update(win.id, { state: "minimized" });
  });
};

popOutBtn.onclick = () => {
  chrome.storage.local.get([POPOUT_BOUNDS_KEY], (result) => {
    const saved = result[POPOUT_BOUNDS_KEY];
    const bounds = (saved && typeof saved.left === "number") ? saved : DEFAULT_POPOUT_BOUNDS;
    chrome.windows.create({
      url: chrome.runtime.getURL("popup.html"),
      type: "popup",
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
      height: bounds.height,
      focused: true
    });
    window.close();
  });
};

// Load saved preferences
// [CHANGE] Auto-snapshot, "Record: Current Tab/All Tabs" and the XHR-only filter now start
// from the Options page defaults EVERY time the popup opens. Previously the popup never read
// those Options settings at all and fell back to auto-snapshot OFF and "All Tabs", so they
// had to be re-set by hand before every recording (and were easy to forget). You can still
// change them in the popup for one recording; they reset to the Options defaults next time.
// While a recording is running, getRecordingStatus below overrides these with the live values.
chrome.storage.local.get(["hideTMDB"], (result) => {
  hideTMDBCheckbox.checked = result.hideTMDB !== false;
});
chrome.storage.sync.get(["defaultRecordingMode", "defaultFilterMode", "autoSnapshotDefault"], (defaults) => {
  // Ask first whether a recording is live: if it is, the popup must show (and never alter)
  // that session's real settings, which the getRecordingStatus handler below fills in.
  // Nothing is sent to the background here -- Start passes these values when it is clicked.
  chrome.runtime.sendMessage({ type: "getRecordingStatus" }, (status) => {
    void chrome.runtime.lastError;
    if (status && status.recording) return;
    xhrOnlyCheckbox.checked = (defaults.defaultFilterMode || "all") === "xhr";
    autoSnapshotCheckbox.checked = defaults.autoSnapshotDefault !== false;   // default ON
    recordTabSelect.value = defaults.defaultRecordingMode || "current";      // default Current Tab
    updateFilterHint();
  });
});

xhrOnlyCheckbox.onchange = () => {
  chrome.storage.local.set({ xhrOnly: xhrOnlyCheckbox.checked });
  updateFilterHint();
};

autoSnapshotCheckbox.onchange = () => {
  chrome.storage.local.set({ autoSnapshot: autoSnapshotCheckbox.checked });
  chrome.runtime.sendMessage({ type: "autoSnapshotToggled", enabled: autoSnapshotCheckbox.checked });
};

hideTMDBCheckbox.onchange = () => {
  chrome.storage.local.set({ hideTMDB: hideTMDBCheckbox.checked });
};

recordTabSelect.onchange = () => {
  chrome.storage.local.set({ recordTab: recordTabSelect.value });
};

function updateFilterHint() {
  filterHint.innerText = xhrOnlyCheckbox.checked
    ? "(only XHR/fetch calls captured)"
    : "(unchecked = capture everything)";
}

// Get current recording status
chrome.runtime.sendMessage({ type: "getRecordingStatus" }, (response) => {
  if (response && response.recording) {
    setRecordingUI(true, response.filterMode);
    autoSnapshotCheckbox.checked = !!response.autoSnapshot;
    if (response.recordTabId) {
      recordTabSelect.value = "current";
    }
  }
});

function setRecordingUI(isRecording, filterMode) {
  xhrOnlyCheckbox.disabled = isRecording;
  autoSnapshotCheckbox.disabled = isRecording;
  recordTabSelect.disabled = isRecording;
  if (isRecording) {
    recBadge.textContent = "🔴 REC";
    recBadge.className = "badge badge-rec";
    statusDiv.innerText = filterMode === "xhr" ? "🔴 Recording (XHR/Fetch only)..." : "🔴 Recording (everything + SPA + WebSocket)...";
    statusDiv.style.background = "#2e7d32";
    startBtn.disabled = true;
    stopBtn.disabled = false;
  } else {
    recBadge.textContent = "⏹ Stopped";
    recBadge.className = "badge";
    statusDiv.style.background = "#161B22";
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }
}

// ═══ START RECORDING ═══
startBtn.onclick = () => {
  const filterMode = xhrOnlyCheckbox.checked ? "xhr" : "all";
  const autoSnapshot = autoSnapshotCheckbox.checked;
  const useCurrentTabOnly = recordTabSelect.value === "current";

  const startWith = (tabId) => {
    chrome.storage.sync.get(['allowedDomains', 'blockedDomains', 'maxBodySize', 'reloadOnStart'], (cfg) => {
      chrome.runtime.sendMessage({
        type: "startRecording",
        filterMode,
        autoSnapshot,
        reloadOnStart: cfg.reloadOnStart !== false,
        tabId: tabId,
        allowedDomains: cfg.allowedDomains || [],
        blockedDomains: cfg.blockedDomains || [],
        maxBodySize: cfg.maxBodySize || 1000
      });
    });
  };

  if (useCurrentTabOnly) {
    // [FIX-popupwindow] was chrome.tabs.query({ active: true, currentWindow: true }) --
    // `currentWindow` resolves to whatever window THIS SCRIPT is running in. Every other
    // button in this file that needs "the site tab" (solveBtn, extractYTSTorrentsBtn,
    // extractArabicMoviesBtn, extractSaveFilesBtn) already avoids this by querying
    // getLastFocused with windowTypes: ["normal"] -- but this one didn't, and it's the one
    // that actually sets recordTabId for the whole recording session. Confirmed directly via
    // diagnostic logging: when the popup is detached into its own window (the "pop out"
    // button right above specifically supports this, exactly so the recorder can stay open
    // while browsing), clicking Start Recording from inside that detached popup window makes
    // `currentWindow` resolve to the POPUP's own window -- so tabs[0] came back as popup.html
    // itself (confirmed: tabId 70605048, popup.html's own tab) instead of the actual site tab
    // (70605004) in the real browser window. shouldRecordTab() then silently rejected every
    // single real network request for the whole session with no error at all -- a clean
    // "Actions: 16, Network: 0" that looked exactly like a filtering bug, but had nothing to
    // do with filterMode, allowedDomains, or the recordedTabIds tab-follow logic investigated
    // earlier. windowTypes: ["normal"] excludes popup/devtools windows, so this always finds
    // the real browser window's active tab regardless of whether the popup is docked or
    // popped out.
    chrome.windows.getLastFocused({ windowTypes: ["normal"], populate: true }, (win) => {
      const tab = (win && win.tabs || []).find(t => t.active);
      startWith(tab ? tab.id : null);
    });
  } else {
    startWith(null);
  }

  setRecordingUI(true, filterMode);
  jsonPreview.value = "";
  currentRecordingData = null;
  streamLinks = [];
  torrentResultsDiv.innerHTML = "";
  torrentResultsDiv.style.display = "none";
  progressFill.style.width = "0%";
};

// ═══ STOP RECORDING ═══
stopBtn.onclick = () => {
  chrome.runtime.sendMessage({ type: "stopRecording" });
  setRecordingUI(false);
  statusDiv.innerText = "⏹ Stopped. Fetching data...";
  progressFill.style.width = "30%";
  
  chrome.runtime.sendMessage({ type: "getRecordingData" }, (response) => {
    if (response && response.data) {
      currentRecordingData = withRequestContext(response.data);
      const jsonStr = JSON.stringify(currentRecordingData, null, 2);
      jsonPreview.value = jsonStr;
      statusDiv.innerText = `✅ Ready. ${currentRecordingData.actions?.length || 0} actions, ${currentRecordingData.networkLog?.length || 0} network entries.`;
      // [4.7.0] the extractor generator can only find a site's search if the
      // recording contains one -- remind, since it's easy to forget
      const _acts = currentRecordingData.actions || [];
      const _net = currentRecordingData.networkLog || [];
      const _searched = _acts.some(a => a && a.type === 'type') ||
        _net.some(e => e && /[?&](?:s|q|query|keyword|search)=|\/search\b/i.test(e.url || '') && !/google|bing|yandex|analytics/i.test(e.url || ''));
      if (!_searched) {
        statusDiv.innerText += "\n💡 No search recorded -- for an extractor, record again and type a title in the site's own search box.";
      }
      progressFill.style.width = "100%";
      setTimeout(() => { progressFill.style.width = "0%"; }, 1000);
    } else {
      statusDiv.innerText = "❌ No recording data found.";
      jsonPreview.value = "";
      progressFill.style.width = "0%";
    }
  });
};

// ═══ EXPORT SCOPE (large sessions -> smaller, focused files) ═══
const exportScopeSelect = document.getElementById("exportScope");

// The top-level sections a recording can be split into, in the order they should download.

// ═══ [4.6.0] requestContext: what a stream request depended on ═══════════════════
// Built from networkLog at export time (no extra recording needed):
//  frameMap        every page/iframe load: frame id, parent frame, address, redirects
//  redirects       each HTTP redirect hop (from -> to, status) -- e.g. a player
//                  frame on mixdrop.ps that actually opened on mxdrop.click
//  streamRequests  each video/playlist request next to the request of the page
//                  (frame) that issued it, for the headers players get checked on;
//                  "differs" lists those whose value changed between the two (a token
//                  tied to Accept-Language broke LuluStream when they didn't match)
//  cookiesByDomain cookies each domain set (all Set-Cookie headers) and the cookie
//                  names sent to it
const _CTX_HEADERS = ['User-Agent', 'Accept-Language', 'Referer', 'Origin', 'Cookie',
  'Sec-Fetch-Dest', 'Sec-Fetch-Mode', 'Sec-Fetch-Site', 'sec-ch-ua', 'Accept', 'Range'];
const _CTX_STREAM_RE = /\.(m3u8|mpd|mp4|mkv|webm|ts|m4s)(\?|$)|\/hls\d?\/|\/playlist|master\.txt|\/get_video|\/manifest/i;

function _hdr(obj, name) {
  if (!obj) return undefined;
  const want = name.toLowerCase();
  for (const k of Object.keys(obj)) if (k.toLowerCase() === want) return obj[k];
  return undefined;
}

function _host(u) {
  try { return new URL(u).hostname; } catch (e) { return ''; }
}

function _ctxBytes(e) {
  // bytes actually delivered: Content-Range span, else Content-Length
  const cr = String(_hdr(e.responseHeaders, 'content-range') || '');
  const m = cr.match(/bytes\s+(\d+)-(\d+)/i);
  if (m) return Number(m[2]) - Number(m[1]) + 1;
  const cl = Number(_hdr(e.responseHeaders, 'content-length') || 0);
  return cl > 0 ? cl : 0;
}

function buildRequestContext(data) {
  const log = Array.isArray(data && data.networkLog) ? data.networkLog : [];
  const byTime = log.slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  // frames: latest document load per tab+frame, with every address it loaded
  const frames = {};
  for (const e of byTime) {
    if (e.type !== 'main_frame' && e.type !== 'sub_frame') continue;
    if (e.redirectUrl && e.statusCode >= 300 && e.statusCode < 400) continue;  // a hop, not the load
    const k = e.tabId + ':' + e.frameId;
    const f = frames[k] || { tabId: e.tabId, frameId: e.frameId, parentFrameId: e.parentFrameId ?? null, loads: [] };
    f.url = e.url;
    f.status = e.statusCode;
    f.requestHeaders = e.requestHeaders || {};
    f.redirectedFrom = e.redirectChain && e.redirectChain.length > 1 ? e.redirectChain[0] : (e.redirectedFrom || null);
    f.loads.push(e.url);
    if (e.parentFrameId !== undefined && e.parentFrameId !== null) f.parentFrameId = e.parentFrameId;
    frames[k] = f;
  }
  const frameMap = Object.values(frames).map(f => {
    const parent = frames[f.tabId + ':' + f.parentFrameId];
    return {
      tabId: f.tabId, frameId: f.frameId, parentFrameId: f.parentFrameId,
      parentUrl: parent ? parent.url : null,
      url: f.url, redirectedFrom: f.redirectedFrom, status: f.status,
      loads: f.loads.length > 1 ? f.loads : undefined,
    };
  });

  const redirects = byTime
    .filter(e => e.redirectUrl && e.statusCode >= 300 && e.statusCode < 400)
    .map(e => ({ from: e.url, to: e.redirectUrl, status: e.statusCode, type: e.type, frameId: e.frameId }));

  const seen = new Set();
  const streamRequests = [];
  for (const e of byTime) {
    const ctype = String(_hdr(e.responseHeaders, 'content-type') || '').toLowerCase();
    const isStream = e.type === 'media' || _CTX_STREAM_RE.test(e.url || '') ||
      /^video\/|mpegurl|dash\+xml/.test(ctype);
    if (!isStream || e.type === 'main_frame' || e.type === 'sub_frame' || e.type === 'script') continue;
    let key;
    try { const u = new URL(e.url); key = u.host + u.pathname; } catch (x) { key = e.url; }
    if (seen.has(key)) continue;
    seen.add(key);
    const page = frames[e.tabId + ':' + e.frameId];
    const pageH = {}, streamH = {}, differs = [];
    for (const name of _CTX_HEADERS) {
      const pv = page ? _hdr(page.requestHeaders, name) : undefined;
      const sv = _hdr(e.requestHeaders, name);
      if (pv !== undefined) pageH[name] = name === 'Cookie' ? String(pv).slice(0, 200) : pv;
      if (sv !== undefined) streamH[name] = name === 'Cookie' ? String(sv).slice(0, 200) : sv;
      if (pv !== undefined && pv !== sv && !['Referer', 'Accept', 'Sec-Fetch-Dest', 'Sec-Fetch-Mode', 'Range'].includes(name)) {
        differs.push(name);
      }
    }
    streamRequests.push({
      url: e.url, status: e.statusCode, type: e.type, contentType: ctype || undefined,
      frameUrl: page ? page.url : null,
      pageRequestHeaders: pageH,
      streamRequestHeaders: streamH,
      differs: differs,
      durationMs: e.durationMs,
      bytes: _ctxBytes(e) || undefined,
      acceptRanges: _hdr(e.responseHeaders, 'accept-ranges'),
      contentRange: _hdr(e.responseHeaders, 'content-range'),
      allowOrigin: _hdr(e.responseHeaders, 'access-control-allow-origin'),
    });
    if (streamRequests.length >= 60) break;
  }

  // [4.7.0] per video-server host: how many requests the player made, how much
  // they carried, how fast -- many small slow requests = a player reconnecting
  // to a slow server (what made Mixdrop stutter on the box)
  const cdnStats = {};
  for (const e of byTime) {
    const ctype = String(_hdr(e.responseHeaders, 'content-type') || '').toLowerCase();
    const isStream = e.type === 'media' || _CTX_STREAM_RE.test(e.url || '') || /^video\/|mpegurl/.test(ctype);
    if (!isStream || e.type === 'main_frame' || e.type === 'sub_frame' || e.type === 'script') continue;
    const h = _host(e.url);
    if (!h) continue;
    const st = cdnStats[h] || (cdnStats[h] = { requests: 0, ranged: 0, bytes: 0, ms: 0, errors: 0 });
    st.requests += 1;
    if (_hdr(e.requestHeaders, 'Range')) st.ranged += 1;
    if (e.error || (e.statusCode && e.statusCode >= 400)) st.errors += 1;
    const b = _ctxBytes(e);
    if (b && e.durationMs) { st.bytes += b; st.ms += e.durationMs; }
  }
  for (const h of Object.keys(cdnStats)) {
    const st = cdnStats[h];
    st.avgKBps = st.ms ? Math.round(st.bytes / st.ms) : null;   // bytes per ms = KB/s
    st.mb = Math.round(st.bytes / 1e5) / 10;
    delete st.ms;
  }

  const cookiesByDomain = {};
  const dom = (h) => (cookiesByDomain[h] = cookiesByDomain[h] || { set: {}, sent: [] });
  for (const e of byTime) {
    const h = _host(e.url);
    if (!h) continue;
    const sets = e.setCookies || (_hdr(e.responseHeaders, 'set-cookie') ? [_hdr(e.responseHeaders, 'set-cookie')] : []);
    for (const c of sets) {
      const first = String(c).split(';')[0];
      const i = first.indexOf('=');
      if (i <= 0) continue;
      const name = first.slice(0, i).trim();
      const d = dom(h);
      if (!(name in d.set)) d.set[name] = { value: first.slice(i + 1).slice(0, 80), attrs: String(c).split(';').slice(1).map(x => x.trim()).filter(Boolean).join('; '), setBy: e.url };
    }
    const sent = _hdr(e.requestHeaders, 'Cookie');
    if (sent) {
      const d = dom(h);
      for (const part of String(sent).split(';')) {
        const name = part.split('=')[0].trim();
        if (name && !d.sent.includes(name)) d.sent.push(name);
      }
    }
  }

  return { frameMap, redirects, streamRequests, cdnStats, cookiesByDomain };
}

function withRequestContext(data) {
  try {
    if (data && Array.isArray(data.networkLog) && data.networkLog.length) {
      data.requestContext = buildRequestContext(data);
    }
  } catch (e) {
    console.warn('requestContext failed', e);
  }
  return data;
}

const EXPORT_SECTIONS = [
  { key: 'networkLog', label: 'networkLog' },
  { key: 'xhrBodies', label: 'xhrBodies' },
  { key: 'scriptBodies', label: 'scriptBodies' },
  { key: 'frameDocuments', label: 'frameDocuments' },
  { key: 'actions', label: 'actions' },
  { key: 'userJourney', label: 'userJourney' },
  { key: 'contentPipeline', label: 'contentPipeline' },
  // [FIX] screenshots were entirely missing from this list -- meaning the "Split" export
  // scope (built specifically for sessions too large for one file) silently dropped every
  // screenshot completely, while the regular "all" JSON export correctly included them. This
  // matters more now that screenshots carry their full image data instead of a 100-character
  // truncated stub (see the getRecordingData/getScreenshots fix in message-handlers.js) --
  // full-size screenshots are exactly the kind of data that makes a session large enough to
  // need splitting in the first place. The existing chunking logic below already handles any
  // array-valued section generically, so this needed no other change to work correctly.
  { key: 'screenshots', label: 'screenshots' },
  // [4.6.0] frame map, redirects, page-vs-stream headers, cookies (see buildRequestContext)
  { key: 'requestContext', label: 'requestContext' },
];

// Returns a smaller data object containing only what the chosen scope asks for. "all" and
// "split" both return the full object -- "split" needs every section available so it can
// hand each one to a separate download; only single-section scopes actually filter anything.
// This is deliberately just a filter in front of the EXISTING export functions (exportAsCSV /
// exportAsHAR / exportAsMarkdown / plain JSON.stringify) rather than a rewrite of them, so
// every format keeps working exactly as it did before for anyone who leaves scope on "all".
function getScopedData(data, scope) {
  if (scope === 'all' || scope === 'split' || !scope) return data;
  if (scope === 'actions') {
    // "Actions / Journey" is a combined view since both describe user-driven navigation.
    return { actions: data.actions || [], userJourney: data.userJourney || [] };
  }
  if (EXPORT_SECTIONS.some(s => s.key === scope)) {
    return { [scope]: data[scope] };
  }
  return data;
}

function sizeLabel(str) {
  const bytes = str.length;
  if (bytes > 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  if (bytes > 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

// [FIX-bloburl] every saveAs:false edit in this file (and the matching one already
// applied to the background "export" message handler -- see its own comment) stopped
// the dialog-stacking problem but the random-UUID filenames kept happening anyway,
// confirmed directly from real device logs on this user's actual browser (Brave).
// Root cause is one level further back than saveAs or the premature-revoke timing
// below: this function built a blob: object URL (URL.createObjectURL), and Brave's
// "blob URL partitioning" privacy feature silently breaks Chrome's ability to resolve
// the filename actually passed to downloads.download() for a blob: URL -- it falls
// straight back to the blob's own random UUID instead, regardless of saveAs or timing.
// The one pattern proven correct in every device log, in both the snapshot path
// (screenshot.js, always used a data: URL) and the background export handler once it
// switched over, is a data: URL instead of blob:.
//
// [FIX-bloburl2] switching to a data: URL (above) stopped the random UUIDs, but confirmed
// directly from a follow-up device log: every one of these downloads still came out named
// after its own MIME type instead ("download.json", "download.pyw", ...) -- Brave doesn't
// honor downloads.download()'s own `filename` option for a data: URL either, full stop.
// The only download that was ever safe is the HTML snapshot, and only because
// background.js's onDeterminingFilename listener explicitly re-suggests the real name
// instead of trusting Chrome/Brave. That override has to happen in the SAME JS context as
// the listener (the background service worker) to avoid a race -- this popup page can't
// register the expected filename for the listener to find in time. So instead of calling
// chrome.downloads.download() here directly, this now asks the background script (via the
// "downloadFile" message, see its own comment in message-handlers.js) to perform the
// download itself, where it can register the real filename and the listener can see it.
function downloadBlob(content, filename, mimeType, saveAs = false) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "downloadFile", content, filename, mimeType, saveAs }, (response) => {
      if (chrome.runtime.lastError || !response) {
        resolve({ ok: false, filename, downloadId: null, error: chrome.runtime.lastError?.message || "no response from background" });
        return;
      }
      resolve(response);
    });
  });
}

// One section can still be huge on its own (a long session's networkLog, say) even after
// splitting by category. MAX_CHUNK_BYTES caps how big any single downloaded file is allowed
// to get -- an oversized array-valued section is broken into further "_part1", "_part2", ...
// files, each under this size, instead of one very large file for that section.
const MAX_CHUNK_BYTES = 4 * 1024 * 1024; // 4MB -- comfortably uploadable/readable in one go

// Splits an array into pieces whose SERIALIZED JSON size each stay under maxBytes. A single
// item that is itself larger than maxBytes still gets its own chunk (never dropped, never
// stuck in an infinite loop) -- it just can't be shrunk further without losing data.
function chunkArrayBySize(array, maxBytes) {
  const chunks = [];
  let current = [];
  let currentSize = 2; // "[]"
  for (const item of array) {
    const itemSize = JSON.stringify(item).length + 1; // +1 for the comma/bracket overhead
    if (current.length > 0 && currentSize + itemSize > maxBytes) {
      chunks.push(current);
      current = [];
      currentSize = 2;
    }
    current.push(item);
    currentSize += itemSize;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// Splits the recording into one file per non-empty top-level section, plus a small manifest
// file listing what was produced and how big each piece is -- this is what actually solves
// "the JSON is too large to open/upload": each downloaded file stays focused on one kind of
// data instead of everything landing in a single, often huge, combined file. Sections that are
// themselves still too large after that (a long session's networkLog, say) are further broken
// into size-capped "_part1", "_part2", ... files via chunkArrayBySize above, so no single
// downloaded file should end up unmanageably large either way.
async function doSplitExport(data, format) {
  const isMarkdown = format === 'markdown';
  const ext = isMarkdown ? 'md' : 'json';
  const mimeType = isMarkdown ? 'text/markdown' : 'application/json';
  const manifest = [];
  let done = 0;
  // [FIX] same missing-timestamp issue as the main export buttons, same fix -- computed once
  // here and reused for every file in this split-export run (including the manifest) so they
  // all stay grouped together as clearly belonging to the same session, rather than each
  // getting a slightly different value if computed separately partway through the run.
  const exportTimestamp = new Date().toISOString().replace(/[:.]/g, '-');

  // [4.6.0] an object section counts as empty when everything inside it is empty
  // (contentPipeline is only filled on list pages; it was exported empty every time)
  const _isEmpty = (v) => {
    if (v === null || v === undefined || v === '') return true;
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === 'object') return Object.values(v).every(_isEmpty);
    return false;
  };
  const sectionsPresent = EXPORT_SECTIONS.filter(s => !_isEmpty(data[s.key]));

  // Pre-flight: work out how many files each section will actually produce, so progress
  // reporting and the manifest both reflect the real total (including chunked-out parts).
  const plan = sectionsPresent.map(section => {
    const value = data[section.key];
    if (Array.isArray(value)) {
      const wholeSize = JSON.stringify(value).length;
      if (wholeSize > MAX_CHUNK_BYTES) {
        return { section, chunks: chunkArrayBySize(value, MAX_CHUNK_BYTES) };
      }
      return { section, chunks: [value] };
    }
    // non-array sections (contentPipeline, etc.) aren't chunked internally -- downloaded whole.
    return { section, chunks: [value] };
  });
  const total = plan.reduce((n, p) => n + p.chunks.length, 0);

  for (const { section, chunks } of plan) {
    const multi = chunks.length > 1;
    for (let i = 0; i < chunks.length; i++) {
      const scoped = { [section.key]: chunks[i] };
      const content = isMarkdown ? exportAsMarkdown(scoped) : JSON.stringify(scoped, null, 2);
      const partSuffix = multi ? `_part${i + 1}of${chunks.length}` : '';
      const filename = `stream_recording_${section.label}${partSuffix}_${exportTimestamp}.${ext}`;
      const result = await downloadBlob(content, filename, mimeType);
      manifest.push(`${result.ok ? '✅' : '❌'} ${filename} — ${sizeLabel(content)}${result.error ? ' (' + result.error + ')' : ''}`);
      done++;
      progressFill.style.width = Math.round((done / total) * 90) + "%";
      statusDiv.innerText = `⏳ Splitting export... (${done}/${total})`;
      // small gap between downloads -- Chrome silently drops downloads fired in too tight a burst
      await new Promise(r => setTimeout(r, 150));
    }
  }

  // [NEW] extension version + script-capture count in every manifest, so an export made
  // by an outdated (not reloaded) copy of the extension is obvious at a glance.
  const _ver = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '?';
  const _scripts = Array.isArray(data.scriptBodies) ? data.scriptBodies : [];
  const _scriptOk = _scripts.filter(b => b && b.body).length;
  const manifestText = `Stream Recorder Pro — split export manifest\n` +
    `Extension version: ${_ver}\n` +
    `Scripts captured: ${_scriptOk} OK, ${_scripts.length - _scriptOk} failed\n` +
    `Page/iframe HTML captured: ${Array.isArray(data.frameDocuments) ? data.frameDocuments.length : 0}\n` +
    `Generated: ${exportTimestamp}\n` +
    `Max file size target: ${(MAX_CHUNK_BYTES / 1024 / 1024).toFixed(0)} MB per file\n\n` +
    manifest.join('\n') + '\n';
  await downloadBlob(manifestText, `stream_recording_MANIFEST_${exportTimestamp}.txt`, 'text/plain');

  progressFill.style.width = "100%";
  statusDiv.innerText = `✅ Split export done: ${total} file(s) + manifest`;
  setTimeout(() => {
    if (statusDiv.innerText.includes("Split export done")) statusDiv.innerText = "✅ Ready";
  }, 3000);
}

// ═══ EXPORT FUNCTIONS ═══
function doExport(format) {
  if (!currentRecordingData) { alert("No recording data. Click Stop first."); return; }
  if (isExporting) return;
  isExporting = true;

  const scope = exportScopeSelect ? exportScopeSelect.value : 'all';

  statusDiv.innerText = `⏳ Exporting ${format.toUpperCase()}... (0%)`;
  progressFill.style.width = "0%";

  if (scope === 'split' && (format === 'json' || format === 'markdown')) {
    doSplitExport(currentRecordingData, format).finally(() => { isExporting = false; });
    return;
  }

  try {
    const data = getScopedData(currentRecordingData, scope);
    let content, filename, mimeType;
    const scopeSuffix = (scope && scope !== 'all') ? `_${scope}` : '';
    // [FIX] every export from this button used to suggest the exact same filename
    // ("stream_recording.json", etc.) regardless of when or which session it came from --
    // confirmed directly: exporting two separate recording sessions (e.g. a movies pass and
    // a later series pass) both defaulted to identical filenames, risking a silent overwrite
    // if not manually renamed in the save dialog every single time, and giving no way to
    // tell files apart later even when renamed carefully. options.js's own exports
    // (sr_data_*, sr_settings_*) already include a timestamp; this brings the main export
    // buttons in line with that same, already-established convention.
    const exportTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
    
    switch (format) {
      case 'csv':
        content = exportAsCSV(data);
        filename = `stream_recording${scopeSuffix}_${exportTimestamp}.csv`;
        mimeType = 'text/csv';
        break;
      case 'har':
        content = JSON.stringify(exportAsHAR(data), null, 2);
        filename = `stream_recording${scopeSuffix}_${exportTimestamp}.har`;
        mimeType = 'application/json';
        break;
      case 'markdown':
        content = exportAsMarkdown(data);
        filename = `stream_recording${scopeSuffix}_${exportTimestamp}.md`;
        mimeType = 'text/markdown';
        break;
      default:
        content = JSON.stringify(data, null, 2);
        filename = `stream_recording${scopeSuffix}_${exportTimestamp}.json`;
        mimeType = 'application/json';
    }
    
    const chunks = Math.ceil(content.length / (1024 * 1024));
    let progress = 0;
    const interval = setInterval(() => {
      progress = Math.min(progress + 10, 90);
      progressFill.style.width = progress + "%";
      statusDiv.innerText = `⏳ Exporting ${format.toUpperCase()}... (${progress}%)`;
      if (progress >= 90) clearInterval(interval);
    }, 100);
    
    // [FIX] now uses the shared, fixed downloadBlob() (see its own comment)
    // instead of this duplicated, premature-revoke pattern.
    // [FIX-saveas] was saveAs: true -- every one of this file's saveAs:true call sites
    // (this one plus genExtractor/genResolver/exportFullExtractor/generateTests below) pops a
    // native "Save As" dialog per download. Chrome can only show/honor ONE such dialog at a
    // time; firing several saveAs:true downloads back-to-back (exactly what happens exporting
    // right after Stop, or generating an extractor + its test file together) makes every
    // dialog after the first get silently auto-resolved with a RANDOM filename instead of the
    // one actually requested -- confirmed directly from real downloads: *_extractor.py came
    // out as a random UUID with a .pyw extension instead of the real name. saveAs: false
    // (the doSplitExport export path's default, which never had this problem) saves straight
    // to the Downloads folder using the exact suggested filename every time, no dialog, no
    // race between simultaneous downloads.
    downloadBlob(content, filename, mimeType, false).then((result) => {
      clearInterval(interval);
      progressFill.style.width = "100%";
      if (!result.ok) {
        statusDiv.innerText = `❌ Export ${format} failed: ${result.error || "unknown error"}`;
      } else {
        statusDiv.innerText = `✅ Exported ${format.toUpperCase()} as ${filename} (${sizeLabel(content)})`;
        setTimeout(() => {
          if (statusDiv.innerText.includes("Exported")) {
            statusDiv.innerText = "✅ Ready";
          }
        }, 3000);
      }
      isExporting = false;
    });
  } catch (e) {
    statusDiv.innerText = `❌ Export ${format} error: ${e.message}`;
    progressFill.style.width = "0%";
    isExporting = false;
  }
}

function exportAsCSV(data) {
  const headers = ['timestamp', 'type', 'url', 'method', 'status'];
  const rows = (data.networkLog || []).map(entry => 
    headers.map(h => {
      let val = entry[h] || '';
      if (typeof val === 'string' && (val.includes(',') || val.includes('"'))) {
        val = `"${val.replace(/"/g, '""')}"`;
      }
      return val;
    }).join(',')
  );
  return [headers.join(','), ...rows].join('\n');
}

function exportAsHAR(data) {
  return {
    log: {
      version: '1.2',
      creator: { name: 'Stream Recorder Pro', version: '3.0' },
      entries: (data.networkLog || []).map(entry => ({
        startedDateTime: new Date(entry.timestamp).toISOString(),
        time: 0,
        request: {
          method: entry.method || 'GET',
          url: entry.url,
          httpVersion: 'HTTP/1.1',
          headers: Object.entries(entry.requestHeaders || {}).map(([name, value]) => ({ name, value })),
          cookies: [],
          queryString: [],
          postData: entry.requestBody ? { mimeType: 'application/json', text: entry.requestBody } : undefined
        },
        response: {
          status: entry.statusCode || 0,
          statusText: '',
          httpVersion: 'HTTP/1.1',
          headers: Object.entries(entry.responseHeaders || {}).map(([name, value]) => ({ name, value })),
          cookies: [],
          content: { size: 0, mimeType: 'application/json' }
        },
        cache: {},
        timings: { send: 0, wait: 0, receive: 0 }
      }))
    }
  };
}

function exportAsMarkdown(data) {
  let md = '# Stream Recorder Pro Export\n\n';
  md += `> Generated: ${new Date().toISOString()}\n\n`;
  
  // ═══ SUMMARY ═══
  md += `## 📊 Summary\n\n`;
  md += `| Metric | Value |\n`;
  md += `|--------|-------|\n`;
  md += `| Filter Mode | ${data.filterMode || 'all'} |\n`;
  md += `| Actions | ${data.actions?.length || 0} |\n`;
  md += `| Network Log | ${data.networkLog?.length || 0} |\n`;
  md += `| XHR Bodies | ${data.xhrBodies?.length || 0} |\n`;
  md += `| User Journey | ${data.userJourney?.length || 0} steps |\n`;
  md += `| Screenshots | ${data.screenshots?.length || 0} |\n`;
  md += `| Movies Found | ${data.contentPipeline?.movieList?.length || 0} |\n`;
  md += `| Downloads Found | ${data.contentPipeline?.downloadLinks?.length || 0} |\n\n`;

  // ═══ USER JOURNEY ═══
  if (data.userJourney && data.userJourney.length > 0) {
    md += `## 🗺️ User Journey\n\n`;
    md += `| # | Time | Action | URL |\n`;
    md += `|---|------|--------|-----|\n`;
    data.userJourney.forEach((step, i) => {
      const time = new Date(step.timestamp).toLocaleTimeString();
      const action = step.action || 'unknown';
      const url = step.url || '';
      md += `| ${i+1} | ${time} | ${action} | ${url} |\n`;
    });
    md += '\n';
  }

  // ═══ ACTIONS ═══
  if (data.actions && data.actions.length > 0) {
    md += `## 🎯 Actions\n\n`;
    md += `| # | Time | Type | URL | Selector |\n`;
    md += `|---|------|------|-----|----------|\n`;
    // [FIX] this used to stop after the first 100 actions, silently dropping the rest with
    // only a one-line "N more actions" note and no actual data -- any recording longer than
    // 100 actions was never actually complete in this export. Now shows every action.
    data.actions.forEach((action, i) => {
      const time = new Date(action.timestamp).toLocaleTimeString();
      const type = action.type || 'unknown';
      const url = action.url || action.href || '';
      const selector = action.selector || '';
      md += `| ${i+1} | ${time} | ${type} | ${url} | ${selector} |\n`;
    });
    md += '\n';
  }

  // ═══ NETWORK REQUESTS ═══
  if (data.networkLog && data.networkLog.length > 0) {
    md += `## 🌐 Network Requests\n\n`;
    md += `| # | Time | Method | Status | URL |\n`;
    md += `|---|------|--------|--------|-----|\n`;
    // [FIX] same 100-item cap as Actions above, same fix -- shows every request now.
    data.networkLog.forEach((req, i) => {
      const time = new Date(req.timestamp).toLocaleTimeString();
      const method = req.method || 'GET';
      const status = req.statusCode || req.status || '?';
      const url = req.url || '';
      md += `| ${i+1} | ${time} | ${method} | ${status} | ${url} |\n`;
    });
    md += '\n';
  }

  // ═══ API RESPONSES (XHR Bodies) ═══
  if (data.xhrBodies && data.xhrBodies.length > 0) {
    md += `## 📡 API Responses (XHR/Fetch)\n\n`;
    
    const grouped = {};
    for (const body of data.xhrBodies) {
      const key = body.url || 'unknown';
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(body);
    }
    
    // [FIX] this used to only ever list the first 5 requests per URL group (dropping the
    // rest with just a "N more" note) and only ever show the response BODY TEXT for the
    // single LAST request in each group -- if the same endpoint returned genuinely different
    // data across several hits (a paginated/polling API, say), every earlier response's
    // actual content was silently never shown at all, only the final one. Now lists every
    // request in the group, and shows the body text for every DISTINCT body content (not
    // every individual request -- if several requests to the same URL returned byte-identical
    // bodies, that content is shown once, noting which request numbers shared it, rather than
    // repeating the same text block over and over).
    const RESPONSE_BODY_CHAR_CAP = 8000; // still capped -- a single response can genuinely be
    // megabytes, and inlining that uncapped would make the whole file unreadable; the JSON
    // export always has the complete, uncapped body regardless of this cap.
    for (const [url, bodies] of Object.entries(grouped)) {
      md += `### 🔗 ${url}\n\n`;
      md += `| # | Method | Status | Via | Truncated | Time |\n`;
      md += `|---|--------|--------|-----|-----------|------|\n`;
      bodies.forEach((body, i) => {
        const method = body.method || 'GET';
        const status = body.status || '?';
        const via = body.via || 'unknown';
        const truncated = body.truncated ? '⚠️ Yes' : '✅ No';
        const time = new Date(body.timestamp).toLocaleTimeString();
        md += `| ${i+1} | ${method} | ${status} | ${via} | ${truncated} | ${time} |\n`;
      });

      // Group requests within this URL by distinct body content
      const byContent = new Map();
      bodies.forEach((body, i) => {
        if (!body.body) return;
        if (!byContent.has(body.body)) byContent.set(body.body, []);
        byContent.get(body.body).push(i + 1);
      });

      let bodyIndex = 0;
      for (const [content, requestNumbers] of byContent.entries()) {
        bodyIndex++;
        const label = requestNumbers.length > 1
          ? `Response Body (requests #${requestNumbers.join(', #')} -- identical content)`
          : `Response Body (request #${requestNumbers[0]})`;
        md += `\n**${label}:**\n`;
        md += '```json\n';
        try {
          const parsed = JSON.parse(content);
          const pretty = JSON.stringify(parsed, null, 2);
          md += pretty.substring(0, RESPONSE_BODY_CHAR_CAP);
          if (pretty.length > RESPONSE_BODY_CHAR_CAP) {
            md += '\n... (truncated at ' + RESPONSE_BODY_CHAR_CAP + ' chars, full in JSON export)';
          }
        } catch (e) {
          md += content.substring(0, RESPONSE_BODY_CHAR_CAP);
          if (content.length > RESPONSE_BODY_CHAR_CAP) {
            md += '\n... (truncated at ' + RESPONSE_BODY_CHAR_CAP + ' chars, full in JSON export)';
          }
        }
        md += '\n```\n';
      }
      md += '\n';
    }
  }

  // ═══ CONTENT PIPELINE - MOVIES ═══
  if (data.contentPipeline?.movieList && data.contentPipeline.movieList.length > 0) {
    md += `## 🎬 Movies Found\n\n`;
    data.contentPipeline.movieList.forEach((movie, i) => {
      md += `### ${i+1}. ${movie.title || 'Unknown Title'}\n`;
      if (movie.year) md += `- **Year:** ${movie.year}\n`;
      if (movie.rating) md += `- **Rating:** ⭐${movie.rating}\n`;
      if (movie.quality) md += `- **Quality:** ${movie.quality}\n`;
      if (movie.genre) md += `- **Genre:** ${movie.genre}\n`;
      if (movie.url) md += `- **URL:** ${movie.url}\n`;
      if (movie.poster) md += `- **Poster:** ${movie.poster}\n`;
      md += '\n';
    });
  }

  // ═══ CONTENT PIPELINE - DOWNLOADS ═══
  if (data.contentPipeline?.downloadLinks && data.contentPipeline.downloadLinks.length > 0) {
    md += `## 📥 Downloads Found\n\n`;
    data.contentPipeline.downloadLinks.forEach((dl, i) => {
      md += `### ${i+1}. ${dl.filename || 'Unknown File'}\n`;
      if (dl.downloadUrl || dl.url) md += `- **URL:** ${dl.downloadUrl || dl.url}\n`;
      if (dl.filesize) md += `- **Size:** ${dl.filesize}\n`;
      if (dl.expiry) md += `- **Expires:** ${dl.expiry} hours\n`;
      if (dl.mime) md += `- **MIME:** ${dl.mime}\n`;
      md += '\n';
    });
  }

  // ═══ CONTENT PIPELINE - METADATA ═══
  if (data.contentPipeline?.metadata && Object.keys(data.contentPipeline.metadata).length > 0) {
    md += `## 📋 Metadata\n\n`;
    md += `| Key | Value |\n`;
    md += `|-----|-------|\n`;
    for (const [key, value] of Object.entries(data.contentPipeline.metadata)) {
      md += `| ${key} | ${value} |\n`;
    }
    md += '\n';
  }

  // ═══ CONTENT PIPELINE - SEQUENCE ═══
  if (data.contentPipeline?.sequence && data.contentPipeline.sequence.length > 0) {
    md += `## 🔄 Pipeline Sequence\n\n`;
    md += `| # | Time | Type | Data |\n`;
    md += `|---|------|------|------|\n`;
    // [FIX] same 50-item cap pattern as elsewhere in this export, same fix -- shows every step.
    data.contentPipeline.sequence.forEach((step, i) => {
      const time = new Date(step.timestamp).toLocaleTimeString();
      const type = step.type || 'unknown';
      const dataSummary = step.data ? Object.keys(step.data).join(', ') : '';
      md += `| ${i+1} | ${time} | ${type} | ${dataSummary} |\n`;
    });
    md += '\n';
  }

  // ═══ SCREENSHOTS ═══
  if (data.screenshots && data.screenshots.length > 0) {
    md += `## 📸 Screenshots\n\n`;
    md += `| # | Time | Tab ID |\n`;
    md += `|---|------|--------|\n`;
    data.screenshots.forEach((s, i) => {
      const time = new Date(s.timestamp).toLocaleTimeString();
      md += `| ${i+1} | ${time} | ${s.tabId || 'N/A'} |\n`;
    });
    md += '\n';
    md += `> 💡 Full screenshot data available in JSON export.\n\n`;
  }

  // ═══ STREAM URLS ═══
  const streamUrls = [];
  if (data.networkLog) {
    for (const entry of data.networkLog) {
      // [FIX] missed real, confirmed stream URLs that use a .txt extension
      // instead of .m3u8/.mp4/.ts (e.g. "master.txt", "index-v1-a1.txt" --
      // both real, captured playlist URLs from the same CDN family). Same
      // fix applied to message-handlers.js's getStreamLinks handler.
      if (entry.url && (entry.url.includes('.m3u8') || entry.url.includes('.mp4') || entry.url.includes('.ts') || entry.url.includes('.txt'))) {
        streamUrls.push(entry.url);
      }
    }
  }
  if (data.xhrBodies) {
    for (const body of data.xhrBodies) {
      if (body.body) {
        // [FIX] same missing .txt-extension issue, same fix.
        const matches = body.body.match(/https?:\/\/[^\s"']+\.(?:m3u8|mp4|ts|txt)[^\s"']*/g) || [];
        streamUrls.push(...matches);
      }
    }
  }
  
  if (streamUrls.length > 0) {
    md += `## 🎬 Stream URLs Found (${streamUrls.length})\n\n`;
    const unique = [...new Set(streamUrls)];
    // [FIX] same 50-item cap pattern as elsewhere in this export, same fix -- shows every
    // distinct stream URL found.
    unique.forEach((url, i) => {
      md += `${i+1}. ${url}\n`;
    });
    md += '\n';
  }

  // ═══ CONTENT PIPELINE - SOURCE ═══
  if (data.contentPipeline?.source) {
    md += `## 📌 Content Source\n\n`;
    md += `**Source:** ${data.contentPipeline.source}\n\n`;
  }

  // ═══ FOOTER ═══
  md += `---\n\n`;
  md += `*Generated by Stream Recorder Pro v4.0.0*\n`;
  md += `*For full data, use the JSON export.*\n`;

  return md;
}

exportBtn.onclick = () => { doExport('json'); };
exportMarkdownBtn.onclick = () => { doExport('markdown'); };

// ═══ COPY ═══
copyBtn.onclick = () => {
  if (!currentRecordingData) { alert("No recording data. Click Stop first."); return; }
  const jsonStr = JSON.stringify(currentRecordingData, null, 2);
  navigator.clipboard.writeText(jsonStr).then(() => {
    statusDiv.innerText = "📋 JSON copied to clipboard!";
    setTimeout(() => {
      if (statusDiv.innerText === "📋 JSON copied to clipboard!") {
        statusDiv.innerText = "✅ Ready";
      }
    }, 2000);
  }).catch(err => {
    alert("Copy failed: " + err);
    statusDiv.innerText = "❌ Copy error";
  });
};

// ═══ SNAPSHOT ═══
// [FIX] the background capture this button waits on can now (see screenshot.js) never hang
// longer than ~8s on its own -- but this adds an independent safety net at the popup level
// too, so the bar can never sit stuck indefinitely here even if some OTHER, different cause
// ever prevents chrome.runtime.sendMessage's callback from firing.
saveSnapshotBtn.onclick = () => {
  statusDiv.innerText = "📸 Saving snapshot...";
  progressFill.style.width = "30%";

  let responded = false;
  const POPUP_SNAPSHOT_TIMEOUT_MS = 12000; // a little longer than screenshot.js's own 8s timeout
  const timeoutId = setTimeout(() => {
    if (responded) return;
    responded = true;
    progressFill.style.width = "100%";
    statusDiv.innerText = "❌ Snapshot timed out. Check the background console for details.";
    setTimeout(() => { progressFill.style.width = "0%"; }, 500);
  }, POPUP_SNAPSHOT_TIMEOUT_MS);

  chrome.runtime.sendMessage({ type: "saveSnapshot" }, (response) => {
    if (responded) return; // the popup-level timeout already fired; ignore this late reply
    responded = true;
    clearTimeout(timeoutId);
    progressFill.style.width = "100%";
    if (response && response.status === "saved") {
      statusDiv.innerText = "✅ Snapshot saved to Downloads folder.";
      setTimeout(() => {
        if (statusDiv.innerText === "✅ Snapshot saved to Downloads folder.") {
          statusDiv.innerText = "✅ Ready";
        }
      }, 3000);
    } else {
      statusDiv.innerText = "❌ Snapshot save failed. Check console.";
    }
    setTimeout(() => { progressFill.style.width = "0%"; }, 500);
  });
};

// ═══ STREAM LINKS ═══
copyStreamLinksBtn.onclick = () => {
  statusDiv.innerText = "🔗 Finding stream links...";
  progressFill.style.width = "30%";
  chrome.runtime.sendMessage({ type: "getStreamLinks" }, (response) => {
    progressFill.style.width = "100%";
    const labeled = (response && response.labeledLinks) || [];
    const links = labeled.length ? labeled : ((response && response.links) || []);
    if (!links.length) {
      statusDiv.innerText = "❌ No stream-looking URLs found yet.";
      setTimeout(() => { progressFill.style.width = "0%"; }, 500);
      return;
    }
    streamLinks = links;
    statusDiv.innerText = `📋 Found ${links.length} stream link(s)! Click to copy.`;
    setTimeout(() => { progressFill.style.width = "0%"; }, 500);
  });
};

document.addEventListener('click', (event) => {
  if (event.target.id === 'copyStreamLinks' && streamLinks.length > 0) {
    navigator.clipboard.writeText(streamLinks.join("\n")).then(() => {
      statusDiv.innerText = `📋 Copied ${streamLinks.length} stream link(s) to clipboard!`;
      setTimeout(() => {
        if (statusDiv.innerText.startsWith("📋 Copied")) {
          statusDiv.innerText = "✅ Ready";
        }
      }, 2500);
    }).catch(err => {
      alert("Copy failed: " + err);
      statusDiv.innerText = "❌ Copy error";
    });
  }
});

// ═══ SOLVE CHALLENGE ═══
solveBtn.onclick = () => {
  chrome.windows.getLastFocused({ windowTypes: ["normal"], populate: true }, (win) => {
    const tab = (win && win.tabs || []).find(t => t.active);
    if (!tab) {
      challengeStatusDiv.innerText = "❌ No active site tab found.";
      return;
    }
    challengeStatusDiv.innerText = "🧩 Starting manual solve...";
    chrome.runtime.sendMessage({
      type: "manualSolve",
      tabId: tab.id,
      url: tab.url
    }, (response) => {
      if (response && response.status === "solving") {
        challengeStatusDiv.innerText = "🧩 Solving challenge... (check new tab)";
      } else {
        challengeStatusDiv.innerText = "❌ Failed to start solving.";
      }
    });
  });
};

// ═══ YTS EXTRACTION ═══
extractYTSTorrentsBtn.onclick = () => {
  chrome.windows.getLastFocused({ windowTypes: ["normal"], populate: true }, (win) => {
    const tab = (win && win.tabs || []).find(t => t.active);
    if (!tab) {
      statusDiv.innerText = "❌ No active site tab found.";
      return;
    }
    
    statusDiv.innerText = "🔍 Extracting torrent links...";
    progressFill.style.width = "30%";
    chrome.runtime.sendMessage({
      type: "extractYTSData",
      tabId: tab.id
    }, (response) => {
      progressFill.style.width = "100%";
      if (response && response.success && response.data && response.data.length > 0) {
        const data = response.data;
        let output = [];
        let totalLinks = 0;
        data.forEach(item => {
          if (item.links && item.links.length > 0) {
            let text = `${item.title}`;
            if (item.year) text += ` (${item.year})`;
            if (item.quality) text += ` - ${item.quality}`;
            output.push(text);
            item.links.forEach(link => {
              output.push(`  ${link.text}: ${link.url}`);
              totalLinks++;
            });
            if (item.poster) output.push(`  Poster: ${item.poster}`);
            output.push('');
          }
        });
        
        const resultText = output.join('\n');
        if (resultText.trim()) {
          navigator.clipboard.writeText(resultText).then(() => {
            const count = data.filter(d => d.links && d.links.length > 0).length;
            statusDiv.innerText = `📋 Extracted ${count} movie(s) with ${totalLinks} links! Check clipboard.`;
            jsonPreview.value = resultText;
          }).catch(err => {
            jsonPreview.value = resultText;
            statusDiv.innerText = "📋 Data extracted! See preview below.";
          });
        } else {
          statusDiv.innerText = "❌ No torrent/magnet links found on this page.";
        }
      } else {
        statusDiv.innerText = "❌ No YTS movie data found on this page. Try navigating to a YTS site.";
      }
      setTimeout(() => { progressFill.style.width = "0%"; }, 500);
    });
  });
};

// ═══ ARABIC MOVIES EXTRACTION ═══
extractArabicMoviesBtn.onclick = () => {
  chrome.windows.getLastFocused({ windowTypes: ["normal"], populate: true }, (win) => {
    const tab = (win && win.tabs || []).find(t => t.active);
    if (!tab) {
      statusDiv.innerText = "❌ No active site tab found.";
      return;
    }
    
    statusDiv.innerText = "🇸🇦 Extracting Arabic movies...";
    progressFill.style.width = "30%";
    chrome.runtime.sendMessage({
      type: "extractArabicMovies",
      tabId: tab.id
    }, (response) => {
      progressFill.style.width = "100%";
      if (response && response.success && response.data && response.data.length > 0) {
        const data = response.data;
        let output = [];
        data.forEach(movie => {
          let line = `${movie.title}`;
          if (movie.year) line += ` (${movie.year})`;
          if (movie.rating) line += ` ⭐${movie.rating}`;
          if (movie.quality) line += ` [${movie.quality}]`;
          if (movie.genre) line += ` 🎭${movie.genre}`;
          line += `\n  🔗 ${movie.url}`;
          output.push(line);
        });
        
        const resultText = output.join('\n\n');
        navigator.clipboard.writeText(resultText).then(() => {
          statusDiv.innerText = `📋 Extracted ${data.length} Arabic movies! Check clipboard.`;
          jsonPreview.value = resultText;
        }).catch(err => {
          jsonPreview.value = resultText;
          statusDiv.innerText = "📋 Data extracted! See preview below.";
        });
      } else {
        statusDiv.innerText = "❌ No Arabic movie data found. Try navigating to WeCima or MyCima.";
      }
      setTimeout(() => { progressFill.style.width = "0%"; }, 500);
    });
  });
};

// ═══ SAVEFILES EXTRACTION ═══
extractSaveFilesBtn.onclick = () => {
  chrome.windows.getLastFocused({ windowTypes: ["normal"], populate: true }, (win) => {
    const tab = (win && win.tabs || []).find(t => t.active);
    if (!tab) {
      statusDiv.innerText = "❌ No active site tab found.";
      return;
    }
    
    statusDiv.innerText = "📦 Extracting SaveFiles download...";
    progressFill.style.width = "30%";
    chrome.runtime.sendMessage({
      type: "extractSaveFiles",
      tabId: tab.id
    }, (response) => {
      progressFill.style.width = "100%";
      if (response && response.success && response.data && response.data.downloadUrl) {
        const data = response.data;
        let output = `📥 Download URL:\n${data.downloadUrl}\n\n`;
        if (data.filename) output += `📄 Filename: ${data.filename}\n`;
        if (data.filesize) output += `📊 Filesize: ${data.filesize}\n`;
        if (data.expiry) output += `⏰ Expires in: ${data.expiry} hours\n`;
        if (data.metadata && data.metadata.exactSize) output += `🔢 Exact size: ${data.metadata.exactSize}\n`;
        if (data.metadata && data.metadata.yourIP) output += `🌐 Your IP: ${data.metadata.yourIP}\n`;
        
        navigator.clipboard.writeText(output).then(() => {
          statusDiv.innerText = "📋 Download URL copied to clipboard!";
          jsonPreview.value = output;
        }).catch(err => {
          jsonPreview.value = output;
          statusDiv.innerText = "📋 Data extracted! See preview below.";
        });
      } else {
        statusDiv.innerText = "❌ No SaveFiles download found. Try navigating to a SaveFiles download page.";
      }
      setTimeout(() => { progressFill.style.width = "0%"; }, 500);
    });
  });
};

// ═══ FIND TORRENT API ═══
findTorrentApiBtn.onclick = () => {
  const hideTMDB = hideTMDBCheckbox.checked;
  statusDiv.innerText = "🧲 Scanning captured responses for torrent data...";
  progressFill.style.width = "30%";
  chrome.runtime.sendMessage({ type: "getTorrentLinksFiltered", hideTMDB }, (response) => {
    progressFill.style.width = "100%";
    const data = (response && response.data) || [];
    
    if (!data.length) {
      torrentResultsDiv.innerHTML = '<div class="torrent-empty">No torrent API responses found yet.<br><br>1. Start recording<br>2. Browse to a movie/show on the site<br>3. Click it to load torrents<br>4. Click "Find Torrent API" again</div>';
      torrentResultsDiv.style.display = "block";
      statusDiv.innerText = "❌ No torrent data found. Browse a movie first.";
      setTimeout(() => { progressFill.style.width = "0%"; }, 500);
      return;
    }
    
    let html = '';
    for (const item of data) {
      if (item.type === 'torrent_api') {
        html += '<div class="torrent-hit api-found">';
        html += '<h3>🎯 TORRENT API FOUND</h3>';
        html += `<code>${escHtml(item.apiEndpoint)}</code>`;
        html += '<div style="margin:4px 0">';
        html += `<span class="tstat seeds">📊 ${item.infoHashCount} hashes</span>`;
        html += `<span class="tstat">🧲 ${item.magnetCount} magnets</span>`;
        if (item.hasFileIdx) html += '<span class="tstat idx">⚡ torrentio-style</span>';
        if (item.imdbId) html += `<span class="tstat"> IMDb: ${item.imdbId}</span>`;
        html += `<span class="tstat">Status: ${item.status}</span>`;
        html += '</div>';
        if (item.sampleHashes && item.sampleHashes.length) {
          html += `<pre>${escHtml(item.sampleHashes.join('\n'))}</pre>`;
        }
        html += `<details><summary>Body preview (${item.bodyLength} chars)</summary><pre>${escHtml(item.bodyPreview)}</pre></details>`;
        html += `<button class="copy-py-btn" data-url="${escAttr(item.apiEndpoint)}">📋 Copy as Python fetch_json</button>`;
        html += '</div>';
      } else if (item.type === 'direct_magnet') {
        html += '<div class="torrent-hit">';
        html += '<h3>🧲 Direct Magnet URL</h3>';
        html += `<code>${escHtml(item.apiEndpoint)}</code>`;
        html += '</div>';
      } else if (item.type === 'suspected_backend') {
        html += '<div class="torrent-hit" style="border-color:#e67e22">';
        html += '<h3 style="color:#e67e22">🔌 Suspected Backend</h3>';
        html += `<code>${escHtml(item.apiEndpoint)}</code>`;
        html += '<div>';
        html += `<span class="tstat backend">${item.status || '—'}</span>`;
        html += `<span class="tstat">${escHtml(item.contentType || 'unknown')}</span>`;
        html += '</div>';
        html += '</div>';
      }
    }
    torrentResultsDiv.innerHTML = html;
    torrentResultsDiv.style.display = "block";
    statusDiv.innerText = `✅ Found ${data.length} torrent-related response(s)!`;
    setTimeout(() => { progressFill.style.width = "0%"; }, 500);
    
    torrentResultsDiv.querySelectorAll('.copy-py-btn').forEach(btn => {
      btn.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "copyAsPython", url: btn.dataset.url }, (resp) => {
          if (resp && resp.snippet) {
            navigator.clipboard.writeText(resp.snippet).then(() => {
              btn.textContent = '✅ Copied!';
              setTimeout(() => { btn.textContent = '📋 Copy as Python fetch_json'; }, 2000);
            });
          }
        });
      });
    });
  });
};

// ═══ VIEW CONTENT PIPELINE ═══
viewPipelineBtn.onclick = () => {
  statusDiv.innerText = "📊 Fetching content pipeline...";
  progressFill.style.width = "30%";
  chrome.runtime.sendMessage({ type: "getContentPipeline" }, (response) => {
    progressFill.style.width = "100%";
    const data = (response && response.data) || {};
    
    let output = '=== CONTENT PIPELINE ===\n\n';
    
    if (data.source) {
      output += `📌 Source: ${data.source}\n\n`;
    }
    
    if (data.movieList && data.movieList.length > 0) {
      output += `🎬 MOVIES (${data.movieList.length}):\n`;
      data.movieList.forEach((m, i) => {
        output += `  ${i+1}. ${m.title} (${m.year || 'N/A'})`;
        if (m.rating) output += ` ⭐${m.rating}`;
        if (m.quality) output += ` [${m.quality}]`;
        output += '\n';
      });
      output += '\n';
    }
    
    if (data.downloadLinks && data.downloadLinks.length > 0) {
      output += `📥 DOWNLOAD LINKS (${data.downloadLinks.length}):\n`;
      data.downloadLinks.forEach((d, i) => {
        output += `  ${i+1}. ${d.filename || 'Unknown file'}\n`;
        output += `     ${d.downloadUrl || d.url || ''}\n`;
        if (d.filesize) output += `     Size: ${d.filesize}\n`;
        if (d.expiry) output += `     Expires: ${d.expiry} hours\n`;
      });
      output += '\n';
    }
    
    if (data.metadata && Object.keys(data.metadata).length > 0) {
      output += `📋 METADATA:\n`;
      Object.entries(data.metadata).forEach(([key, value]) => {
        output += `  ${key}: ${value}\n`;
      });
      output += '\n';
    }
    
    if (data.sequence && data.sequence.length > 0) {
      output += `🔄 SEQUENCE (${data.sequence.length} steps):\n`;
      data.sequence.forEach((step, i) => {
        const time = new Date(step.timestamp).toLocaleTimeString();
        output += `  ${i+1}. [${time}] ${step.type}`;
        if (step.data && step.data.title) output += ` - ${step.data.title}`;
        output += '\n';
      });
    }
    
    if (!data.movieList && !data.downloadLinks && !data.sequence) {
      output += 'No content pipeline data available yet.\n';
      output += 'Start recording and browse sites to build the pipeline.\n';
    }
    
    jsonPreview.value = output;
    statusDiv.innerText = "📊 Content pipeline displayed below.";
    setTimeout(() => { progressFill.style.width = "0%"; }, 500);
  });
};

// ═══ GENERATE PYTHON EXTRACTOR ═══
document.getElementById('genExtractor').addEventListener('click', () => {
  if (!currentRecordingData) { 
    alert('⚠️ No recording data. Click Stop first.'); 
    return; 
  }

  const siteName = prompt('📝 Enter site name (e.g., Wecima, EgyDead, YTS):', 'CustomSite');
  if (!siteName) return;

  statusDiv.innerText = `⏳ Generating Python extractor for ${siteName}...`;
  progressFill.style.width = '30%';

  chrome.runtime.sendMessage({ 
    type: "generatePythonExtractor", 
    siteName: siteName,
    data: currentRecordingData 
  }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.code) {
      jsonPreview.value = response.code;
      
      // ═══ FIX: Use proper filename ═══
      const filename = `${siteName.toLowerCase().replace(/[^a-z0-9]/g, '_')}_extractor.py`;
      // [FIX] uses the shared, fixed downloadBlob() instead of the
      // duplicated, premature-revoke pattern (see its own comment).
      // [FIX-saveas] was saveAs: true -- see the detailed [FIX-saveas] comment near
      // doExport()'s downloadBlob call (~line 530) for why this caused random filenames.
      downloadBlob(response.code, filename, 'text/x-python', false);
      
      statusDiv.innerText = `✅ Python extractor saved as ${filename}`;
    } else {
      statusDiv.innerText = '❌ Failed to generate extractor. Check console.';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
  });
});

// ═══ GENERATE RESOLVER ═══
document.getElementById('genResolver').addEventListener('click', () => {
  if (!currentRecordingData) { 
    alert('⚠️ No recording data. Click Stop first.'); 
    return; 
  }

  const host = prompt('📝 Enter hostname (e.g., streamruby.net, doodstream.com):', '');
  if (!host) return;

  statusDiv.innerText = `⏳ Generating resolver for ${host}...`;
  progressFill.style.width = '30%';

  chrome.runtime.sendMessage({ 
    type: "generateResolver", 
    host: host,
    data: currentRecordingData 
  }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.code) {
      jsonPreview.value = response.code;
      
      // ═══ FIX: Use proper filename ═══
      const safeHost = host.replace(/[^a-zA-Z0-9]/g, '_');
      const filename = `resolve_${safeHost}.py`;
      // [FIX] uses the shared, fixed downloadBlob() instead of the
      // duplicated, premature-revoke pattern (see its own comment).
      // [FIX-saveas] was saveAs: true -- see the detailed [FIX-saveas] comment near
      // doExport()'s downloadBlob call (~line 530) for why this caused random filenames.
      downloadBlob(response.code, filename, 'text/x-python', false);
      
      statusDiv.innerText = `✅ Resolver saved as ${filename}`;
    } else {
      statusDiv.innerText = '❌ Failed to generate resolver. Check console.';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
  });
});

// ═══ GENERATE COMPLETE EXTRACTOR ═══
document.getElementById('exportFullExtractor').addEventListener('click', () => {
  if (!currentRecordingData) { 
    alert('⚠️ No recording data. Click Stop first.'); 
    return; 
  }

  const siteName = prompt('📝 Enter site name for the complete extractor:', 'CustomSite');
  if (!siteName) return;

  statusDiv.innerText = `⏳ Generating complete extractor for ${siteName}...`;
  progressFill.style.width = '30%';

  chrome.runtime.sendMessage({ 
    type: "generateCompleteExtractor", 
    siteName: siteName,
    data: currentRecordingData 
  }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.content) {
      jsonPreview.value = response.content;
      
      // ═══ FIX: Use proper filename ═══
      const filename = `${siteName.toLowerCase().replace(/[^a-z0-9]/g, '_')}_extractor.py`;
      // [FIX] uses the shared, fixed downloadBlob() instead of the
      // duplicated, premature-revoke pattern (see its own comment).
      // [FIX-saveas] was saveAs: true -- this call site AND the companion test-file
      // download right below it used to both fire saveAs:true back-to-back, which is
      // exactly the dialog-stacking case from the [FIX-saveas] comment near doExport()'s
      // downloadBlob call (~line 530): with two native Save-As dialogs queued, the second
      // one got silently auto-resolved with a random filename. saveAs:false here too.
      downloadBlob(response.content, filename, 'text/x-python', false);

      // [NEW] confirmed directly: the generator now also produces a
      // real, runnable companion test file (test-generator.js, already
      // wired into its own separate popup button, but never generated
      // alongside the extractor itself until now) -- download it too
      // when present, same as the main file.
      let testNote = '';
      if (response.testCode && response.testFilename) {
        downloadBlob(response.testCode, response.testFilename, 'text/x-python', false);
        testNote = ` + ${response.testFilename}`;
      }
      
      // [NEW] confirmed directly: the generator computes real validation
      // warnings (invalid class names, escaping bugs, unclosed
      // docstrings, leaked JS booleans) but nothing ever displayed them
      // to the user -- they were silently dropped at an intermediate
      // wrapper before even reaching this file. Now that they actually
      // arrive here, surface them plainly rather than letting a known
      // problem through with just a plain ✅.
      const warnings = response.warnings || [];
      if (warnings.length > 0) {
        statusDiv.innerText = `⚠️ Saved as ${filename}${testNote} -- ${warnings.length} issue(s) found, check console`;
        console.warn(`Stream Recorder Pro: ${warnings.length} validation warning(s) for ${filename}:`);
        for (const w of warnings) console.warn('  -', w);
      } else {
        statusDiv.innerText = `✅ Complete extractor saved as ${filename}${testNote}`;
      }
    } else {
      statusDiv.innerText = '❌ Failed to generate extractor. Check console.';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
  });
});

// ═══ IMPORT HTML SNAPSHOTS ═══
// [NEW] lets Gen Extractor / Gen Resolver / Full Extractor above run from
// saved HTML page files alone -- no live recording required first. Reads
// each selected file locally here (FileReader never touches the
// filesystem from the background side), ships the raw text to the new
// "importHtmlSnapshots" handler in message-handlers.js, which wraps each
// one into the same networkLog/xhrBodies shape a live recording produces,
// then adopts the merged result as currentRecordingData exactly like
// stopBtn's "getRecordingData" flow does -- so every existing Gen/Export
// button downstream needs zero changes of its own to consume imported data.
document.getElementById('importHtmlBtn').addEventListener('click', () => {
  document.getElementById('importHtmlInput').click();
});

document.getElementById('importHtmlInput').addEventListener('change', async (e) => {
  const fileList = Array.from(e.target.files || []);
  if (fileList.length === 0) return;

  statusDiv.innerText = `⏳ Reading ${fileList.length} file(s)...`;
  progressFill.style.width = '20%';

  const readAsText = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ filename: file.name, body: reader.result });
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });

  let files;
  try {
    files = await Promise.all(fileList.map(readAsText));
  } catch (err) {
    console.error('Stream Recorder Pro: failed to read imported file(s):', err);
    statusDiv.innerText = '❌ Failed to read file(s). Check console.';
    progressFill.style.width = '0%';
    e.target.value = '';
    return;
  }

  progressFill.style.width = '60%';

  chrome.runtime.sendMessage({ type: "importHtmlSnapshots", files }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.data) {
      // [FIX] merges into any existing currentRecordingData (a prior live
      // recording or an earlier import) instead of overwriting it outright
      // -- confirmed directly: the background handler already appends to
      // its own persistent s.networkLog/s.xhrBodies rather than replacing
      // them, so response.data already IS the full merged set; assigning
      // it straight through is correct and matches what stopBtn does.
      currentRecordingData = withRequestContext(response.data);
      jsonPreview.value = JSON.stringify(currentRecordingData, null, 2);
      statusDiv.innerText = `✅ Imported ${response.added} snapshot(s) (${response.total} total). Ready for Gen Extractor / Full Extractor.`;
    } else {
      statusDiv.innerText = '❌ Import failed -- no readable content found in selected file(s).';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
    e.target.value = '';
  });
});

// ═══ DISCOVER API ENDPOINTS ═══
document.getElementById('discoverAPI').addEventListener('click', () => {
  if (!currentRecordingData) { 
    alert('⚠️ No recording data. Click Stop first.'); 
    return; 
  }

  statusDiv.innerText = '🔍 Discovering API endpoints...';
  progressFill.style.width = '30%';

  chrome.runtime.sendMessage({ type: "discoverAPIEndpoints" }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.endpoints) {
      const endpoints = response.endpoints;
      let output = '=== API ENDPOINTS DISCOVERED ===\n\n';
      
      for (const ep of endpoints) {
        output += `[${ep.method}] ${ep.baseUrl}\n`;
        output += `  Status: ${ep.status}\n`;
        output += `  Type: ${ep.contentType}\n`;
        if (ep.samples.length > 0) {
          output += `  Samples:\n`;
          for (const sample of ep.samples.slice(0, 3)) {
            output += `    ${sample.url}\n`;
          }
        }
        output += '\n';
      }
      
      jsonPreview.value = output;
      statusDiv.innerText = `✅ Found ${endpoints.length} API endpoints.`;
    } else {
      statusDiv.innerText = '❌ No API endpoints found.';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
  });
});

// ═══ DISCOVER SITE STRUCTURE ═══
document.getElementById('discoverStructure').addEventListener('click', () => {
  if (!currentRecordingData) { 
    alert('⚠️ No recording data. Click Stop first.'); 
    return; 
  }

  statusDiv.innerText = '📊 Analyzing site structure...';
  progressFill.style.width = '30%';

  chrome.runtime.sendMessage({ type: "discoverSiteStructure" }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.structure) {
      const struct = response.structure;
      let output = '=== SITE STRUCTURE ===\n\n';
      
      output += `Navigation Flow: ${struct.navigationFlow.length} steps\n`;
      for (const nav of struct.navigationFlow.slice(0, 10)) {
        output += `  ${nav.type}: ${nav.from} → ${nav.to}\n`;
      }
      
      output += `\nCategories: ${struct.categories.length}\n`;
      for (const cat of struct.categories.slice(0, 10)) {
        if (cat.title) output += `  - ${cat.title}\n`;
      }
      
      output += `\nItem Selectors: ${struct.itemSelectors.join(', ')}\n`;
      
      jsonPreview.value = output;
      statusDiv.innerText = '✅ Site structure analyzed.';
    } else {
      statusDiv.innerText = '❌ Failed to analyze structure.';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
  });
});

// ═══ DISCOVER QUALITY VARIANTS ═══
document.getElementById('discoverQualities').addEventListener('click', () => {
  if (!currentRecordingData) { 
    alert('⚠️ No recording data. Click Stop first.'); 
    return; 
  }

  statusDiv.innerText = '🎯 Discovering quality variants...';
  progressFill.style.width = '30%';

  chrome.runtime.sendMessage({ type: "discoverQualityVariants" }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.qualities) {
      const q = response.qualities;
      let output = '=== QUALITY VARIANTS ===\n\n';
      output += `Total variants: ${q.variants.length}\n`;
      if (q.bestQuality) {
        output += `Best quality: ${q.bestQuality.quality}\n`;
        output += `  URL: ${q.bestQuality.url}\n`;
      }
      output += '\nQuality map:\n';
      for (const [quality, urls] of Object.entries(q.qualityMap)) {
        output += `  ${quality}: ${urls.length} URLs\n`;
      }
      output += '\nVariants:\n';
      for (const variant of q.variants.slice(0, 20)) {
        output += `  [${variant.quality}] ${variant.url.substring(0, 80)}...\n`;
      }
      jsonPreview.value = output;
      statusDiv.innerText = `✅ Found ${q.variants.length} quality variants.`;
    } else {
      statusDiv.innerText = '❌ No quality variants found.';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
  });
});

// ═══ ANALYZE HLS PLAYLIST ═══
document.getElementById('analyzeHLS').addEventListener('click', () => {
  const url = prompt('📝 Enter HLS playlist URL:', '');
  if (!url) return;

  statusDiv.innerText = '📊 Analyzing HLS playlist...';
  progressFill.style.width = '30%';

  chrome.runtime.sendMessage({ type: "analyzeHLSPlaylist", url: url }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.report) {
      jsonPreview.value = response.report;
      statusDiv.innerText = `✅ HLS analysis complete. Best quality: ${response.bestQuality?.quality || 'Unknown'}`;
    } else {
      statusDiv.innerText = '❌ Failed to analyze HLS playlist.';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
  });
});

// ═══ FIND CHANGES ═══
document.getElementById('findChanges').addEventListener('click', () => {
  if (!currentRecordingData) { 
    alert('⚠️ No recording data. Click Stop first.'); 
    return; 
  }

  statusDiv.innerText = '🔍 Finding request changes...';
  progressFill.style.width = '30%';

  chrome.runtime.sendMessage({ type: "findRequestChanges" }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.report) {
      jsonPreview.value = response.report;
      statusDiv.innerText = `✅ Found ${response.diffs?.length || 0} changed endpoints.`;
    } else {
      statusDiv.innerText = '❌ No changes found.';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
  });
});

// ═══ ANALYZE MAGNET LINKS ═══
document.getElementById('analyzeMagnets').addEventListener('click', () => {
  if (!currentRecordingData) { 
    alert('⚠️ No recording data. Click Stop first.'); 
    return; 
  }

  statusDiv.innerText = '🧲 Analyzing magnet links...';
  progressFill.style.width = '30%';

  chrome.runtime.sendMessage({ type: "analyzeMagnetLinks" }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.magnets) {
      let output = '=== MAGNET LINKS ===\n\n';
      for (const magnet of response.magnets) {
        output += `📌 ${magnet.displayName || 'Unknown'}\n`;
        output += `   Hash: ${magnet.infoHash}\n`;
        output += `   Quality: ${magnet.quality || 'Unknown'}\n`;
        if (magnet.year) output += `   Year: ${magnet.year}\n`;
        if (magnet.trackers.length > 0) {
          output += `   Trackers: ${magnet.trackers.length}\n`;
        }
        output += `   Source: ${magnet.source}\n`;
        output += `   ${magnet.raw}\n\n`;
      }
      jsonPreview.value = output;
      statusDiv.innerText = `✅ Found ${response.magnets.length} magnet links.`;
    } else {
      statusDiv.innerText = '❌ No magnet links found.';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
  });
});

// ═══ MAP SPA ROUTES ═══
document.getElementById('mapSPA').addEventListener('click', () => {
  if (!currentRecordingData) { 
    alert('⚠️ No recording data. Click Stop first.'); 
    return; 
  }

  statusDiv.innerText = '🗺️ Mapping SPA routes...';
  progressFill.style.width = '30%';

  chrome.runtime.sendMessage({ type: "mapSPARoutes" }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.structure) {
      jsonPreview.value = response.structure;
      statusDiv.innerText = `✅ Mapped ${response.routes?.totalRoutes || 0} SPA routes.`;
    } else {
      statusDiv.innerText = '❌ No SPA routes found.';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
  });
});

// ═══ DISCOVER ALL ROUTES ═══
document.getElementById('discoverRoutes').addEventListener('click', () => {
  if (!currentRecordingData) { 
    alert('⚠️ No recording data. Click Stop first.'); 
    return; 
  }

  statusDiv.innerText = '🗺️ Discovering all routes...';
  progressFill.style.width = '30%';

  chrome.runtime.sendMessage({ type: "discoverAllRoutes" }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.report) {
      jsonPreview.value = response.report;
      statusDiv.innerText = `✅ Found ${response.routes?.summary?.totalPages || 0} pages, ${response.routes?.summary?.totalAPI || 0} APIs.`;
    } else {
      statusDiv.innerText = '❌ Failed to discover routes.';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
  });
});

// ═══ DISCOVER SELECTORS ═══
document.getElementById('discoverSelectors').addEventListener('click', () => {
  if (!currentRecordingData) { 
    alert('⚠️ No recording data. Click Stop first.'); 
    return; 
  }

  statusDiv.innerText = '🎯 Discovering selectors...';
  progressFill.style.width = '30%';

  chrome.runtime.sendMessage({ type: "discoverSelectors" }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.report) {
      jsonPreview.value = response.report;
      statusDiv.innerText = `✅ Found ${response.selectors?.itemContainers?.length || 0} container selectors.`;
    } else {
      statusDiv.innerText = '❌ Failed to discover selectors. Try browsing more pages first.';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
  });
});

// ═══ GENERATE SCHEMA ═══
document.getElementById('generateSchema').addEventListener('click', () => {
  if (!currentRecordingData) { 
    alert('⚠️ No recording data. Click Stop first.'); 
    return; 
  }

  statusDiv.innerText = '📋 Generating schema...';
  progressFill.style.width = '30%';

  chrome.runtime.sendMessage({ type: "generateSchema" }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.report) {
      jsonPreview.value = response.report;
      statusDiv.innerText = `✅ Schema generated from ${response.schema ? 'captured data' : 'available data'}.`;
    } else {
      statusDiv.innerText = '❌ Failed to generate schema.';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
  });
});

// ═══ VISUALIZE HLS ═══
document.getElementById('visualizeHLS').addEventListener('click', () => {
  const url = prompt('📝 Enter HLS playlist URL to visualize:', '');
  if (!url) return;

  statusDiv.innerText = '📹 Visualizing HLS playlist...';
  progressFill.style.width = '30%';

  chrome.runtime.sendMessage({ type: "visualizeHLSPlaylist", url: url }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.report) {
      jsonPreview.value = response.report;
      statusDiv.innerText = `✅ HLS visualization complete.`;
    } else {
      statusDiv.innerText = '❌ Failed to visualize HLS.';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
  });
});

// ═══ DEOBFUSCATE JS ═══
document.getElementById('deobfuscateJS').addEventListener('click', () => {
  const code = prompt('📝 Paste obfuscated JavaScript code to deobfuscate:');
  if (!code) return;

  statusDiv.innerText = '🔓 Deobfuscating JavaScript...';
  progressFill.style.width = '30%';

  chrome.runtime.sendMessage({ type: "deobfuscateJavaScript", code: code }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.report) {
      jsonPreview.value = response.report;
      statusDiv.innerText = `✅ Deobfuscation complete.`;
    } else {
      statusDiv.innerText = '❌ Failed to deobfuscate.';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
  });
});

// ═══ ANALYZE COOKIES ═══
document.getElementById('analyzeCookies').addEventListener('click', () => {
  if (!currentRecordingData) { 
    alert('⚠️ No recording data. Click Stop first.'); 
    return; 
  }

  statusDiv.innerText = '🍪 Analyzing cookies...';
  progressFill.style.width = '30%';

  chrome.runtime.sendMessage({ type: "analyzeCookies" }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.report) {
      jsonPreview.value = response.report;
      statusDiv.innerText = `✅ Cookie analysis complete.`;
    } else {
      statusDiv.innerText = '❌ Failed to analyze cookies.';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
  });
});

// ═══ RECORD SEQUENCE ═══
document.getElementById('recordSequence').addEventListener('click', () => {
  if (!currentRecordingData) { 
    alert('⚠️ No recording data. Click Stop first.'); 
    return; 
  }

  statusDiv.innerText = '🔄 Recording request sequence...';
  progressFill.style.width = '30%';

  chrome.runtime.sendMessage({ type: "recordRequestSequence" }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.report) {
      jsonPreview.value = response.report;
      statusDiv.innerText = `✅ Sequence recorded (${response.sequence?.summary?.totalRequests || 0} requests).`;
    } else {
      statusDiv.innerText = '❌ Failed to record sequence.';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
  });
});

// ═══ COMPARE SITES ═══
document.getElementById('compareSites').addEventListener('click', () => {
  if (!currentRecordingData) { 
    alert('⚠️ No recording data. Click Stop first.'); 
    return; 
  }

  const input = prompt('📝 Paste JSON data for Site 2 (or leave empty to compare with current data):');
  let site2Data = null;
  if (input) {
    try {
      site2Data = JSON.parse(input);
    } catch (e) {
      alert('❌ Invalid JSON data.');
      return;
    }
  }

  statusDiv.innerText = '🔀 Comparing sites...';
  progressFill.style.width = '30%';

  chrome.runtime.sendMessage({ 
    type: "compareSites", 
    site1Data: currentRecordingData,
    site2Data: site2Data 
  }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.report) {
      jsonPreview.value = response.report;
      statusDiv.innerText = `✅ Site comparison complete.`;
    } else {
      statusDiv.innerText = '❌ Failed to compare sites.';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
  });
});

// ═══ GENERATE REGEX ═══
document.getElementById('generateRegex').addEventListener('click', () => {
  if (!currentRecordingData) { 
    alert('⚠️ No recording data. Click Stop first.'); 
    return; 
  }

  statusDiv.innerText = '📝 Generating regex patterns...';
  progressFill.style.width = '30%';

  chrome.runtime.sendMessage({ type: "generateRegexPatterns" }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.report) {
      jsonPreview.value = response.report;
      statusDiv.innerText = `✅ Regex patterns generated.`;
    } else {
      statusDiv.innerText = '❌ Failed to generate regex.';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
  });
});

// ═══ TRACK VERSION ═══
document.getElementById('trackVersion').addEventListener('click', () => {
  if (!currentRecordingData) { 
    alert('⚠️ No recording data. Click Stop first.'); 
    return; 
  }

  statusDiv.innerText = '📌 Tracking site version...';
  progressFill.style.width = '30%';

  chrome.runtime.sendMessage({ type: "trackSiteVersion" }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.report) {
      jsonPreview.value = response.report;
      statusDiv.innerText = `✅ Version tracking complete.`;
    } else {
      statusDiv.innerText = '❌ Failed to track version.';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
  });
});

// ═══ GENERATE TESTS ═══
document.getElementById('generateTests').addEventListener('click', () => {
  if (!currentRecordingData) { 
    alert('⚠️ No recording data. Click Stop first.'); 
    return; 
  }

  const siteName = prompt('📝 Enter site name for tests:', 'CustomSite');
  if (!siteName) return;

  statusDiv.innerText = '🧪 Generating tests...';
  progressFill.style.width = '30%';

  chrome.runtime.sendMessage({ 
    type: "generateTests", 
    siteName: siteName,
    data: currentRecordingData 
  }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.code) {
      jsonPreview.value = response.code;
      
      // ═══ FIX: Use proper filename ═══
      const filename = `test_${siteName.toLowerCase().replace(/[^a-z0-9]/g, '_')}.py`;
      // [FIX] uses the shared, fixed downloadBlob() instead of the
      // duplicated, premature-revoke pattern (see its own comment).
      // [FIX-saveas] was saveAs: true -- see the detailed [FIX-saveas] comment near
      // doExport()'s downloadBlob call (~line 530) for why this caused random filenames.
      downloadBlob(response.code, filename, 'text/x-python', false);
      
      statusDiv.innerText = `✅ Tests saved as ${filename}`;
    } else {
      statusDiv.innerText = '❌ Failed to generate tests.';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
  });
});

// ═══ OPTIONS LINK ═══
optionsLink.onclick = (e) => {
  e.preventDefault();
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  }
  return false;
};

// ═══ MESSAGE HANDLERS ═══
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'challengeStatus') {
    if (message.status === 'solving') {
      challengeStatusDiv.innerText = "🧩 Solving challenge... (check new tab)";
    } else if (message.status === 'solved') {
      challengeStatusDiv.innerText = "✅ Challenge solved!";
      setTimeout(() => { challengeStatusDiv.innerText = ""; }, 5000);
    } else if (message.status === 'failed') {
      challengeStatusDiv.innerText = "❌ Challenge solving failed. Try manual.";
    }
  } else if (message.type === 'ytsDataExtracted') {
    if (message.data && message.data.length > 0) {
      const totalLinks = message.data.reduce((acc, d) => acc + (d.links ? d.links.length : 0), 0);
      statusDiv.innerText = `🎯 YTS data auto-extracted: ${message.data.length} movies, ${totalLinks} links found. Click "YTS" to copy.`;
      window._ytsData = message.data;
    }
  } else if (message.type === 'arabicMoviesExtracted') {
    if (message.data && message.data.length > 0) {
      statusDiv.innerText = `🇸🇦 Arabic movies auto-extracted: ${message.data.length} movies found. Click "WeCima" to copy.`;
      window._arabicData = message.data;
    }
  } else if (message.type === 'saveFilesExtracted') {
    if (message.data && message.data.downloadUrl) {
      statusDiv.innerText = `📦 SaveFiles download auto-extracted: ${message.data.filename || 'file'}`;
      window._saveFilesData = message.data;
    }
  } else if (message.type === 'autoSnapshotToggled') {
    autoSnapshotCheckbox.checked = message.enabled;
    statusDiv.innerText = `📸 Auto-snapshot ${message.enabled ? 'enabled' : 'disabled'}`;
  }
});

// [FIX] this used to also register its own document-level keydown listener for
// Ctrl+Shift+S / Ctrl+Shift+R, duplicating the SAME shortcuts already declared in
// manifest.json's "commands" and handled globally by keyboard-shortcuts.js's
// chrome.commands.onCommand listener. Chrome's commands API fires those globally whenever
// the browser has focus, including while the extension's own popup is open and focused --
// so pressing Ctrl+Shift+S while this popup was open fired BOTH the global command (which
// sends "saveSnapshot" via the background script) AND this local listener (which called
// saveSnapshotBtn.click(), sending the exact same message a second time) -- two separate
// snapshot files saved for one key press, since manual saves aren't covered by the
// auto-snapshot cooldown that only debounces automatic post-navigation captures. Removed
// entirely: the manifest-declared shortcuts already cover this correctly and globally, so
// nothing is lost by not also handling it here.

// ═══ HELPERS ═══
function escHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}


// ═══ [4.7.0] Cloudflare clearance for NovaPlay ═══════════════════════════
// When Brave passes a site's Cloudflare check it gets a cf_clearance cookie,
// tied to this browser's identity (User-Agent) and internet address. The box
// shares the PC's address, so with the same cookie + User-Agent NovaPlay may
// get through without the browser proxy. Saves novaplay_cookies.json: copy it
// to /etc/enigma2/ on the box.
function _cookieSiteLabel(host) {
  const parts = String(host || '').toLowerCase().split('.').filter(Boolean);
  if (parts.length < 2) return parts[0] || '';
  const sld = parts[parts.length - 2];
  if (['co', 'com', 'net', 'org'].includes(sld) && parts.length >= 3) return parts[parts.length - 3];
  return sld;
}

document.getElementById("exportCookies").onclick = () => {
  if (!chrome.cookies) {
    statusDiv.innerText = "❌ Reload the extension (it needs the new 'cookies' permission).";
    return;
  }
  chrome.windows.getLastFocused({ windowTypes: ["normal"], populate: true }, (win) => {
    const tab = (win && win.tabs || []).find(t => t.active);
    let label = '';
    try { label = _cookieSiteLabel(new URL(tab.url).hostname); } catch (e) {}
    chrome.cookies.getAll({}, (all) => {
      const sites = {};
      for (const c of all || []) {
        const dom = String(c.domain || '').replace(/^\./, '').toLowerCase();
        const mine = label && _cookieSiteLabel(dom) === label;
        // this site's cookies, plus every site's Cloudflare clearance
        if (!mine && c.name !== 'cf_clearance') continue;
        const site = sites[dom] || (sites[dom] = { cookies: {}, expires: 0 });
        site.cookies[c.name] = c.value;
        if (c.name === 'cf_clearance' && c.expirationDate) site.expires = Math.round(c.expirationDate);
      }
      const n = Object.keys(sites).length;
      if (!n) {
        statusDiv.innerText = "ℹ️ No cookies found -- open the site in this tab first (pass its Cloudflare check), then click again.";
        return;
      }
      const payload = {
        format: 'novaplay-cookies-1',
        exported: new Date().toISOString(),
        user_agent: navigator.userAgent,
        note: 'Copy to /etc/enigma2/novaplay_cookies.json on the box. cf_clearance only works with this exact User-Agent and the same internet address, and expires (usually within hours to a day).',
        sites: sites,
      };
      downloadBlob(JSON.stringify(payload, null, 2), 'novaplay_cookies.json', 'application/json');
      const cf = Object.entries(sites).filter(([d, v]) => v.cookies.cf_clearance).map(([d]) => d);
      statusDiv.innerText = `🍪 Saved novaplay_cookies.json: ${n} site(s)` +
        (cf.length ? `, Cloudflare clearance for ${cf.slice(0, 4).join(', ')}` : ' (no Cloudflare clearance found)') +
        ` -- copy it to /etc/enigma2/ on the box.`;
    });
  });
};

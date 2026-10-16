// message-handlers.js - All chrome.runtime.onMessage handlers
import { state, scheduleSave, persistState, cleanupMemory, broadcastRecordingState, registrableDomain, isSameSite, setPrimaryDomainFromUrl, shouldRecordTab, shouldRecordUrl } from './state.js';
import { CONFIG } from './config.js';
import { resetScriptCapture } from './script-capture.js';
import { handleCloudflareChallenge, solveManually, CHALLENGE_SOLVING } from './challenge-solver.js';
import {
  isYTSSite, isArabicMovieSite, isSaveFilesSite,
  extractYTSTorrents, extractArabicMovieData, extractSaveFilesData,
  extractAllYTSPages, buildMagnetLink, isSuspectedBackend,
  isAdDomain, isPopupOrRedirect, isContentDomain, isMediaUrl
} from './site-detection.js';
import { captureScreenshot, captureSnapshot, scheduleAutoSnapshot, resetSnapshotState, pendingAutoSnapshotTimers, expectingSnapshotFilename, pendingDownloadFilenames } from './screenshot.js';
import { exportAsCSV, exportAsHAR, exportAsMarkdown } from './export-utils.js';
import { getTorrentLinks } from './torrent-utils.js';

// NEW IMPORTS - All features
import { generatePythonExtractor, generateResolverCode, generateCompleteExtractor } from './export-generator.js';
import { discoverAPIEndpoints, discoverStreamResolvers, discoverSiteStructure } from './api-discoverer.js';
import { findRequestChanges, generateDiffReport } from './diff-viewer.js';
import { analyzeMagnetLinks, generateTorrentMetadata } from './magnet-parser.js';
import { mapSPARoutes, generateSPAStructure } from './spa-route-mapper.js';
import { solveChallenge, waitForChallengeSolved } from './challenge-solver-integration.js';
import { discoverQualityVariants } from './quality-discoverer.js';
import { analyzeHLSPlaylist, findBestQuality, generateQualityReport } from './hls-analyzer.js';
import { discoverAllRoutes, generateRouteReport } from './route-discoverer.js';
import { discoverSelectors, generateSelectorReport } from './selector-discovery.js';
import { generateSchema, generateSchemaReport } from './schema-generator.js';
import { visualizeHLSPlaylist, generateVisualizationReport } from './m3u8-visualizer.js';
import { deobfuscateJavaScript, generateDeobfuscationReport } from './js-deobfuscator.js';
import { analyzeCookies, generateCookieReport } from './cookie-analyzer.js';
import { recordRequestSequence, generateSequenceReport } from './sequence-recorder.js';
import { generateComparisonReport } from './site-comparator.js';
import { generateRegexPatterns, generateRegexReport } from './regex-generator.js';
import { trackSiteVersion, generateVersionReport } from './version-tracker.js';
import { generateTests, generateTestReport } from './test-generator.js';

export function initMessageHandlers() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const s = state;

    // ═══ START RECORDING ═══
    if (message.type === "startRecording") {
      s.recording = true;
      s.filterMode = message.filterMode === "xhr" ? "xhr" : "all";
      s.autoSnapshot = !!message.autoSnapshot;
      console.log("[auto-snapshot] START RECORDING - autoSnapshot =", s.autoSnapshot);
      s.primaryDomain = null;
      s.actions = [];
      s.networkLog = [];
      s.pending = {};
      s.xhrBodies = [];
      s.scriptBodies = [];
      s.frameDocuments = [];
      resetScriptCapture();   // [FIX] see script-capture.js
      resetSnapshotState();   // [FIX] see screenshot.js
      s.userJourney = [];
      s.screenshots = [];
      // [FIX] encodedLinks was missing here, so it was undefined for every session started
      // from the popup (only a service-worker restart re-added it, via restoreState).
      s.contentPipeline = { source: '', movieList: [], downloadLinks: [], encodedLinks: [], metadata: {}, sequence: [] };
      s.recordTabId = message.tabId || null;
      // [FIX-tabfollow] a previous session's followed-tab set (popups the old recording
      // picked up via addRecordedTab()) must not leak into a brand-new recording -- those
      // tab ids are unrelated to whatever tab/site this new session is about, and could even
      // get reused by Chrome for a different, unrelated tab later.
      s.recordedTabIds = [];
      s.allowedDomains = message.allowedDomains || [];
      s.blockedDomains = message.blockedDomains || [];

      if (message.maxBodySize) {
        CONFIG.MAX_BODY_CHARS = Math.max(1000, parseInt(message.maxBodySize, 10) * 1024);
      }

      chrome.action.setBadgeText({ text: "REC" });
      chrome.action.setBadgeBackgroundColor({ color: "#FF0000" });
      broadcastRecordingState(true);

      chrome.windows.getLastFocused({ windowTypes: ['normal'], populate: true }, (win) => {
        const tab = (win && win.tabs || []).find(t => t.active);
        if (tab && tab.url) {
          const wasSet = setPrimaryDomainFromUrl(tab.url);
          if (wasSet) {
            console.log("[auto-snapshot] primaryDomain set to:", s.primaryDomain);
          } else {
            s.primaryDomain = null;
            console.warn("[auto-snapshot] Could not set primaryDomain from URL:", tab.url);
          }
          if (tab.id) {
            if (isYTSSite(tab.url)) {
              setTimeout(() => autoExtractYTSTorrents(tab.id, tab.url), 2000);
            } else if (isArabicMovieSite(tab.url)) {
              setTimeout(() => autoExtractArabicMovies(tab.id, tab.url), 2000);
            } else if (isSaveFilesSite(tab.url)) {
              setTimeout(() => autoExtractSaveFiles(tab.id, tab.url), 1000);
            }
          }
        } else {
          console.warn("[auto-snapshot] No active tab found when starting recording");
        }
        persistState();
      });
      sendResponse({ status: "ok" });
    }

    // ═══ UPDATE CONFIG ═══
    else if (message.type === "updateConfig") {
      const cfg = message.config || {};
      if (Array.isArray(cfg.allowedDomains)) s.allowedDomains = cfg.allowedDomains;
      if (Array.isArray(cfg.blockedDomains)) s.blockedDomains = cfg.blockedDomains;
      if (cfg.maxBodySize) {
        CONFIG.MAX_BODY_CHARS = Math.max(1000, parseInt(cfg.maxBodySize, 10) * 1024);
      }
      persistState();
      sendResponse({ status: "ok" });
    }

    // ═══ GET RECORDING STATUS ═══
    else if (message.type === "getRecordingStatus") {
      sendResponse({
        recording: s.recording,
        filterMode: s.filterMode,
        autoSnapshot: s.autoSnapshot,
        recordTabId: s.recordTabId,
        allowedDomains: s.allowedDomains,
        blockedDomains: s.blockedDomains,
        maxBodySize: CONFIG.MAX_BODY_CHARS
      });
    }

    // ═══ STOP RECORDING ═══
    else if (message.type === "stopRecording") {
      s.recording = false;
      s.primaryDomain = null;
      chrome.action.setBadgeText({ text: "" });
      broadcastRecordingState(false);
      for (const id in s.pending) s.networkLog.push(s.pending[id]);
      s.pending = {};
      for (const tabId in pendingAutoSnapshotTimers) {
        clearTimeout(pendingAutoSnapshotTimers[tabId]);
        delete pendingAutoSnapshotTimers[tabId];
      }
      console.log("Recording stopped. Actions:", s.actions.length, "Network:", s.networkLog.length);
      persistState();
      sendResponse({ status: "ok" });
      captureSnapshot();
    }

    // ═══ GET RECORDING DATA ═══
    else if (message.type === "getRecordingData") {
      sendResponse({
        data: {
          filterMode: s.filterMode,
          actions: s.actions,
          networkLog: s.networkLog,
          xhrBodies: s.xhrBodies,
          scriptBodies: s.scriptBodies,
          frameDocuments: s.frameDocuments || [],
          userJourney: s.userJourney,
          contentPipeline: s.contentPipeline,
          // [FIX] this used to truncate every screenshot's dataUrl to 100 characters -- since
          // this is the ONLY message type that feeds every export button (JSON/CSV/HAR/MD all
          // read from this single response, cached as currentRecordingData in popup.js), that
          // meant the full, real screenshot images were captured and held in background
          // memory but never actually reachable through ANY export path at all -- directly
          // contradicting the Markdown export's own footer text, which claims "Full
          // screenshot data available in JSON export". Confirmed directly: that claim was
          // false. CONFIG.MAX_SCREENSHOTS already bounds how many are kept at once, so the
          // total payload size stays reasonable; passing them through in full is what makes
          // the JSON export's own promise of completeness actually true.
          screenshots: s.screenshots
        }
      });
      return true;
    }

    // ═══ IMPORT HTML SNAPSHOTS ═══
    // [NEW] confirmed directly: generatePluginExtractor()/generateCompleteExtractor()
    // (export-generator.js) and the selector-discovery pipeline they call
    // (discoverSelectorsFromCapturedData -> extractSelectorsFromHTML) already work
    // perfectly well on plain saved HTML text -- extractSelectorsFromHTML() just
    // regex-scans body text for class names, no live network capture needed -- but
    // nothing anywhere in this extension could ever GET a saved .html file INTO
    // networkLog/xhrBodies in the first place. The only populated path was the live
    // recorder (page-hook.js -> "xhrResponseBody" above). This closes that gap: a
    // user-selected HTML file (read client-side in popup.js, no filesystem access
    // needed here) is wrapped into the exact networkLog + xhrBodies shapes those
    // real capture paths already produce, so every downstream consumer (analysis,
    // generation, JSON/CSV/HAR export, diffing) works on it with zero changes of
    // its own -- "imported" is just another source, not a special case.
    else if (message.type === "importHtmlSnapshots") {
      const files = Array.isArray(message.files) ? message.files : [];
      let added = 0;

      for (const file of files) {
        const rawBody = (file && typeof file.body === "string") ? file.body : "";
        if (!rawBody) continue;

        // Prefer a real URL the page itself declares (canonical link or
        // og:url meta -- both standard on any WordPress/CMS site, and
        // present on every real snapshot this was built against) over
        // guessing one. Falls back to the primary domain from an earlier
        // live recording, then to a clearly-fake placeholder host, so a
        // missing URL can never crash downstream `new URL()` calls (those
        // already wrap in try/catch, but a real host lets baseUrl/category
        // detection actually work whenever one truly is available).
        let url = "";
        const canonicalM = rawBody.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
        const ogUrlM = rawBody.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i);
        const safeName = encodeURIComponent((file.filename || "snapshot").replace(/\.[^.]+$/, ""));
        if (canonicalM) url = canonicalM[1];
        else if (ogUrlM) url = ogUrlM[1];
        else if (s.primaryDomain) url = `https://${s.primaryDomain}/${safeName}`;
        else url = `https://imported.local/${safeName}`;

        // Same truncation convention real captures use (page-hook.js's own
        // truncate()), so an imported file can never blow past the same
        // per-body size budget a live recording respects.
        const truncated = rawBody.length > CONFIG.MAX_BODY_CHARS;
        const body = truncated ? rawBody.slice(0, CONFIG.MAX_BODY_CHARS) : rawBody;
        const timestamp = Date.now();

        s.networkLog.push({
          url,
          method: "GET",
          statusCode: 200,
          responseHeaders: { "content-type": "text/html" },
          requestHeaders: {},
          timestamp,
          fromCache: false,
          via: "html_import",
          importedFilename: file.filename || null
        });

        s.xhrBodies.push({
          timestamp,
          tabId: null,
          url,
          method: "GET",
          status: 200,
          via: "html_import",
          truncated,
          body,
          streamUrls: [],
          isStreamApi: false,
          isKnownApi: false,
          jsonData: null,
          contentType: "text/html"
        });

        added++;
      }

      if (added > 0) {
        if (s.networkLog.length > CONFIG.MAX_NETWORK_LOG_SIZE) {
          s.networkLog = s.networkLog.slice(-CONFIG.MAX_NETWORK_LOG_SIZE);
        }
        if (s.xhrBodies.length > CONFIG.MAX_XHR_BODIES) {
          s.xhrBodies = s.xhrBodies.slice(-CONFIG.MAX_XHR_BODIES);
        }
        persistState();
      }

      sendResponse({
        status: added > 0 ? "ok" : "no_content",
        added,
        total: s.xhrBodies.length,
        data: {
          filterMode: s.filterMode,
          actions: s.actions,
          networkLog: s.networkLog,
          xhrBodies: s.xhrBodies,
          scriptBodies: s.scriptBodies,
          frameDocuments: s.frameDocuments || [],
          userJourney: s.userJourney,
          contentPipeline: s.contentPipeline
        }
      });
      return true;
    }

    // ═══ EXPORT ═══
    else if (message.type === "export") {
      const data = { filterMode: s.filterMode, actions: s.actions, networkLog: s.networkLog, xhrBodies: s.xhrBodies, scriptBodies: s.scriptBodies, frameDocuments: s.frameDocuments || [], userJourney: s.userJourney, contentPipeline: s.contentPipeline };
      const format = message.format || 'json';
      let content, filename, mimeType;

      // [FIX] confirmed directly, across several rounds of real device logs: this is a
      // SEPARATE path from popup.js's own export button -- something else in the extension
      // (a context menu entry or shortcut, not the popup UI) sends this "export" message
      // instead, so it never got any of the fixes already applied to popup.js's own
      // downloadBlob(): (1) static, non-timestamped filenames, risking silent overwrites;
      // (2) a blob: URL, which Brave's "blob partitioning" privacy feature silently
      // corrupted before any listener code could see the real name; and (3) saveAs: true,
      // which -- confirmed separately, after switching to a data: URL -- Brave ALSO ignores
      // entirely for the supplied filename, falling back to its own generic default
      // ("download.json") rather than even a smarter MIME-based guess. The one pattern
      // proven correct in every device log all night is screenshot.js's snapshot download:
      // a data: URL, saveAs: false, filename supplied directly. Matching that here.
      const exportTimestamp = new Date().toISOString().replace(/[:.]/g, '-');

      switch (format) {
        case 'csv':
          content = exportAsCSV(data);
          filename = `stream_recording_${exportTimestamp}.csv`;
          mimeType = 'text/csv';
          break;
        case 'har':
          content = JSON.stringify(exportAsHAR(data), null, 2);
          filename = `stream_recording_${exportTimestamp}.har`;
          mimeType = 'application/json';
          break;
        case 'markdown':
          content = exportAsMarkdown(data);
          filename = `stream_recording_${exportTimestamp}.md`;
          mimeType = 'text/markdown';
          break;
        default:
          content = JSON.stringify(data, null, 2);
          filename = `stream_recording_${exportTimestamp}.json`;
          mimeType = 'application/json';
      }

      const base64 = btoa(unescape(encodeURIComponent(content)));
      const url = `data:${mimeType};base64,${base64}`;
      chrome.downloads.download({ url, filename, saveAs: false, conflictAction: "uniquify" }, (downloadId) => {
        if (chrome.runtime.lastError) {
          console.warn('[export] download failed:', chrome.runtime.lastError.message);
          return;
        }
        // [FIX-bloburl2] see pendingDownloadFilenames' own comment (screenshot.js) -- the
        // `filename` passed above is not actually honored by Brave for a data: URL on its
        // own; this explicit registration is what makes onDeterminingFilename apply it.
        pendingDownloadFilenames[downloadId] = filename;
      });
      sendResponse({ status: "exporting", format, filename });
    }

    // ═══ DOWNLOAD FILE (shared by popup.js's downloadBlob) ═══
    // [FIX-bloburl2] popup.js runs in its own extension page, a separate JS context from this
    // background service worker, so it can't share pendingDownloadFilenames directly -- it
    // can't populate the map in time for onDeterminingFilename to see the entry. Routing the
    // actual chrome.downloads.download() call through here instead (same context as the map
    // and the listener that reads it) closes that race entirely: the entry is set in this same
    // download() callback, synchronously before onDeterminingFilename can fire for it.
    else if (message.type === "downloadFile") {
      const { content, filename, mimeType, saveAs } = message;
      const base64 = btoa(unescape(encodeURIComponent(content)));
      const url = `data:${mimeType};base64,${base64}`;
      chrome.downloads.download({ url, filename, saveAs: !!saveAs, conflictAction: "uniquify" }, (downloadId) => {
        if (chrome.runtime.lastError || !downloadId) {
          sendResponse({ ok: false, filename, downloadId: null, error: chrome.runtime.lastError?.message });
          return;
        }
        pendingDownloadFilenames[downloadId] = filename;
        let settled = false;
        function finish(result) {
          if (settled) return;
          settled = true;
          chrome.downloads.onChanged.removeListener(onChanged);
          sendResponse(result);
        }
        function onChanged(delta) {
          if (delta.id !== downloadId) return;
          if (delta.state && delta.state.current && delta.state.current !== "in_progress") {
            const complete = delta.state.current === "complete";
            finish({
              ok: complete, filename, downloadId,
              error: complete ? undefined : (delta.error && delta.error.current) || delta.state.current
            });
          }
        }
        chrome.downloads.onChanged.addListener(onChanged);
        // Safety net -- same reasoning as downloadBlob() used to have: the download itself
        // already started fine (no lastError above), so don't hang the caller forever if
        // onChanged somehow never fires.
        setTimeout(() => finish({ ok: true, filename, downloadId }), 30000);
      });
      return true; // keep the message channel open for the async sendResponse above
    }

    // ═══ ACTION ═══
    else if (message.type === "action") {
      if (s.recording) {
        const action = {
          timestamp: Date.now(),
          url: message.url,
          selector: message.selector,
          type: message.actionType,
          value: message.value,
          text: message.text,
          tagName: message.tagName,
          href: message.href,
          isDownloadLink: message.isDownloadLink,
          pageState: message.pageState,
          data: message.data
        };
        s.actions.push(action);

        s.userJourney.push({
          timestamp: Date.now(),
          action: message.actionType,
          url: message.url,
          data: message.data || {}
        });

        scheduleSave();

        // [FIX] "submit" was missing here. A <form method="post"> submit (e.g. EgyDead's
        // "watch" button, which POSTs and reloads the SAME url with the server list now
        // revealed) never counted as capture-worthy, so this exact, very common reveal pattern
        // never auto-recaptured -- confirmed directly against a real reverse-engineering
        // session this tool was built to support.
        const isCaptureWorthy = message.actionType === "navigate" || message.actionType === "click" || message.actionType === "spa_navigate" || message.actionType === "submit";
        const isSame = isSameSite(message.url);
        console.log("[auto-snapshot] ACTION - isCaptureWorthy:", isCaptureWorthy, "isSameSite:", isSame, "autoSnapshot:", s.autoSnapshot, "sender.frameId:", sender.frameId);

        if (s.autoSnapshot && isCaptureWorthy && sender.tab && sender.frameId === 0) {
          const tabId = sender.tab.id;
          if (isSame) {
            console.log("[auto-snapshot] ✅ scheduling from action:", message.actionType, message.url);
            // [FIX] a form submit is a deliberate, low-frequency, user-driven reveal action --
            // unlike clicks/spa-mutations, it should never be silently dropped by the generic
            // per-tab cooldown meant to stop noisy click/mutation spam. A page freshly loaded
            // and then immediately submitted (fast human click-through) would otherwise fall
            // inside CONFIG.SNAPSHOT_COOLDOWN_MS and lose the reveal snapshot entirely.
            scheduleAutoSnapshot(tabId, undefined, message.actionType === "submit");
          } else {
            console.log("[auto-snapshot] ❌ action skipped - not same site:", message.url);
          }
        } else {
          console.log("[auto-snapshot] ❌ action condition failed - autoSnapshot:", s.autoSnapshot, "isCaptureWorthy:", isCaptureWorthy, "hasTab:", !!sender.tab, "frameId:", sender.frameId);
        }
      }
      sendResponse({ status: "ok" });
    }

    // ═══ ARABIC MOVIES EXTRACTED ═══
    else if (message.type === "arabic_movies_extracted") {
      if (s.recording) {
        s.contentPipeline.movieList = message.data;
        s.contentPipeline.source = 'wecima';
        s.contentPipeline.sequence.push({
          timestamp: Date.now(),
          type: 'movies_extracted',
          data: message.data
        });
        scheduleSave();
      }
      sendResponse({ status: "ok" });
    }

    // ═══ WECIMA ENCODED LINKS EXTRACTED ═══
    // [FIX] content.js has always sent this (extractWecimaEncodedLinks), and state.js
    // stores, persists, trims and exports contentPipeline.encodedLinks -- but nothing
    // here ever received the message, so encodedLinks was empty in every export.
    else if (message.type === "wecima_encoded_links_extracted") {
      if (s.recording && Array.isArray(message.data)) {
        if (!Array.isArray(s.contentPipeline.encodedLinks)) s.contentPipeline.encodedLinks = [];
        const have = new Set(s.contentPipeline.encodedLinks.map(l => l && l.url));
        let added = 0;
        for (const link of message.data) {
          if (!link || !link.url || have.has(link.url)) continue;
          have.add(link.url);
          s.contentPipeline.encodedLinks.push({ ...link, pageUrl: message.url || null, timestamp: Date.now() });
          added++;
        }
        if (added > 0) {
          s.contentPipeline.sequence.push({
            timestamp: Date.now(),
            type: 'encoded_links_extracted',
            url: message.url || null,
            count: added
          });
          scheduleSave();
        }
      }
      sendResponse({ status: "ok" });
    }

    // ═══ STREAMING CONTENT EXTRACTED ═══
    // [FIX] same gap as above: content.js's extractStreamingContent() (EgyDead-style
    // listing pages) sent this, but it was never handled, so those scraped items never
    // reached contentPipeline. Stored the same way as arabic_movies_extracted.
    else if (message.type === "streaming_content_extracted") {
      if (s.recording && Array.isArray(message.data) && message.data.length > 0) {
        s.contentPipeline.movieList = message.data;
        try {
          s.contentPipeline.source = new URL(message.url).hostname || 'streaming';
        } catch (e) {
          s.contentPipeline.source = 'streaming';
        }
        s.contentPipeline.sequence.push({
          timestamp: Date.now(),
          type: 'streaming_content_extracted',
          url: message.url || null,
          data: message.data
        });
        scheduleSave();
      }
      sendResponse({ status: "ok" });
    }

    // ═══ SAVEFILES EXTRACTED ═══
    else if (message.type === "savefiles_extracted") {
      if (s.recording) {
        s.contentPipeline.downloadLinks.push(message.data);
        s.contentPipeline.source = 'savefiles';
        s.contentPipeline.sequence.push({
          timestamp: Date.now(),
          type: 'savefiles_extracted',
          data: message.data
        });
        scheduleSave();
      }
      sendResponse({ status: "ok" });
    }

    // ═══ MANUAL SOLVE ═══
    else if (message.type === "manualSolve") {
      const { tabId, url } = message;
      console.log("Manual solve requested for tab", tabId, url);
      solveManually(tabId, url).then((solved) => {
        chrome.runtime.sendMessage({
          type: 'challengeStatus',
          status: solved ? 'solved' : 'failed',
          tabId
        });
      });
      sendResponse({ status: "solving" });
    }

    // ═══ CHALLENGE DETECTED ═══
    else if (message.type === "challengeDetected") {
      const { challengeType, url } = message;
      const tabId = sender.tab ? sender.tab.id : message.tabId;
      if (s.recording) {
        s.actions.push({
          timestamp: Date.now(),
          url: url,
          type: 'challenge_detected',
          challengeType: challengeType
        });
      }
      const shouldAttemptSolve = tabId && !CHALLENGE_SOLVING[tabId] && (!s.recording || isSameSite(url));
      if (shouldAttemptSolve) {
        handleCloudflareChallenge(tabId, url);
      }
      sendResponse({ status: "ok" });
    }

    // ═══ SAVE SNAPSHOT ═══
    else if (message.type === "saveSnapshot") {
      captureSnapshot((success) => {
        sendResponse({ status: success ? "saved" : "failed" });
      });
      return true;
    }

    // ═══ CAPTURE SCREENSHOT ═══
    else if (message.type === "captureScreenshot") {
      const tabId = message.tabId || (sender.tab ? sender.tab.id : null);
      captureScreenshot(tabId, (screenshot) => {
        sendResponse({ status: screenshot ? "captured" : "failed", screenshot });
      });
      return true;
    }

    // ═══ XHR RESPONSE BODY ═══
    // ═══ FRAME DOCUMENT (live HTML of the page or an iframe, from content.js) ═══
    else if (message.type === "frameDocument") {
      const tabId = sender.tab ? sender.tab.id : null;
      if (s.recording && typeof message.html === "string" && message.url &&
          shouldRecordTab(tabId) && shouldRecordUrl(message.url)) {
        if (!Array.isArray(s.frameDocuments)) s.frameDocuments = [];
        const html = message.html;
        // same frame re-sent at DOMContentLoaded and load: keep only changed versions
        const dup = s.frameDocuments.some(d => d.url === message.url && d.size === html.length);
        if (!dup) {
          const truncated = html.length > CONFIG.MAX_FRAME_DOC_CHARS;
          s.frameDocuments.push({
            timestamp: Date.now(),
            tabId,
            frameId: sender.frameId,
            url: message.url,
            isTop: !!message.isTop,
            reason: message.reason || null,
            size: html.length,
            truncated,
            html: truncated ? html.slice(0, CONFIG.MAX_FRAME_DOC_CHARS) : html
          });
          if (s.frameDocuments.length > CONFIG.MAX_FRAME_DOCS) s.frameDocuments.shift();
          scheduleSave();
        }
      }
      sendResponse({ status: "ok" });
    }

    else if (message.type === "xhrResponseBody") {
      if (s.recording) {
        s.xhrBodies.push({
          timestamp: message.timestamp || Date.now(),
          tabId: sender.tab ? sender.tab.id : null,
          url: message.url,
          method: message.method,
          status: message.status,
          via: message.via,
          truncated: !!message.truncated,
          body: message.body || "",
          streamUrls: message.streamUrls || [],
          isStreamApi: message.isStreamApi || false,
          isKnownApi: message.isKnownApi || false,
          jsonData: message.jsonData || null,
          contentType: message.contentType || null
        });
        if (s.xhrBodies.length > CONFIG.MAX_XHR_BODIES) s.xhrBodies.shift();

        if (message.streamUrls && message.streamUrls.length > 0) {
          s.userJourney.push({
            timestamp: Date.now(),
            action: 'stream_urls_found',
            url: message.url,
            data: { streamUrls: message.streamUrls }
          });
        }
      }
      sendResponse({ status: "ok" });
    }

    // ═══ GET STREAM LINKS ═══
    else if (message.type === "getStreamLinks") {
      // [FIX] only special-cased the exact filename "master.txt", missing
      // other real .txt-extension playlist files from the same CDN family
      // (confirmed directly: "index-v1-a1.txt" is a real, captured stream
      // URL that this pattern silently missed). Generalized to any .txt
      // extension, matching the same real links that were missed before.
      const urlPattern = /\.(m3u8|mp4|ts|txt)(\?|$)|\/hls\d?\//i;
      const contentTypePattern = /video\/|mpegurl|application\/x-mpegurl/i;
      const isSegmentUrl = (u) => /\/seg-\d+-/i.test(u);

      const links = s.networkLog
        .filter((entry) => {
          if (isSegmentUrl(entry.url)) return false;
          if (urlPattern.test(entry.url)) return true;
          const ct = entry.responseHeaders && (entry.responseHeaders['content-type'] || entry.responseHeaders['Content-Type']);
          return ct && contentTypePattern.test(ct);
        })
        .map((entry) => entry.url);

      // [FIX] same missing .txt-extension issue as urlPattern above, same fix.
      // [FIX-adjunk] the old pattern had no "must have a real path" requirement,
      // so a bare host whose TLD coincidentally spells a media extension (confirmed
      // directly: "https://pool.ts" — .ts is a real ccTLD, not a transport-stream
      // segment here) matched just as happily as a genuine stream URL. Requiring
      // a literal "/" between the host and the final, extension-bearing segment
      // excludes that whole bare-domain false-positive class while still matching
      // every real stream/manifest URL, which always has a path.
      const bodyUrlPattern = /https?:\/\/[^\s"'<>\\]+?\/[^\s"'<>\\]*?\.(?:m3u8|mp4|ts|txt)(?:\?[^\s"'<>\\]*)?/gi;
      // [FIX-adjunk] ad/analytics bundles (prebid.js and friends, commonly vendored
      // from a generic CDN like cdn.jsdelivr.net -- that CDN itself is NOT ad-related
      // and isn't blocked) ship their own creative/test URLs inline in the response
      // body, e.g. an S3 bucket literally named "files.prebid.org" (S3's path-style
      // bucket naming, not a real hostname) serving "PrebidLogo.mp4" -- confirmed
      // directly from a real capture. isAdDomain() catches a known ad host; the
      // "prebid" substring check catches this S3-path-style case that isAdDomain's
      // hostname-only check can't see (the giveaway is in the path, not the host).
      const isAdOrJunkUrl = (u) => isAdDomain(u) || /prebid/i.test(u);
      const rawMatches = [];
      for (const entry of s.xhrBodies) {
        if (!entry.body) continue;
        const matches = entry.body.match(bodyUrlPattern) || [];
        if (!matches.length) continue;
        let sourceLabel = "";
        try {
          sourceLabel = new URL(entry.url).hostname;
        } catch (e) {
          sourceLabel = entry.url || "";
        }
        for (const m of matches) {
          const cleaned = m.replace(/\\\//g, '/');
          if (isSegmentUrl(cleaned)) continue;
          if (isAdOrJunkUrl(cleaned)) continue;
          links.push(cleaned);
          rawMatches.push({ url: cleaned, label: sourceLabel });
        }
      }

      const labelFrequency = new Map();
      for (const { label } of rawMatches) {
        labelFrequency.set(label, (labelFrequency.get(label) || 0) + 1);
      }
      const bestLabelForUrl = new Map();
      for (const { url, label } of rawMatches) {
        let urlHost = "";
        try { urlHost = new URL(url).hostname; } catch (e) {}
        const isSelfMatch = label === urlHost;
        const existing = bestLabelForUrl.get(url);
        if (!existing) {
          bestLabelForUrl.set(url, { label, isSelfMatch, freq: labelFrequency.get(label) || 0 });
          continue;
        }
        if (isSelfMatch && !existing.isSelfMatch) {
          bestLabelForUrl.set(url, { label, isSelfMatch, freq: labelFrequency.get(label) || 0 });
        } else if (isSelfMatch === existing.isSelfMatch) {
          const freq = labelFrequency.get(label) || 0;
          if (freq > existing.freq) {
            bestLabelForUrl.set(url, { label, isSelfMatch, freq });
          }
        }
      }

      const labeledLinks = [...bestLabelForUrl.entries()].map(([url, { label }]) =>
        label ? `[${label}] ${url}` : url
      );

      sendResponse({ links: [...new Set(links)], labeledLinks: [...new Set(labeledLinks)] });
    }

    // ═══ PAGE LOADED ═══
    else if (message.type === "pageLoaded") {
      const url = message.url || '';

      // Skip ad domains
      if (isAdDomain(url)) {
        console.log("[auto-snapshot] ❌ Skipping ad domain:", url);
        sendResponse({ status: "skipped_ad" });
        return;
      }

      if (isPopupOrRedirect(url)) {
        console.log("[auto-snapshot] ❌ Skipping popup/redirect:", url);
        sendResponse({ status: "skipped_popup" });
        return;
      }

      if (isMediaUrl(url)) {
        console.log("[auto-snapshot] ❌ Skipping media URL:", url);
        sendResponse({ status: "skipped_media" });
        return;
      }

      if (url && !isContentDomain(url) && !isAdDomain(url)) {
        const lower = url.toLowerCase();
        if (lower.includes('casino') || lower.includes('gambling') || lower.includes('slot') ||
            lower.includes('bet') || lower.includes('poker') || lower.includes('bingo') ||
            lower.includes('bonus') || lower.includes('deposit') || lower.includes('withdrawal')) {
          console.log("[auto-snapshot] ❌ Skipping gambling/casino site:", url);
          sendResponse({ status: "skipped_gambling" });
          return;
        }
      }

      // [PATCH 119] this used to call setPrimaryDomainFromUrl() unconditionally on EVERY
      // pageLoaded event, in every tracked tab -- meaning any popup or redirect to an
      // unrelated domain (an ad, a download-prep interstitial, anything) would silently
      // hijack primaryDomain away from the site actually being investigated, after which
      // isSameSite() treated the unrelated domain as "in scope" and the real site as
      // "out of scope". Only filling it in when it is not already set keeps it sticky to
      // wherever recording actually started, while still covering the legitimate case of
      // starting on a blank/new tab (no primaryDomain yet) and letting the first real
      // navigation set it.
      if (message.url && sender.tab && sender.frameId === 0 && !s.primaryDomain) {
        const wasSet = setPrimaryDomainFromUrl(message.url);
        if (wasSet) {
          console.log("[auto-snapshot] primaryDomain set to:", s.primaryDomain);
        } else {
          console.log("[auto-snapshot] No primaryDomain set, URL:", message.url);
        }
      }

      const isSame = isSameSite(message.url);
      const shouldSchedule = s.recording && s.autoSnapshot && sender.tab && sender.frameId === 0;

      console.log("[auto-snapshot] pageLoaded received:", {
        recording: s.recording,
        autoSnapshot: s.autoSnapshot,
        senderTab: !!sender.tab,
        frameId: sender.frameId,
        url: message.url,
        isSameSite: isSame,
        primaryDomain: s.primaryDomain,
        shouldSchedule: shouldSchedule,
        willSchedule: shouldSchedule && isSame
      });

      if (shouldSchedule && isSame) {
        const tabId = sender.tab.id;
        console.log("[auto-snapshot] ✅ scheduling from pageLoaded:", message.url);
        scheduleAutoSnapshot(tabId);

        // [NEW] content.js flags pages that look ad-gated/delayed-reveal (an ad-block-check
        // script hiding real content behind an overlay until it passes). The normal
        // scheduleAutoSnapshot() call above still fires at its usual delay, which may well be
        // too early for such a page -- rather than guessing a longer fixed delay for this one
        // call too, take a SECOND snapshot later, once the gate should have cleared. This goes
        // straight to captureSnapshot() on a plain setTimeout rather than through
        // scheduleAutoSnapshot() again: that function keeps only one pending timer per tab, so
        // calling it a second time for the same tab would just cancel and replace the first,
        // normal-delay capture instead of taking a genuine second one.
        if (message.contentGated) {
          console.log("[auto-snapshot] 🔒 content-gating detected, scheduling a delayed re-capture in 4s:", message.url);
          setTimeout(() => {
            captureSnapshot(null, tabId);
          }, 4000);
        }
      } else {
        console.log("[auto-snapshot] ❌ NOT scheduling from pageLoaded. shouldSchedule:", shouldSchedule, "isSameSite:", isSame, "recording:", s.recording, "autoSnapshot:", s.autoSnapshot, "hasTab:", !!sender.tab, "frameId:", sender.frameId);
      }

      if (s.recording && sender.tab && sender.frameId === 0) {
        const tabId = sender.tab.id;
        const url = message.url;
        if (tabId && url) {
          if (isYTSSite(url)) {
            setTimeout(() => autoExtractYTSTorrents(tabId, url), 1500);
          } else if (isArabicMovieSite(url)) {
            setTimeout(() => autoExtractArabicMovies(tabId, url), 1500);
          } else if (isSaveFilesSite(url)) {
            setTimeout(() => autoExtractSaveFiles(tabId, url), 1000);
          }
        }
      }
      sendResponse({ status: "ok" });
    }

    // ═══ EXTRACT YTS DATA ═══
    else if (message.type === "extractYTSData") {
      const tabId = message.tabId || (sender.tab ? sender.tab.id : null);
      if (tabId) {
        if (message.allPages) {
          extractAllYTSPages(tabId, message.maxPages || 10).then((data) => {
            chrome.runtime.sendMessage({
              type: 'ytsDataExtracted',
              data: data,
              tabId: tabId
            }).catch(() => {});
            sendResponse({ success: true, data: data });
          }).catch((e) => {
            console.error('YTS extraction error:', e);
            sendResponse({ success: false });
          });
        } else {
          extractYTSTorrents(tabId).then((data) => {
            if (data) {
              chrome.runtime.sendMessage({
                type: 'ytsDataExtracted',
                data: data,
                tabId: tabId
              }).catch(() => {});
              sendResponse({ success: true, data: data });
            } else {
              sendResponse({ success: false });
            }
          }).catch((e) => {
            console.error('YTS extraction error:', e);
            sendResponse({ success: false });
          });
        }
        return true;
      } else {
        sendResponse({ success: false });
      }
    }

    // ═══ EXTRACT ARABIC MOVIES ═══
    else if (message.type === "extractArabicMovies") {
      const tabId = message.tabId || (sender.tab ? sender.tab.id : null);
      if (tabId) {
        extractArabicMovieData(tabId).then((data) => {
          if (data) {
            chrome.runtime.sendMessage({
              type: 'arabicMoviesExtracted',
              data: data,
              tabId: tabId
            }).catch(() => {});
            sendResponse({ success: true, data: data });
          } else {
            sendResponse({ success: false });
          }
        }).catch((e) => {
          console.error('Arabic movie extraction error:', e);
          sendResponse({ success: false });
        });
        return true;
      } else {
        sendResponse({ success: false });
      }
    }

    // ═══ EXTRACT SAVEFILES ═══
    else if (message.type === "extractSaveFiles") {
      const tabId = message.tabId || (sender.tab ? sender.tab.id : null);
      if (tabId) {
        extractSaveFilesData(tabId).then((data) => {
          if (data && data.downloadUrl) {
            chrome.runtime.sendMessage({
              type: 'saveFilesExtracted',
              data: data,
              tabId: tabId
            }).catch(() => {});
            sendResponse({ success: true, data: data });
          } else {
            sendResponse({ success: false });
          }
        }).catch((e) => {
          console.error('SaveFiles extraction error:', e);
          sendResponse({ success: false });
        });
        return true;
      } else {
        sendResponse({ success: false });
      }
    }

    // ═══ SPA NAVIGATE ═══
    else if (message.type === "spa_navigate") {
      if (s.recording) {
        s.actions.push({
          timestamp: Date.now(),
          url: message.url,
          type: 'spa_navigate',
          selector: message.selector || 'SPA_detected',
          pageState: message.pageState || {}
        });

        s.userJourney.push({
          timestamp: Date.now(),
          action: 'spa_navigate',
          url: message.url,
          data: message.pageState || {}
        });

        const isSame = isSameSite(message.url);
        console.log("[auto-snapshot] spa_navigate received:", {
          url: message.url,
          tabId: sender.tab?.id,
          autoSnapshot: s.autoSnapshot,
          isSameSite: isSame,
          primaryDomain: s.primaryDomain,
          willSchedule: s.autoSnapshot && sender.tab && isSame
        });

        if (s.autoSnapshot && sender.tab) {
          const tabId = sender.tab.id;
          if (isSame) {
            console.log("[auto-snapshot] ✅ scheduling from spa_navigate:", message.url);
            scheduleAutoSnapshot(tabId, 800);
          } else {
            console.log("[auto-snapshot] ❌ spa_navigate skipped - not same site");
          }
        }
      }
      sendResponse({ status: "ok" });
    }

    // ═══ GET TORRENT LINKS ═══
    else if (message.type === "getTorrentLinks") {
      sendResponse({ data: getTorrentLinks() });
    }

    // ═══ GET TORRENT LINKS FILTERED ═══
    else if (message.type === "getTorrentLinksFiltered") {
      const all = getTorrentLinks();
      const filtered = message.hideTMDB ? all.filter(r => !/api\.themoviedb\.org/.test(r.apiEndpoint || '')) : all;
      sendResponse({ data: filtered });
    }

    // ═══ GET CONTENT PIPELINE ═══
    else if (message.type === "getContentPipeline") {
      sendResponse({ data: s.contentPipeline });
    }

    // ═══ BUILD MAGNET ═══
    else if (message.type === "buildMagnet") {
      const { infoHash, title, trackers } = message;
      const magnet = buildMagnetLink(infoHash, title, trackers);
      sendResponse({ magnet });
    }

    // ═══ GET YTS API VERSION ═══
    else if (message.type === "getYTSApiVersion") {
      const tabId = message.tabId || (sender.tab ? sender.tab.id : null);
      if (tabId) {
        chrome.scripting.executeScript({
          target: { tabId },
          func: () => 'v2'
        }).then((results) => {
          sendResponse({ version: results?.[0]?.result || 'v2' });
        }).catch(() => {
          sendResponse({ version: 'v2' });
        });
        return true;
      } else {
        sendResponse({ version: 'v2' });
      }
    }

    // ═══ GET SCREENSHOTS ═══
    else if (message.type === "getScreenshots") {
      // [FIX] same truncation bug as getRecordingData above, same fix -- a message type
      // literally named "getScreenshots" that never actually returned real screenshot data
      // was the more surprising half of this bug, if anything.
      sendResponse({ screenshots: s.screenshots });
    }

    // ═══ COPY AS PYTHON ═══
    else if (message.type === "copyAsPython") {
      const url = message.url || '';
      const snippet = '# Paste into your extractor:\n' +
        'url = "' + url + '"\n' +
        'data = fetch_json(url, referer="https://en.yts.lu/")\n' +
        '# Response contains torrent streams with infoHash, title, fileIdx\n' +
        'for s in (data or {}).get("streams", []):\n' +
        '    info_hash = s.get("infoHash", "")\n' +
        '    title = s.get("title", "Unknown")\n' +
        '    file_idx = s.get("fileIdx")\n' +
        '    magnet = self._build_magnet(info_hash, title, file_idx)\n';
      sendResponse({ snippet });
    }

    // ═══ AUTO SNAPSHOT TOGGLED ═══
    else if (message.type === "autoSnapshotToggled") {
      s.autoSnapshot = message.enabled;
      console.log("[auto-snapshot] Toggled to:", s.autoSnapshot);
      persistState();
      sendResponse({ status: "ok" });
    }

    // ═══ FEATURE 1: GENERATE PYTHON EXTRACTOR ═══
    else if (message.type === "generatePythonExtractor") {
      const siteName = message.siteName || 'CustomSite';
      const code = generatePythonExtractor(siteName, message.data);
      sendResponse({
        status: "ok",
        code: code,
        filename: `${siteName.toLowerCase().replace(/[^a-z0-9]/g, '_')}_extractor.py`
      });
    }

    // ═══ FEATURE 2: GENERATE RESOLVER ═══
    else if (message.type === "generateResolver") {
      const host = message.host;
      const code = generateResolverCode(host, message.data);
      sendResponse({
        status: "ok",
        code: code,
        filename: `resolve_${host.replace(/[^a-zA-Z0-9]/g, '_')}.py`
      });
    }

    // ═══ FEATURE 3: GENERATE COMPLETE EXTRACTOR ═══
    else if (message.type === "generateCompleteExtractor") {
      const siteName = message.siteName || 'CustomSite';
      const result = generateCompleteExtractor(siteName, message.data);
      sendResponse({
        status: "ok",
        ...result
      });
    }

    // ═══ FEATURE 4: DISCOVER API ENDPOINTS ═══
    else if (message.type === "discoverAPIEndpoints") {
      const endpoints = discoverAPIEndpoints();
      sendResponse({
        status: "ok",
        endpoints: endpoints
      });
    }

    // ═══ FEATURE 5: DISCOVER STREAM RESOLVERS ═══
    else if (message.type === "discoverStreamResolvers") {
      const resolvers = discoverStreamResolvers();
      sendResponse({
        status: "ok",
        resolvers: resolvers
      });
    }

    // ═══ FEATURE 6: DISCOVER SITE STRUCTURE ═══
    else if (message.type === "discoverSiteStructure") {
      const structure = discoverSiteStructure();
      sendResponse({
        status: "ok",
        structure: structure
      });
    }

    // ═══ FEATURE 7: FIND REQUEST CHANGES ═══
    else if (message.type === "findRequestChanges") {
      const diffs = findRequestChanges();
      const report = generateDiffReport();
      sendResponse({
        status: "ok",
        diffs: diffs,
        report: report
      });
    }

    // ═══ FEATURE 8: ANALYZE MAGNET LINKS ═══
    else if (message.type === "analyzeMagnetLinks") {
      const magnets = analyzeMagnetLinks();
      sendResponse({
        status: "ok",
        magnets: magnets
      });
    }

    // ═══ FEATURE 9: GENERATE TORRENT METADATA ═══
    else if (message.type === "generateTorrentMetadata") {
      const { magnetLink } = message;
      const metadata = generateTorrentMetadata(magnetLink);
      sendResponse({
        status: "ok",
        metadata: metadata
      });
    }

    // ═══ FEATURE 10: MAP SPA ROUTES ═══
    else if (message.type === "mapSPARoutes") {
      const routes = mapSPARoutes();
      const structure = generateSPAStructure();
      sendResponse({
        status: "ok",
        routes: routes,
        structure: structure
      });
    }

    // ═══ FEATURE 11: SOLVE CHALLENGE ═══
    else if (message.type === "solveChallenge") {
      const { tabId, challengeType, url } = message;
      solveChallenge(tabId, challengeType, url).then((result) => {
        sendResponse({ status: "ok", result: result });
      });
      return true;
    }

    // ═══ FEATURE 12: WAIT FOR CHALLENGE SOLVED ═══
    else if (message.type === "waitForChallengeSolved") {
      const { tabId, timeout } = message;
      waitForChallengeSolved(tabId, timeout).then((result) => {
        sendResponse({ status: "ok", result: result });
      });
      return true;
    }

    // ═══ FEATURE 13: DISCOVER QUALITY VARIANTS ═══
    else if (message.type === "discoverQualityVariants") {
      const qualities = discoverQualityVariants();
      sendResponse({
        status: "ok",
        qualities: qualities
      });
    }

    // ═══ FEATURE 14: ANALYZE HLS PLAYLIST ═══
    else if (message.type === "analyzeHLSPlaylist") {
      const { url, content } = message;
      // [FIX] analyzeHLSPlaylist() always returns a Promise now (fixed earlier this session
      // so callers could rely on one consistent return type instead of sometimes-sync/
      // sometimes-async) -- this handler was never updated to match, so `analysis` held an
      // unresolved Promise object. Confirmed directly: sendResponse() serializes a Promise to
      // an empty object {} over the real message-passing channel, so the popup would have
      // received completely empty analysis/report/bestQuality data instead of anything real.
      // Made async, awaited, and added `return true` so the message channel stays open for
      // the async sendResponse -- the same pattern already used by every other async handler
      // in this file (manualSolve, extractYTSData, solveChallenge, etc.).
      (async () => {
        const analysis = await analyzeHLSPlaylist(url, content);
        const report = generateQualityReport(analysis);
        const bestQuality = findBestQuality(analysis);
        sendResponse({
          status: "ok",
          analysis: analysis,
          report: report,
          bestQuality: bestQuality
        });
      })();
      return true;
    }

    // ═══ FEATURE 15: GET HLS BEST QUALITY ═══
    else if (message.type === "getHLSBestQuality") {
      const { url, content } = message;
      // [FIX] same missing-await issue as Feature 14 above, same fix.
      (async () => {
        const analysis = await analyzeHLSPlaylist(url, content);
        const bestQuality = findBestQuality(analysis);
        sendResponse({
          status: "ok",
          bestQuality: bestQuality,
          analysis: analysis
        });
      })();
      return true;
    }

    // ═══ FEATURE 16: DISCOVER ALL ROUTES ═══
    else if (message.type === "discoverAllRoutes") {
      const routes = discoverAllRoutes();
      const report = generateRouteReport();
      sendResponse({ status: "ok", routes: routes, report: report });
    }

    // ═══ FEATURE 17: DISCOVER SELECTORS ═══
    else if (message.type === "discoverSelectors") {
      const selectors = discoverSelectors();
      const report = generateSelectorReport();
      sendResponse({ status: "ok", selectors: selectors, report: report });
    }

    // ═══ FEATURE 18: GENERATE SCHEMA ═══
    else if (message.type === "generateSchema") {
      const { sampleData } = message;
      const schema = generateSchema(sampleData);
      const report = generateSchemaReport();
      sendResponse({ status: "ok", schema: schema, report: report });
    }

    // ═══ FEATURE 19: VISUALIZE HLS PLAYLIST ═══
    else if (message.type === "visualizeHLSPlaylist") {
      const { url, content } = message;
      // [FIX] visualizeHLSPlaylist() now always returns a Promise (fixed alongside adding
      // its missing fetch-from-URL fallback -- see m3u8-visualizer.js). Same missing-await
      // class of bug as Features 14/15/25 above, same fix: made async, awaited, return true
      // to keep the message channel open for the async sendResponse.
      (async () => {
        const analysis = await visualizeHLSPlaylist(url, content);
        const report = generateVisualizationReport(analysis);
        sendResponse({ status: "ok", analysis: analysis, report: report });
      })();
      return true;
    }

    // ═══ FEATURE 20: DEOBFUSCATE JAVASCRIPT ═══
    else if (message.type === "deobfuscateJavaScript") {
      const { code } = message;
      const result = deobfuscateJavaScript(code);
      const report = generateDeobfuscationReport(code);
      sendResponse({ status: "ok", result: result, report: report });
    }

    // ═══ FEATURE 21: ANALYZE COOKIES ═══
    else if (message.type === "analyzeCookies") {
      const analysis = analyzeCookies();
      const report = generateCookieReport();
      sendResponse({ status: "ok", analysis: analysis, report: report });
    }

    // ═══ FEATURE 22: RECORD REQUEST SEQUENCE ═══
    else if (message.type === "recordRequestSequence") {
      const sequence = recordRequestSequence();
      const report = generateSequenceReport();
      sendResponse({ status: "ok", sequence: sequence, report: report });
    }

    // ═══ FEATURE 23: COMPARE SITES ═══
    else if (message.type === "compareSites") {
      const { site1Data, site2Data } = message;
      const report = generateComparisonReport(site1Data, site2Data);
      sendResponse({ status: "ok", report: report });
    }

    // ═══ FEATURE 24: GENERATE REGEX PATTERNS ═══
    else if (message.type === "generateRegexPatterns") {
      const patterns = generateRegexPatterns();
      const report = generateRegexReport();
      sendResponse({ status: "ok", patterns: patterns, report: report });
    }

    // ═══ FEATURE 25: TRACK SITE VERSION ═══
    else if (message.type === "trackSiteVersion") {
      // [FIX] trackSiteVersion()/generateVersionReport() were made async earlier this session
      // (they need chrome.tabs.query()/chrome.storage.local, which do not exist synchronously
      // -- see version-tracker.js) -- this handler was never updated to match, so `tracking`
      // held an unresolved Promise (same class of break as Feature 14/15 above, confirmed the
      // same way: it serializes to {} over sendResponse). Separately, generateVersionReport()
      // already calls trackSiteVersion() internally to build its report text -- calling it
      // AGAIN directly here meant every single "Track Version" click appended TWO entries to
      // the persisted version history instead of one, corrupting the history's own
      // change-detection (each check would compare against the entry the SAME click had just
      // created, not the last genuinely separate check). popup.js's "trackVersion" handler
      // only ever reads response.report, never response.tracking, so calling
      // generateVersionReport() alone (awaited) is both the async fix and the double-append
      // fix in one: it performs the one, correct trackSiteVersion() call internally.
      (async () => {
        const report = await generateVersionReport();
        sendResponse({ status: "ok", report: report });
      })();
      return true;
    }

    // ═══ FEATURE 26: GENERATE TESTS ═══
    else if (message.type === "generateTests") {
      const { siteName, data } = message;
      const code = generateTests(siteName, data);
      const report = generateTestReport();
      sendResponse({ status: "ok", code: code, report: report, filename: `test_${siteName.toLowerCase().replace(/[^a-z0-9]/g, '_')}.py` });
    }

    else {
      sendResponse({ status: "unknown" });
    }
    return true;
  });
}

// ═══ AUTO EXTRACTION FUNCTIONS ═══
async function autoExtractYTSTorrents(tabId, url) {
  if (!state.recording) return;
  if (!isYTSSite(url)) return;
  console.log("[YTS] Auto-extracting data for", url);
  try {
    const data = await extractYTSTorrents(tabId);
    if (data && data.length > 0) {
      console.log("[YTS] Auto-extracted", data.length, "items");
      chrome.runtime.sendMessage({
        type: 'ytsDataExtracted',
        data: data,
        tabId: tabId
      }).catch(() => {});
    }
  } catch (e) {
    console.warn("[YTS] Auto-extraction failed:", e);
  }
}

async function autoExtractArabicMovies(tabId, url) {
  if (!state.recording) return;
  if (!isArabicMovieSite(url)) return;
  console.log("[Arabic] Auto-extracting movies for", url);
  try {
    const data = await extractArabicMovieData(tabId);
    if (data && data.length > 0) {
      console.log("[Arabic] Auto-extracted", data.length, "movies");
      chrome.runtime.sendMessage({
        type: 'arabicMoviesExtracted',
        data: data,
        tabId: tabId
      }).catch(() => {});
    }
  } catch (e) {
    console.warn("[Arabic] Auto-extraction failed:", e);
  }
}

async function autoExtractSaveFiles(tabId, url) {
  if (!state.recording) return;
  if (!isSaveFilesSite(url)) return;
  console.log("[SaveFiles] Auto-extracting download for", url);
  try {
    const data = await extractSaveFilesData(tabId);
    if (data && data.downloadUrl) {
      console.log("[SaveFiles] Auto-extracted download:", data.filename);
      chrome.runtime.sendMessage({
        type: 'saveFilesExtracted',
        data: data,
        tabId: tabId
      }).catch(() => {});
    }
  } catch (e) {
    console.warn("[SaveFiles] Auto-extraction failed:", e);
  }
}

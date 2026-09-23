// message-handlers.js - All chrome.runtime.onMessage handlers
import { state, scheduleSave, persistState, cleanupMemory, broadcastRecordingState, registrableDomain, isSameSite, setPrimaryDomainFromUrl } from './state.js';
import { CONFIG } from './config.js';
import { handleCloudflareChallenge, solveManually, CHALLENGE_SOLVING } from './challenge-solver.js';
import { 
  isYTSSite, isArabicMovieSite, isSaveFilesSite, 
  extractYTSTorrents, extractArabicMovieData, extractSaveFilesData, 
  extractAllYTSPages, buildMagnetLink, isSuspectedBackend,
  isAdDomain, isPopupOrRedirect, isContentDomain, isMediaUrl
} from './site-detection.js';
import { captureScreenshot, captureSnapshot, scheduleAutoSnapshot, pendingAutoSnapshotTimers, expectingSnapshotFilename } from './screenshot.js';
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
      s.userJourney = [];
      s.screenshots = [];
      s.contentPipeline = { source: '', movieList: [], downloadLinks: [], metadata: {}, sequence: [] };
      s.recordTabId = message.tabId || null;
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
          userJourney: s.userJourney, 
          contentPipeline: s.contentPipeline,
          screenshots: s.screenshots.map(s => ({ ...s, dataUrl: s.dataUrl?.substring(0, 100) + '...' }))
        } 
      });
      return true;
    }
    
    // ═══ EXPORT ═══
    else if (message.type === "export") {
      const data = { filterMode: s.filterMode, actions: s.actions, networkLog: s.networkLog, xhrBodies: s.xhrBodies, userJourney: s.userJourney, contentPipeline: s.contentPipeline };
      const format = message.format || 'json';
      let content, filename, mimeType;
      
      switch (format) {
        case 'csv':
          content = exportAsCSV(data);
          filename = 'stream_recording.csv';
          mimeType = 'text/csv';
          break;
        case 'har':
          content = JSON.stringify(exportAsHAR(data), null, 2);
          filename = 'stream_recording.har';
          mimeType = 'application/json';
          break;
        case 'markdown':
          content = exportAsMarkdown(data);
          filename = 'stream_recording.md';
          mimeType = 'text/markdown';
          break;
        default:
          content = JSON.stringify(data, null, 2);
          filename = 'stream_recording.json';
          mimeType = 'application/json';
      }
      
      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      chrome.downloads.download({ url, filename, saveAs: true }, () => URL.revokeObjectURL(url));
      sendResponse({ status: "exporting", format });
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
      const urlPattern = /\.(m3u8|mp4|ts)(\?|$)|\/hls\d?\/|master\.txt/i;
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

      const bodyUrlPattern = /https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mp4|ts)(?:\?[^\s"'<>\\]*)?/gi;
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
      sendResponse({ screenshots: s.screenshots.map(s => ({ ...s, dataUrl: s.dataUrl?.substring(0, 100) + '...' })) });
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
      const analysis = analyzeHLSPlaylist(url, content);
      const report = generateQualityReport(analysis);
      const bestQuality = findBestQuality(analysis);
      sendResponse({ 
        status: "ok", 
        analysis: analysis,
        report: report,
        bestQuality: bestQuality
      });
    }

    // ═══ FEATURE 15: GET HLS BEST QUALITY ═══
    else if (message.type === "getHLSBestQuality") {
      const { url, content } = message;
      const analysis = analyzeHLSPlaylist(url, content);
      const bestQuality = findBestQuality(analysis);
      sendResponse({ 
        status: "ok", 
        bestQuality: bestQuality,
        analysis: analysis
      });
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
      const analysis = visualizeHLSPlaylist(url, content);
      const report = generateVisualizationReport(analysis);
      sendResponse({ status: "ok", analysis: analysis, report: report });
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
      const tracking = trackSiteVersion();
      const report = generateVersionReport();
      sendResponse({ status: "ok", tracking: tracking, report: report });
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

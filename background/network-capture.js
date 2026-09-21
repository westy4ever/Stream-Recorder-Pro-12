// network-capture.js - WebRequest listeners
import { state, shouldRecordUrl, shouldRecordTab, passesFilter, safeBodyToString, headersToObject, scheduleSave } from './state.js';
import { CONFIG, YTS_API_PATTERNS, ARABIC_API_PATTERNS, CLOUDFLARE_CHALLENGE_HEADERS, CLOUDFLARE_CHALLENGE_STATUSES } from './config.js';
import { isSuspectedBackend, isDownloadUrl } from './site-detection.js';
import { handleCloudflareChallenge } from './challenge-solver.js';

export function initNetworkCapture() {
  // ═══ onBeforeRequest ═══
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      const s = state;
      if (!s.recording) return;
      if (!passesFilter(details.type)) return;
      if (!shouldRecordUrl(details.url)) return;
      if (!shouldRecordTab(details.tabId)) return;

      const isYTSApi = YTS_API_PATTERNS.some(pattern => pattern.test(details.url));
      const isArabicApi = ARABIC_API_PATTERNS.some(pattern => pattern.test(details.url));
      const isBackend = isSuspectedBackend(details.url);
      const isDownload = isDownloadUrl(details.url);

      s.pending[details.requestId] = {
        requestId: details.requestId,
        timestamp: Date.now(),
        url: details.url,
        method: details.method,
        type: details.type,
        tabId: details.tabId,
        frameId: details.frameId,
        initiator: details.initiator || null,
        requestBody: safeBodyToString(details.requestBody),
        requestHeaders: null,
        statusCode: null,
        responseHeaders: null,
        fromCache: null,
        error: null,
        blockedByExtension: false,
        isYTSApi: isYTSApi,
        isArabicApi: isArabicApi,
        isSuspectedBackend: isBackend,
        isDownload: isDownload,
        apiType: isYTSApi
          ? (details.url.includes('torrentio') ? 'torrentio'
            : details.url.includes('themoviedb') ? 'tmdb_noise'
            : details.url.includes('list_movies') ? 'list'
            : details.url.includes('movie_details') ? 'details'
            : 'unknown')
          : (isArabicApi ? 'arabic_movie'
            : isBackend ? 'suspected_backend'
            : isDownload ? 'download'
            : null)
      };
      scheduleSave();
    },
    { urls: ["<all_urls>"] },
    ["requestBody"]
  );

  // ═══ onSendHeaders ═══
  chrome.webRequest.onSendHeaders.addListener(
    (details) => {
      const s = state;
      if (!s.recording) return;
      const entry = s.pending[details.requestId];
      if (entry) entry.requestHeaders = headersToObject(details.requestHeaders);
    },
    { urls: ["<all_urls>"] },
    ["requestHeaders", "extraHeaders"]
  );

  // ═══ onHeadersReceived ═══
  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      const s = state;
      if (!s.recording) return;
      const entry = s.pending[details.requestId];
      if (entry) {
        entry.statusCode = details.statusCode;
        entry.responseHeaders = headersToObject(details.responseHeaders);
      }

      let isChallenge = false;
      let cfRay = null, cfChallenge = null;
      if (details.responseHeaders) {
        for (const h of details.responseHeaders) {
          const name = h.name.toLowerCase();
          if (CLOUDFLARE_CHALLENGE_HEADERS.includes(name)) {
            isChallenge = true;
            if (name === 'cf-challenge') cfChallenge = h.value;
          }
          if (name === 'cf-ray') cfRay = h.value;
        }
      }
      if (!isChallenge && cfRay && CLOUDFLARE_CHALLENGE_STATUSES.includes(details.statusCode)) {
        isChallenge = true;
      }
      if (isChallenge && details.tabId > 0 && !s.challengeSolving[details.tabId]) {
        if (s.recording) {
          s.actions.push({
            timestamp: Date.now(),
            url: details.url,
            type: 'challenge_detected',
            statusCode: details.statusCode,
            cfRay,
            cfChallenge,
            challengeHeaders: details.responseHeaders?.filter(h =>
              CLOUDFLARE_CHALLENGE_HEADERS.includes(h.name.toLowerCase())
            ).map(h => ({ name: h.name, value: h.value }))
          });
        }
        handleCloudflareChallenge(details.tabId, details.url);
      }
    },
    { urls: ["<all_urls>"] },
    ["responseHeaders", "extraHeaders"]
  );

  // ═══ onBeforeRedirect ═══
  chrome.webRequest.onBeforeRedirect.addListener(
    (details) => {
      const s = state;
      if (!s.recording) return;
      const entry = s.pending[details.requestId];
      if (entry) {
        if (!entry.redirectChain) entry.redirectChain = [entry.url];
        entry.redirectChain.push(details.redirectUrl);
        entry.finalUrl = details.redirectUrl;
        scheduleSave();
      }
    },
    { urls: ["<all_urls>"] },
    ["responseHeaders"]
  );

  // ═══ onCompleted ═══
  chrome.webRequest.onCompleted.addListener(
    (details) => {
      const s = state;
      if (!s.recording) return;
      const entry = s.pending[details.requestId];
      if (entry) {
        entry.statusCode = details.statusCode;
        entry.fromCache = details.fromCache;
        if (!entry.responseHeaders && details.responseHeaders) {
          entry.responseHeaders = headersToObject(details.responseHeaders);
        }
        if (entry.redirectChain) {
          entry.finalUrl = entry.redirectChain[entry.redirectChain.length - 1];
        }
        s.networkLog.push(entry);
        delete s.pending[details.requestId];
        scheduleSave();
      }
    },
    { urls: ["<all_urls>"] },
    ["responseHeaders"]
  );

  // ═══ onErrorOccurred ═══
  chrome.webRequest.onErrorOccurred.addListener(
    (details) => {
      const s = state;
      if (!s.recording) return;
      const entry = s.pending[details.requestId];
      if (entry) {
        entry.error = details.error;
        entry.blockedByExtension = details.error === "net::ERR_BLOCKED_BY_CLIENT";
        s.networkLog.push(entry);
        delete s.pending[details.requestId];
        scheduleSave();
      }
    },
    { urls: ["<all_urls>"] }
  );
}
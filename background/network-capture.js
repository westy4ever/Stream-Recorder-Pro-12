// network-capture.js - WebRequest listeners
import { state, shouldRecordUrl, shouldRecordTab, passesFilter, safeBodyToString, headersToObject, scheduleSave, stateReadyPromise } from './state.js';
import { CONFIG, YTS_API_PATTERNS, ARABIC_API_PATTERNS, CLOUDFLARE_CHALLENGE_HEADERS, CLOUDFLARE_CHALLENGE_STATUSES } from './config.js';
import { isSuspectedBackend, isDownloadUrl } from './site-detection.js';
import { handleCloudflareChallenge } from './challenge-solver.js';

export function initNetworkCapture() {
  // ═══ onBeforeRequest ═══
  chrome.webRequest.onBeforeRequest.addListener(
    async (details) => {
      // [FIX] this is the gatekeeper: every other listener below only acts on
      // a requestId that THIS one already put in s.pending. A service-worker
      // restart (routine under MV3 after ~30s idle, and the very event that
      // wakes a fresh worker back up is often one of these webRequest events
      // itself) resets `state` to its hardcoded defaults until
      // stateReadyPromise's chrome.storage.local.get() resolves -- reading
      // s.recording before that lands silently drops the request forever,
      // with no error, which is exactly what two separate real recordings
      // this session showed (rich multi-minute action logs, completely
      // empty networkLog/xhrBodies the whole time). Awaiting here first
      // costs nothing once the promise has already settled (the overwhelming
      // majority of calls, after the first) and guarantees correctness for
      // the ones that matter.
      await stateReadyPromise;
      const s = state;
      // [DIAG-temp] Logs every single webRequest event onBeforeRequest actually sees, and which
      // gate (if any) rejected it, so we can tell apart "webRequest isn't firing for these
      // requests at all" from "it's firing but one of these three checks is dropping it" --
      // remove once the Network:0-on-iframe-embeds issue is root-caused.
      const diagTag = `[diag-webrequest] ${details.method} ${details.type} tab=${details.tabId} frame=${details.frameId} ${details.url}`;
      if (!s.recording) { console.log(diagTag, "-> DROPPED: not recording"); return; }
      if (!passesFilter(details.type)) { console.log(diagTag, "-> DROPPED: filterMode", s.filterMode); return; }
      if (!shouldRecordUrl(details.url)) { console.log(diagTag, "-> DROPPED: shouldRecordUrl (allowed/blockedDomains)", s.allowedDomains, s.blockedDomains); return; }
      if (!shouldRecordTab(details.tabId)) { console.log(diagTag, "-> DROPPED: shouldRecordTab recordTabId=", s.recordTabId, "recordedTabIds=", s.recordedTabIds); return; }
      console.log(diagTag, "-> CAPTURED");

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
    async (details) => {
      await stateReadyPromise;
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
    async (details) => {
      await stateReadyPromise;
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
    async (details) => {
      await stateReadyPromise;
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
    async (details) => {
      await stateReadyPromise;
      const s = state;
      const entry = s.pending[details.requestId];
      if (!entry) return;
      // [FIX] this cleanup (removing the tracking entry from s.pending) used to be gated
      // behind the SAME `if (!s.recording) return;` guard as the actual recording logic below
      // it -- but those are two different concerns. If recording stops at any point between a
      // request STARTING (onBeforeRequest, which only creates an entry while s.recording is
      // true) and this request FINISHING, the entry was silently left behind forever: nothing
      // else ever cleans up s.pending (cleanupMemory() in state.js trims every other
      // collection except this one), and it persists across service-worker restarts too,
      // since restoreState() restores it from storage. Over many start/stop cycles this grows
      // without bound. Cleanup now always runs; only the actual recording of the completed
      // request still respects s.recording.
      delete s.pending[details.requestId];
      if (!s.recording) return;

      entry.statusCode = details.statusCode;
      entry.fromCache = details.fromCache;
      if (!entry.responseHeaders && details.responseHeaders) {
        entry.responseHeaders = headersToObject(details.responseHeaders);
      }
      if (entry.redirectChain) {
        entry.finalUrl = entry.redirectChain[entry.redirectChain.length - 1];
      }
      s.networkLog.push(entry);
      scheduleSave();
    },
    { urls: ["<all_urls>"] },
    ["responseHeaders"]
  );

  // ═══ onErrorOccurred ═══
  chrome.webRequest.onErrorOccurred.addListener(
    async (details) => {
      await stateReadyPromise;
      const s = state;
      const entry = s.pending[details.requestId];
      if (!entry) return;
      // [FIX] same leak, same fix as onCompleted above -- a request that errors out after
      // recording has already stopped must still have its s.pending entry cleaned up.
      delete s.pending[details.requestId];
      if (!s.recording) return;

      entry.error = details.error;
      entry.blockedByExtension = details.error === "net::ERR_BLOCKED_BY_CLIENT";
      s.networkLog.push(entry);
      scheduleSave();
    },
    { urls: ["<all_urls>"] }
  );
}

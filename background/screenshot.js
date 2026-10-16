// screenshot.js - Screenshot & snapshot capture

import { state, scheduleSave, slugifyUrlForFilename, timestampForFilename } from './state.js';
import { CONFIG } from './config.js';
import { isYTSSite, isArabicMovieSite } from './site-detection.js';

export let expectingSnapshotFilename = null;
export const pendingAutoSnapshotTimers = {};

// [FIX-bloburl2] confirmed directly on this user's actual browser (Brave): switching every
// export/extractor/test download from a blob: URL to a data: URL (see downloadBlob()'s own
// comment in popup.js) stopped the random-UUID names, but Brave STILL doesn't honor the
// `filename` field passed to chrome.downloads.download() for a data: URL unless something
// explicitly overrides it in onDeterminingFilename -- every one of those downloads came back
// named after its own MIME type instead ("download.json", "download.md", "download.pyw").
// The only download that was ever actually safe was the HTML snapshot, and only because its
// own onDeterminingFilename handling (below) explicitly re-suggests expectingSnapshotFilename
// instead of trusting Chrome/Brave's own downloadItem.filename. This map generalizes that same
// explicit-override trick to every OTHER download the extension makes: whoever calls
// chrome.downloads.download() records {downloadId: realFilename} here (keyed by the id handed
// back in download()'s own callback, so there's no race between several downloads in flight at
// once), and onDeterminingFilename checks it first, before any other logic, and clears the
// entry once used.
export const pendingDownloadFilenames = {};

// Track last snapshot time per tab to prevent duplicates
const lastSnapshotTime = {};
// [NEW] confirmed directly on a real capture: a user clicking through each
// of ~30 server buttons on the same watch page (the top-level URL never
// changes -- confirmed against the real userJourney log, every click
// stayed on the same /watch/ URL) produced a separate, genuinely new
// snapshot on every single click, since the existing cooldown above is
// purely time-based (2s default) and real clicks were 8-14+ seconds
// apart, comfortably clearing it every time. Tracking the URL a tab was
// last snapshotted at lets scheduleAutoSnapshot() skip a repeat capture
// of the identical URL, the same way the time-based cooldown already
// skips a too-soon repeat -- without affecting genuine navigation to a
// new page, which always produces a different URL.
const lastSnapshotUrl = {};
// [FIX] the strict "same URL as last capture -> skip" rule above also blocked the most
// important snapshot of all: a page loads (snapshot #1 at URL X), then the user clicks
// "Watch" / a server tab and the content is revealed IN PLACE (same URL X) -- that reveal was
// silently never captured. Same-URL repeats are now allowed up to a small cap per URL, which
// still stops the ~30-server-button spam the rule was added for.
const SNAPSHOT_MAX_PER_URL = 4;
const sameUrlSnapshotCount = {};
// last captured content per tab, so an auto-snapshot whose HTML is byte-identical to the
// previous one (a click that changed nothing) is not saved again
const lastSnapshotHash = {};

function _hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16) + ':' + str.length;
}

/**
 * [FIX] called when a recording starts. These maps are module-level, so they used to carry
 * over between recordings: re-recording a page snapshotted in an EARLIER session skipped its
 * first auto-snapshot as a "duplicate" (same bug class as script-capture's seen-URL set).
 */
export function resetSnapshotState() {
  for (const m of [lastSnapshotTime, lastSnapshotUrl, sameUrlSnapshotCount, lastSnapshotHash]) {
    for (const k of Object.keys(m)) delete m[k];
  }
}

// [NEW] snapshot frames are also stored in the recording (frameDocuments), so they come out
// in the JSON / Split export instead of only as separate .html downloads.
function _storeSnapshotFrames(frames, tabId, reason) {
  try {
    const s = state;
    if (!Array.isArray(s.frameDocuments)) s.frameDocuments = [];
    const cap = CONFIG.MAX_FRAME_DOC_CHARS || 2 * 1024 * 1024;
    for (const r of frames) {
      const html = r.result.html;
      const url = r.result.url;
      if (!url || s.frameDocuments.some(d => d.url === url && d.size === html.length)) continue;
      s.frameDocuments.push({
        timestamp: Date.now(),
        tabId,
        frameId: r.frameId,
        url,
        isTop: r.frameId === 0,
        reason,
        size: html.length,
        truncated: html.length > cap,
        html: html.length > cap ? html.slice(0, cap) : html
      });
      if (s.frameDocuments.length > (CONFIG.MAX_FRAME_DOCS || 40)) s.frameDocuments.shift();
    }
    scheduleSave();
  } catch (e) {
    console.warn("[auto-snapshot] could not store frames in recording:", e && e.message);
  }
}

// ═══ SCREENSHOT CAPTURE ═══
export function captureScreenshot(tabId, callback) {
  if (!tabId) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0]) {
        doCapture(tabs[0].id, callback);
      } else if (callback) callback(null);
    });
  } else {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        console.warn('[screenshot] Tab no longer exists, skipping screenshot:', tabId);
        if (callback) callback(null);
        return;
      }
      doCapture(tabId, callback);
    });
  }
}

function doCapture(tabId, callback) {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) {
      console.warn('[screenshot] Tab disappeared before capture:', tabId);
      if (callback) callback(null);
      return;
    }

    chrome.tabs.captureVisibleTab(tabId, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        console.warn('Screenshot failed:', chrome.runtime.lastError.message);
        if (callback) callback(null);
        return;
      }

      const screenshot = {
        timestamp: Date.now(),
        dataUrl: dataUrl,
        tabId: tabId
      };

      const s = state;
      s.screenshots.push(screenshot);
      if (s.screenshots.length > CONFIG.MAX_SCREENSHOTS) {
        s.screenshots = s.screenshots.slice(-CONFIG.MAX_SCREENSHOTS);
      }

      if (s.recording) {
        s.actions.push({
          timestamp: Date.now(),
          type: 'screenshot_captured',
          tabId: tabId
        });
        scheduleSave();
      }

      if (callback) callback(screenshot);
    });
  });
}

// ═══ Generate better filename from page title and URL ═══
function generateSnapshotFilename(pageUrl, pageTitle, timestamp) {
  try {
    const url = new URL(pageUrl);
    let name = '';

    // Try to use page title first (cleaned)
    if (pageTitle && pageTitle.length > 0) {
      let cleanTitle = pageTitle
        // [FIX] this list only covered a handful of the sites this tool actually targets --
        // extended with the other real sites seen across this project (Shahid4u/Shaheed4u,
        // Akwam, Aflaam, AlooyTV, TopCinema, FaselHD, ArabSeed, OnlyFlix, MegaMax, Cima4u,
        // Cimalek). Also widened the separator character class from [|:] to [|:-], since
        // "Title - SiteName" (hyphen-separated) is an extremely common real title pattern --
        // confirmed directly the original pattern never matched it at all. Verified this
        // doesn't damage a legitimate title that happens to contain its own internal hyphen
        // or colon (e.g. "Spider-Man: No Way Home"), since none of the listed words appear in
        // titles like that.
        .replace(/\s*[|:-]\s*(EgyDead|Wecima|MyCima|YTS|YIFY|Arabic|Movie|Series|TV|Online|Watch|Stream|HD|1080p|720p|480p|360p|Shahid4?u|Shaheed4?u|Akwam|Aflaam|AlooyTV|TopCinema|FaselHD|ArabSeed|OnlyFlix|MegaMax|Cima4u|Cimalek)\s*/gi, '')
        // [FIX] the site-name list above is Latin-only, but real EgyDead titles end with the
        // Arabic transliteration "ايجي ديد" (confirmed on every real page title
        // captured this session), which never matched -- leaving that noise in every filename
        // and eating into the character budget that should go to the actual page name.
        .replace(/\s*[|:]\s*\u0627\u064a\u062c\u064a\s*\u062f\u064a\u062f\s*/g, '')
        .replace(/[^a-zA-Z0-9\u0600-\u06ff\s-]/g, '')
        .trim();

      // [FIX] confirmed directly on a real page: akwams.org's watch pages
      // never set a movie-specific <title> at all -- only the site's own
      // generic Arabic branding ("اكوام - Akwam | مشاهدة افلام و مسلسلات
      // اون لاين" -- "Akwam, Watch Movies and Series Online"). The site-
      // name strip above is Latin-only (plus one specific EgyDead
      // exception), so none of the generic ARABIC noise words in that
      // branding string ever matched, leaving the whole thing intact,
      // long enough to pass the length check below, and accepted as a
      // real title -- every snapshot from that watch page used the same
      // misleading, generic filename despite being genuinely different
      // captures. Note: JS regex \b does NOT work correctly for Arabic
      // script (word-boundary is defined against the ASCII \w class,
      // which excludes Arabic letters) -- confirmed directly that a \b
      // version of this pattern silently matched nothing at all. Using
      // explicit space/start/end boundaries instead, which are confirmed
      // to work correctly for Arabic text.
      cleanTitle = cleanTitle
        .replace(/(^|\s)(مشاهدة|تحميل|فيلم|افلام|مسلسل|مسلسلات|الحلقة|حلقة|مترجم|مترجمة|مدبلج|مدبلجة|اون\s*لاين|أون\s*لاين|اونلاين|بجودة|عالية|كامل|حصريا|اكوام|و)(?=\s|$)/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (cleanTitle.length > 50) {
        cleanTitle = cleanTitle.substring(0, 50).trim();
      }

      if (cleanTitle.length > 2 && !/^\d+$/.test(cleanTitle)) {
        name = cleanTitle;
      }
    }

    // If no title, use path
    if (!name || name.length < 2) {
      let path = url.pathname;
      if (path === '/' || path === '') {
        name = 'home';
      } else {
        const parts = path.split('/').filter(p => p && p.length > 0);
        // [FIX] confirmed directly: the real fallback URL here ends in
        // "/watch/" (".../drawn-together-2026-مترجم/watch/"), and this
        // always took the LAST segment -- "watch" -- not the actual
        // movie slug before it. Since every watch page on this site ends
        // the same way, every different movie's watch page would have
        // collapsed to the same generic "watch" filename, barely better
        // than the generic-title problem this fallback exists to solve.
        // The same generic terminal segment shows up across other sites
        // in this project too (view/play/embed/download). Walking
        // backwards and skipping these finds the real, descriptive slug
        // instead.
        const GENERIC_TERMINAL_SEGMENTS = new Set(['watch', 'view', 'play', 'embed', 'download', 'stream']);
        let lastPart = parts[parts.length - 1] || parts[0] || 'page';
        for (let i = parts.length - 1; i >= 0; i--) {
          if (!GENERIC_TERMINAL_SEGMENTS.has(parts[i].toLowerCase())) {
            lastPart = parts[i];
            break;
          }
        }
        try {
          name = decodeURIComponent(lastPart);
        } catch (e) {
          name = lastPart;
        }
        name = name.replace(/\.[^.]+$/, '');
        name = name.replace(/[-_]/g, ' ');
        if (name.length > 40) {
          name = name.substring(0, 40);
        }
      }
    }

    name = name
      .replace(/[\\/:*?"<>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!name || name.length < 1) {
      name = 'page';
    }

    // [NEW] snapshot filenames gave no indication of which pagination page
    // a capture came from -- every page of the same category listing
    // (e.g. "Action Movies" page 1, 2, 3...) produced an identical-looking
    // name apart from the timestamp, making it hard to tell them apart
    // later. Checks the real page=N query param -- verified against the
    // normal case, MyCima's own "?&page=N" quirk (empty first param,
    // confirmed real), and pages with no pagination at all (correctly
    // adds nothing).
    // [FIX] confirmed directly: the query-string check above never
    // matches WordPress-style path pagination, which real captures from
    // cimawebas.com (and likely other WordPress-based sites in this
    // project) actually use -- e.g. ".../category/.../page/2/", with the
    // page number in the URL PATH, not a query parameter. url.search was
    // empty for every one of these real URLs, so no page suffix was ever
    // added despite the page clearly being page 2, 3, etc. Now also
    // checks the path for a "/page/N/" segment; the query-string check
    // still runs first so the existing MyCima/normal cases are unaffected.
    let pageSuffix = '';
    try {
      const queryMatch = url.search.match(/[?&]page=(\d+)/i);
      const pathMatch = url.pathname.match(/\/page\/(\d+)\/?(?:$|\/)/i);
      const pageNum = queryMatch ? queryMatch[1] : (pathMatch ? pathMatch[1] : null);
      if (pageNum) {
        pageSuffix = `_page${pageNum}`;
      }
    } catch (e) { /* ignore */ }

    const timestampStr = timestamp || timestampForFilename();
    const finalName = name.replace(/\s+/g, '-').substring(0, 60);
    return `snapshot_${finalName}${pageSuffix}_${timestampStr}.html`;
  } catch (e) {
    const slug = slugifyUrlForFilename(pageUrl);
    const timestampStr = timestamp || timestampForFilename();
    return `snapshot_${slug}_${timestampStr}.html`;
  }
}

// ═══ SNAPSHOT CAPTURE ═══
export function scheduleAutoSnapshot(tabId, delay = 1200, bypassCooldown = false) {
  console.log("[auto-snapshot] scheduleAutoSnapshot called for tab", tabId, "delay", delay, "bypassCooldown", bypassCooldown);

  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) {
      console.warn("[auto-snapshot] tab not available:", chrome.runtime.lastError?.message);
      return;
    }

    console.log("[auto-snapshot] tab info:", tab.id, tab.url);

    if (delay === undefined || delay === null) delay = 1200;

    if (isYTSSite(tab.url) || isArabicMovieSite(tab.url)) {
      delay = 800;
    } else if (/\/media-issue\/download\//.test(tab.url)) {
      // [FIX] this gateway page runs an async ad-block check (an IP fetch to api.ipify.org,
      // then an adblock-signature fetch) before revealing its real download link -- confirmed
      // directly against a real captured page, where the plain 1200ms default fired before
      // that check finished, capturing the page mid-gate with no real content visible yet.
      delay = 3000;
    }

    const now = Date.now();
    const lastTime = lastSnapshotTime[tabId] || 0;
    const minInterval = CONFIG.SNAPSHOT_COOLDOWN_MS || 2000;

    // [FIX] a form-submit reveal (bypassCooldown=true) is explicit and low-frequency; it must
    // never be silently swallowed by the generic per-tab cooldown, which exists to stop noisy
    // click/mutation spam, not to gate a deliberate user action.
    if (!bypassCooldown && now - lastTime < minInterval) {
      console.log("[auto-snapshot] ⏱️ Skipping duplicate snapshot - too soon (", now - lastTime, "ms since last)");
      return;
    }

    if (!bypassCooldown && lastSnapshotUrl[tabId] && lastSnapshotUrl[tabId] === tab.url &&
        (sameUrlSnapshotCount[tabId] || 0) >= SNAPSHOT_MAX_PER_URL) {
      console.log("[auto-snapshot] 🔁 Skipping snapshot - already", SNAPSHOT_MAX_PER_URL, "captures of this URL:", tab.url);
      return;
    }

    if (pendingAutoSnapshotTimers[tabId]) {
      console.log("[auto-snapshot] clearing existing timer for tab", tabId);
      clearTimeout(pendingAutoSnapshotTimers[tabId]);
    }

    pendingAutoSnapshotTimers[tabId] = setTimeout(() => {
      delete pendingAutoSnapshotTimers[tabId];
      console.log("[auto-snapshot] debounce elapsed, capturing tab", tabId);
      captureSnapshot(null, tabId);
    }, delay);
  });
}

export function captureSnapshot(callback, specificTabId) {
  console.log("[auto-snapshot] captureSnapshot called, specificTabId:", specificTabId);

  function proceed(targetTab) {
    if (!targetTab) {
      console.warn("No suitable tab found for snapshot (no http/https tab).");
      if (callback) callback(false);
      return;
    }

    // [FIX] lastSnapshotTime used to only get recorded deep inside the download-success
    // callback, AFTER two separate async chrome.scripting.executeScript round-trips (title,
    // then the full multi-frame HTML) had already completed -- a real window of hundreds of
    // milliseconds to over a second where a capture was genuinely in progress but the cooldown
    // check had no way to know that, since the timestamp it reads hadn't been updated yet. A
    // second scheduling call landing in that window would sail straight through the cooldown
    // and fire its own, separate capture of the same page -- a real duplicate snapshot, not
    // just a theoretical one. Recording the timestamp here, the moment a capture actually
    // starts, closes that window: anything arriving while this capture is still in flight now
    // correctly sees a fresh timestamp and gets cooldown-blocked, the way it was always meant to.
    lastSnapshotTime[targetTab.id] = Date.now();
    const isAuto = !!specificTabId && !callback;

    console.log("[auto-snapshot] capturing tab", targetTab.id, targetTab.url);

    // Get page title first
    // [FIX] document.title reflects whatever <title> element is FIRST in the document, per the
    // DOM spec -- but real sites sometimes have more than one <title> tag in <head> (a plugin
    // or widget injecting a generic one alongside the theme's real, page-specific one).
    // Confirmed directly: a real captured page had document.title returning the site's generic
    // homepage title while a second, later <title> tag in the SAME document correctly held the
    // actual page name ("... Greenland 2: Migration 2026 ...") -- meaning every snapshot from
    // that session used the same generic filename despite being genuinely different pages.
    // Scanning every <title> tag and preferring the longest one is a general fix, not specific
    // to this one site: a page-specific title is reliably longer than a generic branding-only
    // one, since it carries the branding suffix PLUS the actual content name.
    chrome.scripting.executeScript({
      target: { tabId: targetTab.id },
      func: () => {
        try {
          const titles = Array.from(document.querySelectorAll('title'))
            .map(t => (t.textContent || '').trim())
            .filter(t => t.length > 0);
          if (titles.length === 0) return document.title || '';
          return titles.reduce((best, t) => (t.length > best.length ? t : best), titles[0]);
        } catch (e) {
          return document.title || '';
        }
      }
    }, (titleResults) => {
      const pageTitle = titleResults && titleResults[0] ? titleResults[0].result : '';

      // [FIX] a page can load a frame that never finishes loading in a way Chrome considers
      // "ready" (Google's reCAPTCHA iframe is a known real case -- confirmed present on a real
      // captured page this session), and chrome.scripting.executeScript with allFrames:true can
      // end up waiting on that one frame indefinitely before its callback ever fires, hanging
      // the whole snapshot with no feedback. settled/timeoutId guard against the multi-frame
      // call and the timeout fallback both firing: whichever happens first wins, and if the
      // slow call does eventually finish after the timeout already fired, its late result is
      // just ignored instead of double-processing or double-downloading.
      let settled = false;
      const FRAME_CAPTURE_TIMEOUT_MS = 8000;

      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        console.warn("[auto-snapshot] multi-frame capture timed out after", FRAME_CAPTURE_TIMEOUT_MS, "ms -- falling back to the main frame only");
        chrome.scripting.executeScript({
          target: { tabId: targetTab.id },
          func: () => ({ url: location.href, html: document.documentElement.outerHTML })
        }, (mainFrameResults) => {
          handleFrameResults(mainFrameResults, true);
        });
      }, FRAME_CAPTURE_TIMEOUT_MS);

      chrome.scripting.executeScript({
        target: { tabId: targetTab.id, allFrames: true },
        func: () => ({ url: location.href, html: document.documentElement.outerHTML })
      }, (results) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        handleFrameResults(results, false);
      });

      function handleFrameResults(results, isTimeoutFallback) {
        if (chrome.runtime.lastError) {
          console.error("Snapshot script injection error:", chrome.runtime.lastError.message);
          if (callback) callback(false);
          return;
        }

        const frames = (results || []).filter(
          (r) => r && r.result && typeof r.result.html === 'string'
        );

        if (!frames.length) {
          console.warn("Snapshot HTML is not a string or no content. Result:", results);
          if (callback) callback(false);
          return;
        }

        const pageUrl = targetTab.url || '';
        const capturedAt = new Date().toISOString();
        const combined = frames
          .map(
            (r) =>
              `<!-- ===== FRAME url=${r.result.url} frameId=${r.frameId} ===== -->\n` +
              r.result.html
          )
          .join('\n\n');

        // an automatic snapshot identical to the previous one adds nothing -- skip it
        const contentHash = _hashString(combined);
        if (isAuto && lastSnapshotHash[targetTab.id] === contentHash) {
          console.log("[auto-snapshot] ⏭️ Skipping snapshot - page content unchanged since last capture");
          return;
        }
        lastSnapshotHash[targetTab.id] = contentHash;
        // count only snapshots actually saved toward the per-URL cap
        if (lastSnapshotUrl[targetTab.id] === targetTab.url) {
          sameUrlSnapshotCount[targetTab.id] = (sameUrlSnapshotCount[targetTab.id] || 0) + 1;
        } else {
          sameUrlSnapshotCount[targetTab.id] = 1;
        }
        lastSnapshotUrl[targetTab.id] = targetTab.url;
        _storeSnapshotFrames(frames, targetTab.id, isAuto ? 'auto-snapshot' : 'snapshot');

        const fallbackNote = isTimeoutFallback
          ? "\n     NOTE: multi-frame capture timed out (a frame likely never finished loading -- e.g. a reCAPTCHA iframe); this is a main-frame-only fallback capture."
          : "";

        const annotatedHtml =
          `<!-- Stream Recorder snapshot (all frames)\n     Top URL: ${pageUrl}\n     Title: ${pageTitle}\n     Captured: ${capturedAt}\n     Frames captured: ${frames.length}${fallbackNote}\n-->\n` +
          combined;

        try {
          const timestamp = timestampForFilename();
          const filename = generateSnapshotFilename(pageUrl, pageTitle, timestamp);

          console.log("[auto-snapshot] Attempting download:", {
            filename,
            contentLength: annotatedHtml.length,
            frames: frames.length,
            title: pageTitle
          });

          const dataUri = 'data:text/html;charset=utf-8,' + encodeURIComponent(annotatedHtml);

          // ═══ FIX: Set the flag BEFORE calling download ═══
          expectingSnapshotFilename = filename;
          console.log("[auto-snapshot] Set expectingSnapshotFilename to:", filename);

          chrome.downloads.download({
            url: dataUri,
            filename: filename,
            saveAs: false,
            conflictAction: "uniquify"
          }, (downloadId) => {
            if (chrome.runtime.lastError) {
              console.error("[auto-snapshot] Snapshot download FAILED:", chrome.runtime.lastError.message);
              // ═══ FIX: Don't clear immediately - let onDeterminingFilename use it ═══
              // We'll clear it after a delay, but onDeterminingFilename runs synchronously
              setTimeout(() => {
                expectingSnapshotFilename = null;
                console.log("[auto-snapshot] Cleared expectingSnapshotFilename (after download fail)");
              }, 3000);
              if (callback) callback(false);
            } else if (downloadId === undefined) {
              console.error("[auto-snapshot] Snapshot download returned undefined ID - download was blocked or cancelled");
              setTimeout(() => {
                expectingSnapshotFilename = null;
                console.log("[auto-snapshot] Cleared expectingSnapshotFilename (undefined ID)");
              }, 3000);
              if (callback) callback(false);
            } else {
              console.log("[auto-snapshot] Snapshot download initiated:", { filename, downloadId });

              if (specificTabId) {
                lastSnapshotTime[specificTabId] = Date.now();
                console.log("[auto-snapshot] Recorded snapshot time for tab", specificTabId);
              }

              // ═══ FIX: Keep the flag set for longer - onDeterminingFilename needs it ═══
              // The onDeterminingFilename listener runs synchronously when download starts
              // We need to keep the flag set until the filename is determined
              // 3000ms should be more than enough
              setTimeout(() => {
                expectingSnapshotFilename = null;
                console.log("[auto-snapshot] Cleared expectingSnapshotFilename (after 3s)");
              }, 3000);

              // Check download status after a moment
              setTimeout(() => {
                chrome.downloads.search({ id: downloadId }, (results) => {
                  if (chrome.runtime.lastError) {
                    console.warn("[auto-snapshot] Could not check download status:", chrome.runtime.lastError.message);
                    return;
                  }
                  if (results && results.length > 0) {
                    const dl = results[0];
                    console.log("[auto-snapshot] Download status:", {
                      id: dl.id,
                      state: dl.state,
                      filename: dl.filename,
                      url: dl.url ? dl.url.substring(0, 80) + '...' : 'no url',
                      error: dl.error,
                      bytesReceived: dl.bytesReceived,
                      totalBytes: dl.totalBytes,
                      danger: dl.danger,
                      exists: dl.exists
                    });
                    if (dl.state === 'in_progress') {
                      console.log("[auto-snapshot] ✅ Download is in progress - snapshot saved successfully!");
                    }
                  } else {
                    console.warn("[auto-snapshot] Download not found in search - may have been cancelled or failed silently");
                  }
                });
              }, 1500);

              if (callback) callback(true);
            }
          });
        } catch (e) {
          console.error("[auto-snapshot] Snapshot creation error:", e);
          expectingSnapshotFilename = null;
          if (callback) callback(false);
        }
      }
    });
  }

  if (specificTabId) {
    chrome.tabs.get(specificTabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        console.warn("Snapshot: tab no longer available:", specificTabId);
        if (callback) callback(false);
        return;
      }
      proceed(tab);
    });
  } else {
    chrome.windows.getLastFocused({ windowTypes: ['normal'], populate: true }, (win) => {
      const targetTab = (win && win.tabs || []).find(tab => {
        const url = tab.url || '';
        return tab.active && (url.startsWith('http://') || url.startsWith('https://'));
      });
      proceed(targetTab);
    });
  }
}

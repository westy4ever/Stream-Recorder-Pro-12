// screenshot.js - Screenshot & snapshot capture
import { state, scheduleSave, slugifyUrlForFilename, timestampForFilename } from './state.js';
import { CONFIG } from './config.js';
import { isYTSSite, isArabicMovieSite } from './site-detection.js';

export let expectingSnapshotFilename = null;
export const pendingAutoSnapshotTimers = {};

// Track last snapshot time per tab to prevent duplicates
const lastSnapshotTime = {};

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
        .replace(/\s*[|:]\s*(EgyDead|Wecima|MyCima|YTS|YIFY|Arabic|Movie|Series|TV|Online|Watch|Stream|HD|1080p|720p|480p|360p)\s*/gi, '')
        .replace(/[^a-zA-Z0-9\u0600-\u06ff\s-]/g, '')
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
        const lastPart = parts[parts.length - 1] || parts[0] || 'page';
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
    
    const timestampStr = timestamp || timestampForFilename();
    const finalName = name.replace(/\s+/g, '-').substring(0, 60);
    
    return `snapshot_${finalName}_${timestampStr}.html`;
    
  } catch (e) {
    const slug = slugifyUrlForFilename(pageUrl);
    const timestampStr = timestamp || timestampForFilename();
    return `snapshot_${slug}_${timestampStr}.html`;
  }
}

// ═══ SNAPSHOT CAPTURE ═══
export function scheduleAutoSnapshot(tabId, delay = 1200) {
  console.log("[auto-snapshot] scheduleAutoSnapshot called for tab", tabId, "delay", delay);
  
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) {
      console.warn("[auto-snapshot] tab not available:", chrome.runtime.lastError?.message);
      return;
    }
    console.log("[auto-snapshot] tab info:", tab.id, tab.url);
    if (isYTSSite(tab.url) || isArabicMovieSite(tab.url)) {
      delay = 800;
    }

    const now = Date.now();
    const lastTime = lastSnapshotTime[tabId] || 0;
    const minInterval = CONFIG.SNAPSHOT_COOLDOWN_MS || 2000;
    
    if (now - lastTime < minInterval) {
      console.log("[auto-snapshot] ⏱️ Skipping duplicate snapshot - too soon (", now - lastTime, "ms since last)");
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
    console.log("[auto-snapshot] capturing tab", targetTab.id, targetTab.url);
    
    // Get page title first
    chrome.scripting.executeScript({
      target: { tabId: targetTab.id },
      func: () => document.title
    }, (titleResults) => {
      const pageTitle = titleResults && titleResults[0] ? titleResults[0].result : '';
      
      chrome.scripting.executeScript({
        target: { tabId: targetTab.id, allFrames: true },
        func: () => ({ url: location.href, html: document.documentElement.outerHTML })
      }, (results) => {
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
        const annotatedHtml =
          `<!-- Stream Recorder snapshot (all frames)\n     Top URL: ${pageUrl}\n     Title: ${pageTitle}\n     Captured: ${capturedAt}\n     Frames captured: ${frames.length}\n-->\n` +
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
      });
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
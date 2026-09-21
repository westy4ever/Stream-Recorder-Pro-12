// background.js - Main entry point (orchestrator)
import { state, restoreState, cleanupMemory, persistState, broadcastRecordingState } from './state.js';
import { CONFIG } from './config.js';
import { initNetworkCapture } from './network-capture.js';
import { initMessageHandlers } from './message-handlers.js';
import { initDownloadListeners } from './download-listeners.js';
import { initProxy } from './proxy.js';
import { initKeyboardShortcuts } from './keyboard-shortcuts.js';
import { pendingAutoSnapshotTimers, expectingSnapshotFilename } from './screenshot.js';
import { CHALLENGE_SOLVING } from './challenge-solver.js';

console.log("Stream Recorder Pro background ready (modularized)");

// ═══ RESTORE STATE ON LOAD ═══
(async () => {
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
      return;
    }
  } catch (e) {
    console.warn('Failed to restore recording state:', e);
  }
})();

// ═══ RESTORE UI BADGE ═══
if (state.recording) {
  chrome.action.setBadgeText({ text: "REC" });
  chrome.action.setBadgeBackgroundColor({ color: "#FF0000" });
  broadcastRecordingState(true);
}

// ═══ MEMORY MANAGEMENT ═══
setInterval(cleanupMemory, CONFIG.AUTO_CLEANUP_INTERVAL);

// ═══ TAB CLEANUP ═══
chrome.tabs.onRemoved.addListener((tabId) => {
  delete CHALLENGE_SOLVING[tabId];
  if (pendingAutoSnapshotTimers[tabId]) {
    clearTimeout(pendingAutoSnapshotTimers[tabId]);
    delete pendingAutoSnapshotTimers[tabId];
  }
});

// ═══ INITIALIZE ALL MODULES ═══
initNetworkCapture();
initMessageHandlers();
initDownloadListeners();
initProxy();
initKeyboardShortcuts();

// ═══ DOWNLOAD FILENAME HANDLER ═══
// This runs synchronously when a download is created
// The expectingSnapshotFilename flag is set by screenshot.js before calling download
chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  const isSnapshotDataUri = downloadItem.url && downloadItem.url.startsWith('data:text/html');
  
  console.log("[auto-snapshot] onDeterminingFilename called:", {
    url: downloadItem.url ? downloadItem.url.substring(0, 100) + '...' : 'no url',
    filename: downloadItem.filename,
    mime: downloadItem.mime,
    state: downloadItem.state,
    isSnapshotDataUri: isSnapshotDataUri,
    expectingSnapshotFilename: expectingSnapshotFilename
  });
  
  if (isSnapshotDataUri && expectingSnapshotFilename) {
    // Use the filename we set in screenshot.js
    const filename = expectingSnapshotFilename;
    console.log("[auto-snapshot] ✅ Using expected snapshot filename:", filename);
    suggest({ filename, conflictAction: "uniquify" });
    return;
  }
  
  if (isSnapshotDataUri) {
    // Fallback: snapshot but no filename set
    const fallbackFilename = 'snapshot_' + Date.now() + '.html';
    console.warn("[auto-snapshot] ⚠️ Snapshot but no filename, using fallback:", fallbackFilename);
    suggest({ filename: fallbackFilename, conflictAction: "uniquify" });
    return;
  }
  
  // Non-snapshot download - use default behavior
  console.log("[auto-snapshot] Non-snapshot download, using default");
  suggest();
});

chrome.action.setBadgeText({ text: "" });
console.log("Stream Recorder Pro ready");
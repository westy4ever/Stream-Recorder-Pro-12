// background.js - Main entry point (orchestrator)
import { state, cleanupMemory, persistState, broadcastRecordingState, stateReadyPromise } from './state.js';
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
// [FIX] the actual restore now happens in state.js's stateReadyPromise --
// created the instant that module is evaluated, which is BEFORE
// initNetworkCapture() below registers a single webRequest listener. This
// block just waits on that same promise to drive the UI badge, instead of
// independently re-running (and racing) a second copy of the restore logic.
stateReadyPromise.then(() => {
  // ═══ RESTORE UI BADGE ═══
  // [FIX] this used to be a separate, synchronous block that ran immediately after the async
  // IIFE above was fired off -- NOT after it actually finished. Confirmed directly: that meant
  // this check always read state.recording's pre-restore default (false), even on a genuine
  // mid-recording restart, since chrome.storage.local.get() is a real async call that yields
  // control back before restoreState() ever runs. Manifest V3 routinely suspends/restarts the
  // service worker (after ~30s idle, among other triggers), so this wasn't a rare edge case --
  // every one of those restarts during an active recording silently dropped the extension
  // icon's "REC" badge and skipped telling any already-open tab to show its recording
  // indicator again, both looking exactly like "recording silently stopped" even though state
  // was (eventually, just too late for this one-time check) restored correctly. Moved inside
  // the IIFE, after restoreState() has actually run, so it sees the real, restored value.
  if (state.recording) {
    chrome.action.setBadgeText({ text: "REC" });
    chrome.action.setBadgeBackgroundColor({ color: "#FF0000" });
    broadcastRecordingState(true);
  }
});

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
  // [FIX] this listener fires for every download the extension makes, not
  // just snapshots. Chrome's own docs say bare suggest() (no arguments)
  // should preserve downloadItem.filename -- the name already determined
  // from the original download() call -- so this should have been a safe
  // no-op. Kept as an explicit pass-through rather than bare suggest() as
  // a defensive measure, though the actual root cause of the naming bug
  // turned out to be upstream of this listener entirely (downloads.download's
  // own saveAs: true discarding the supplied filename before this event
  // even fires, confirmed directly with real device logs) -- fixed at the
  // call sites themselves (saveAs: false everywhere exports are made).
  console.log("[auto-snapshot] Non-snapshot download, using default:", downloadItem.filename);
  suggest({ filename: downloadItem.filename });
});

chrome.action.setBadgeText({ text: "" });

console.log("Stream Recorder Pro ready");

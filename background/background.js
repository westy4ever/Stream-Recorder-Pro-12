// background.js - Main entry point (orchestrator)
import { state, cleanupMemory, persistState, broadcastRecordingState, stateReadyPromise, addRecordedTab } from './state.js';
import { CONFIG } from './config.js';
import { initNetworkCapture } from './network-capture.js';
import { initMessageHandlers } from './message-handlers.js';
import { initDownloadListeners } from './download-listeners.js';
import { initProxy } from './proxy.js';
import { initKeyboardShortcuts } from './keyboard-shortcuts.js';
import { pendingAutoSnapshotTimers, expectingSnapshotFilename, pendingDownloadFilenames } from './screenshot.js';
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

// ═══ TAB-FOLLOW FOR "CURRENT TAB" RECORDING ═══
// [FIX-tabfollow] "Current Tab" recording used to pin capture to the single tab that was
// active at Start time (state.recordTabId). On ad-heavy Arabic streaming sites the actual
// video/stream request very often fires in a NEW tab or popup window the site opens FROM
// that tab (a "watch now" / ad-gate click), not in the original tab -- every one of those
// requests was silently dropped by shouldRecordTab(), producing a clean "Network: 0" for an
// otherwise normal-looking recording session. Whenever a new tab is created with an
// openerTabId that's already part of the recorded set, fold it into that set too, so
// chrome.webRequest traffic from it is no longer filtered out. Transitive on purpose (a
// popup-of-a-popup chain all get followed) since addRecordedTab() grows the same set each
// new tab is checked against. No-op in "All Tabs" mode or when nothing is recording.
chrome.tabs.onCreated.addListener(async (tab) => {
  await stateReadyPromise;
  if (!state.recording) return;
  if (state.recordTabId === null) return; // "All Tabs" mode -- nothing to track
  if (typeof tab.openerTabId !== "number") return;
  const isFromRecordedTab = tab.openerTabId === state.recordTabId ||
    state.recordedTabIds.includes(tab.openerTabId);
  if (!isFromRecordedTab) return;
  addRecordedTab(tab.id);
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
  // [FIX-bloburl2] checked FIRST, ahead of every other branch below -- see the detailed
  // comment on pendingDownloadFilenames (screenshot.js) for why this is necessary at all:
  // Brave does not honor chrome.downloads.download()'s own `filename` option for a data:
  // URL, so every one of this extension's own downloads needs this explicit override, not
  // just snapshots.
  if (Object.prototype.hasOwnProperty.call(pendingDownloadFilenames, downloadItem.id)) {
    const filename = pendingDownloadFilenames[downloadItem.id];
    delete pendingDownloadFilenames[downloadItem.id];
    console.log("[auto-snapshot] ✅ Using pending download filename:", filename);
    suggest({ filename, conflictAction: "uniquify" });
    return;
  }

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

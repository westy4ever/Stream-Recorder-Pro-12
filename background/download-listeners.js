// download-listeners.js - Download capture
import { state, scheduleSave } from './state.js';
import { isSaveFilesSite } from './site-detection.js';
import { expectingSnapshotFilename } from './screenshot.js';

export function initDownloadListeners() {
  chrome.downloads.onCreated.addListener((item) => {
    // Check if this is our own snapshot using the shared flag
    const isOwnSnapshot = expectingSnapshotFilename !== null && 
                          item.filename && 
                          item.filename.endsWith(expectingSnapshotFilename);
    
    if (isOwnSnapshot) {
      console.log("[download-listener] Own snapshot detected, NOT cancelling:", item.filename);
      return;
    }
    
    // [FIX] confirmed directly, after ruling out every other download-related
    // code path in the extension: this listener's whole purpose is to catch
    // a DOWNLOAD LINK THE RECORDED WEBSITE ITSELF initiated, so its metadata
    // can be captured without actually saving the (often huge) video file to
    // disk -- but it had no way to distinguish that from the extension's OWN
    // downloads, which also arrive here as ordinary, non-snapshot downloads.
    // Originally only data:text/html (snapshots) was excluded. Every export
    // this extension makes -- JSON, markdown, CSV, HAR, the Python extractor
    // files -- was later moved to a data: URL too (to work around a separate,
    // confirmed Brave privacy feature that corrupts blob: URL filenames), so
    // this must exclude every data: URL, not just the snapshot's specific
    // MIME type. This is safe to broaden: a REAL download link on the
    // recorded website is never a data: URL -- every actual host confirmed
    // across tonight's testing (cdn-centaurus.com, mxcontent.net,
    // cloudatacdn.com, and others) is always a real https:// URL. A data:
    // URL reaching this listener can only be something this extension
    // itself generated.
    if (item.url && item.url.startsWith('data:')) {
      console.log("[download-listener] Own data: URL download detected, NOT cancelling:", item.filename);
      return;
    }

    const s = state;
    if (!s.recording) return;

    const downloadInfo = {
      timestamp: Date.now(),
      url: item.referrer || item.finalUrl || '',
      type: 'download_started',
      downloadUrl: item.finalUrl || item.url,
      filename: item.filename,
      mime: item.mime,
      fileSize: item.fileSize,
      danger: item.danger,
      state: item.state,
    };

    s.actions.push(downloadInfo);
    s.contentPipeline.downloadLinks.push(downloadInfo);
    s.contentPipeline.sequence.push({
      timestamp: Date.now(),
      type: 'download',
      data: downloadInfo
    });

    if (item.url && isSaveFilesSite(item.url)) {
      s.contentPipeline.source = 'savefiles';
    }

    scheduleSave();

    chrome.storage.sync.get(['captureDownloadsOnly'], ({ captureDownloadsOnly }) => {
      if (captureDownloadsOnly !== false) {
        console.log("[download-listener] Cancelling non-snapshot download:", item.filename);
        chrome.downloads.cancel(item.id, () => void chrome.runtime.lastError);
        chrome.downloads.erase({ id: item.id }, () => void chrome.runtime.lastError);
      }
    });
  });
}
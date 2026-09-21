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
    
    // Also check for data: URI snapshots as a fallback
    if (item.url && item.url.startsWith('data:text/html')) {
      console.log("[download-listener] data: URI snapshot detected, NOT cancelling");
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
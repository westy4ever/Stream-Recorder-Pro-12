// broadcast.js - State broadcasting
import { state } from './state.js';

// Export the init function
export function initBroadcast() {
  console.log("[broadcast] Initialized");
  // Any initialization logic can go here
}

export function broadcastRecordingState(isRecording) {
  try {
    chrome.tabs.query({}, (tabs) => {
      if (chrome.runtime.lastError) {
        console.warn("[broadcast] Error querying tabs:", chrome.runtime.lastError.message);
        return;
      }
      for (const tab of tabs) {
        if (!tab.id) continue;
        chrome.tabs.sendMessage(tab.id, { 
          type: "recordingStateChanged", 
          recording: isRecording 
        }, () => {
          void chrome.runtime.lastError;
        });
      }
    });
  } catch (e) {
    console.warn("[broadcast] Error:", e);
  }
}

// Also export as default for compatibility
export default {
  initBroadcast,
  broadcastRecordingState
};
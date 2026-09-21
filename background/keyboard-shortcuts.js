// keyboard-shortcuts.js - Keyboard shortcuts
import { state } from './state.js';

export function initKeyboardShortcuts() {
  console.log("[keyboard-shortcuts] Initialized");
  
  // Listen for commands from manifest
  chrome.commands.onCommand.addListener((command) => {
    try {
      if (command === 'take-snapshot') {
        chrome.runtime.sendMessage({ type: 'saveSnapshot' });
      } else if (command === 'toggle-recording') {
        if (state.recording) {
          chrome.runtime.sendMessage({ type: 'stopRecording' });
        } else {
          chrome.runtime.sendMessage({ type: 'startRecording' });
        }
      } else if (command === 'open-popup') {
        chrome.action.openPopup();
      }
    } catch (e) {
      console.warn("[keyboard-shortcuts] Error:", e);
    }
  });
}
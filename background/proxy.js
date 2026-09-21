// proxy.js - Proxy configuration
import { state } from './state.js';

export function initProxy() {
  console.log("[proxy] Initialized");
  // Load proxy settings
  try {
    chrome.storage.local.get(['browserProxy'], (result) => {
      if (result && result.browserProxy) {
        console.log("[proxy] Loaded proxy:", result.browserProxy);
      }
    });
  } catch (e) {
    console.warn("[proxy] Error loading settings:", e);
  }
}

export function setProxy(url) {
  try {
    chrome.storage.local.set({ browserProxy: url });
    console.log("[proxy] Set to:", url);
  } catch (e) {
    console.warn("[proxy] Error setting proxy:", e);
  }
}

export function getProxy() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(['browserProxy'], (result) => {
        resolve(result ? result.browserProxy : null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}
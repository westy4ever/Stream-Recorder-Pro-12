// challenge-solver.js - Cloudflare solving
import { state } from './state.js';

export const CHALLENGE_SOLVING = {};

export function initChallengeSolver() {
  console.log("[challenge-solver] Initialized");
}

export function handleCloudflareChallenge(tabId, url) {
  if (!tabId) return;
  
  // Check if already solving
  if (CHALLENGE_SOLVING[tabId]) {
    console.log("[challenge-solver] Already solving challenge for tab", tabId);
    return;
  }
  
  console.log("[challenge-solver] Handling Cloudflare challenge for", url);
  CHALLENGE_SOLVING[tabId] = true;
  
  // Default behavior: try to solve automatically
  try {
    chrome.tabs.sendMessage(tabId, { 
      type: 'solveChallenge', 
      url: url 
    }, () => {
      if (chrome.runtime.lastError) {
        console.warn("[challenge-solver] Could not send solve message:", chrome.runtime.lastError.message);
      }
    });
  } catch (e) {
    console.warn("[challenge-solver] Error:", e);
  }
  
  // Auto-clear after timeout
  setTimeout(() => {
    delete CHALLENGE_SOLVING[tabId];
  }, 30000);
}

export function solveManually(tabId, url) {
  return new Promise((resolve) => {
    console.log("[challenge-solver] Manual solve requested for", url);
    try {
      chrome.tabs.create({ url: url }, (tab) => {
        if (chrome.runtime.lastError) {
          console.warn("[challenge-solver] Error creating tab:", chrome.runtime.lastError.message);
          resolve(false);
          return;
        }
        // Wait for user to solve
        setTimeout(() => {
          // Check if challenge is solved
          try {
            chrome.tabs.sendMessage(tab.id, { type: 'checkChallengeSolved' }, (response) => {
              if (response && response.solved) {
                resolve(true);
              } else {
                resolve(false);
              }
            });
          } catch (e) {
            resolve(false);
          }
        }, 30000);
      });
    } catch (e) {
      console.warn("[challenge-solver] Manual solve error:", e);
      resolve(false);
    }
  });
}
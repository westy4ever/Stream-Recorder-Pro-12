// challenge-solver.js - Cloudflare solving
import { state } from './state.js';

export const CHALLENGE_SOLVING = {};

export function initChallengeSolver() {
  console.log("[challenge-solver] Initialized");
}

export function handleCloudflareChallenge(tabId, url) {
  if (!tabId) return;

  // [FIX] CHALLENGE_SOLVING used to be keyed only by tabId (a plain `true`), with no record
  // of WHICH url actually triggered it. If the same tab navigated away and hit a genuinely
  // new, unrelated Cloudflare challenge on a different page within the 30s auto-clear window
  // below, it was silently skipped as "already solving" -- even though the original challenge
  // (on a now-abandoned page) had nothing to do with this new one. Tracking url alongside the
  // timestamp lets a different challenge on the same tab still get handled, while a genuine
  // duplicate (same tab, same url) is still correctly skipped.
  const existing = CHALLENGE_SOLVING[tabId];
  if (existing && existing.url === url) {
    console.log("[challenge-solver] Already solving challenge for tab", tabId);
    return;
  }

  console.log("[challenge-solver] Handling Cloudflare challenge for", url);
  CHALLENGE_SOLVING[tabId] = { url, timestamp: Date.now() };

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
    // [FIX] only clear the entry if it's still tracking THIS same challenge (same url) --
    // a newer challenge on the same tab may have already replaced it by the time this fires,
    // and this stale timer must not delete that newer entry out from under it.
    if (CHALLENGE_SOLVING[tabId] && CHALLENGE_SOLVING[tabId].url === url) {
      delete CHALLENGE_SOLVING[tabId];
    }
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
          // [FIX] the tab created here for the user to manually solve the challenge in was
          // never closed afterward, in either outcome -- every manual-solve attempt left a
          // permanently orphaned tab open. Closed now regardless of whether the challenge
          // was actually solved, or whether checking even got a response at all.
          const finish = (solved) => {
            chrome.tabs.remove(tab.id, () => void chrome.runtime.lastError);
            resolve(solved);
          };
          try {
            chrome.tabs.sendMessage(tab.id, { type: 'checkChallengeSolved' }, (response) => {
              finish(!!(response && response.solved));
            });
          } catch (e) {
            finish(false);
          }
        }, 30000);
      });
    } catch (e) {
      console.warn("[challenge-solver] Manual solve error:", e);
      resolve(false);
    }
  });
}

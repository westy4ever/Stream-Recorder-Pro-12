// challenge-solver-integration.js - Cloudflare/Turnstile Challenge Solver
import { state } from './state.js';

export function solveChallenge(tabId, challengeType, url) {
  return new Promise((resolve) => {
    console.log(`[Challenge Solver] Solving ${challengeType} challenge for ${url}`);

    switch (challengeType) {
      case 'turnstile':
      case 'cf-turnstile':
        solveTurnstile(tabId, url, resolve);
        break;
      case 'managed':
      case 'js':
        solveManagedChallenge(tabId, url, resolve);
        break;
      default:
        resolve({ success: false, message: `Unknown challenge type: ${challengeType}` });
    }
  });
}

function solveTurnstile(tabId, url, resolve) {
  chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: () => {
      const selectors = [
        '.cf-turnstile iframe',
        'iframe[src*="turnstile"]',
        '[data-sitekey]',
        '.turnstile-widget',
        '#turnstile-container'
      ];

      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element) {
          element.click();
          
          if (element.tagName === 'IFRAME') {
            try {
              const iframeDoc = element.contentDocument || element.contentWindow?.document;
              if (iframeDoc) {
                const checkbox = iframeDoc.querySelector('[role="checkbox"]');
                if (checkbox) {
                  checkbox.click();
                  return { success: true, method: 'iframe_click' };
                }
              }
            } catch (e) {}
          }
          return { success: true, method: 'click' };
        }
      }
      return { success: false, message: 'No Turnstile element found' };
    }
  }, (results) => {
    if (results && results[0] && results[0].result && results[0].result.success) {
      resolve({ success: true, method: 'auto_click' });
    } else {
      chrome.tabs.create({ url: url }, (tab) => {
        resolve({ 
          success: true, 
          method: 'manual',
          message: 'Opened new tab for manual solving'
        });
      });
    }
  });
}

function solveManagedChallenge(tabId, url, resolve) {
  chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: () => {
      const challengeElements = [
        '#cf-browser-verification',
        '.cf-browser-verification',
        '#cf-challenge-running',
        '#challenge-running',
        '.cf-im-under-attack',
        '#challenge-form'
      ];

      for (const selector of challengeElements) {
        if (document.querySelector(selector)) {
          return { success: false, message: 'Challenge still present' };
        }
      }

      if (document.body && document.body.textContent && document.body.textContent.length > 1000) {
        return { success: true, method: 'auto_detected' };
      }

      return { success: false, message: 'Unknown state' };
    }
  }, (results) => {
    if (results && results[0] && results[0].result && results[0].result.success) {
      resolve({ success: true, method: 'auto_detected' });
    } else {
      chrome.tabs.reload(tabId, () => {
        setTimeout(() => {
          resolve({ success: true, method: 'refresh' });
        }, 5000);
      });
    }
  });
}

export function getChallengeStatus(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'getChallengeStatus' }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ status: 'unknown' });
        return;
      }
      resolve(response || { status: 'unknown' });
    });
  });
}

export function waitForChallengeSolved(tabId, timeout = 30000) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const interval = setInterval(() => {
      if (Date.now() - startTime > timeout) {
        clearInterval(interval);
        resolve({ success: false, message: 'Timeout' });
        return;
      }

      getChallengeStatus(tabId).then((status) => {
        if (status.status === 'solved' || status.status === 'none') {
          clearInterval(interval);
          resolve({ success: true, status: status.status });
        }
      });
    }, 1000);
  });
}
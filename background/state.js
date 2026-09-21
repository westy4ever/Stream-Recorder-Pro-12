// state.js - State management & persistence
import { CONFIG } from './config.js';

// ═══ STATE ═══
export let state = {
  recording: false,
  filterMode: "all",
  autoSnapshot: false,
  primaryDomain: null,
  actions: [],
  networkLog: [],
  pending: {},
  xhrBodies: [],
  userJourney: [],
  screenshots: [],
  contentPipeline: {
    source: '',
    movieList: [],
    downloadLinks: [],
    metadata: {},
    sequence: []
  },
  allowedDomains: [],
  blockedDomains: [],
  recordTabId: null,
  challengeSolving: {}
};

export let saveTimeout = null;

// ═══ BROADCAST ═══
export function broadcastRecordingState(isRecording) {
  try {
    chrome.tabs.query({}, (tabs) => {
      if (chrome.runtime.lastError) {
        console.warn("[broadcast] Error querying tabs:", chrome.runtime.lastError.message);
        return;
      }
      for (const tab of tabs) {
        if (!tab.id) continue;
        chrome.tabs.sendMessage(tab.id, { type: "recordingStateChanged", recording: isRecording }, () => {
          void chrome.runtime.lastError;
        });
      }
    });
  } catch (e) {
    console.warn("[broadcast] Error:", e);
  }
}

// ═══ DOMAIN HELPERS ═══
export function registrableDomain(hostname) {
  if (!hostname || hostname === '') return null;
  
  // ═══ FIX: Skip non-web domains ═══
  const lower = hostname.toLowerCase();
  const skipDomains = [
    'newtab', 'localhost', '127.0.0.1', '0.0.0.0',
    'extensions', 'chrome', 'chrome-extension', 'chrome://',
    'about:', 'data:', 'blob:', 'file:'
  ];
  
  // Check if it's a non-web domain
  for (const skip of skipDomains) {
    if (lower.includes(skip)) return null;
  }
  
  // Check if it's an IP address
  if (/^\d+\.\d+\.\d+\.\d+$/.test(lower)) return null;
  
  const parts = hostname.split('.');
  
  // If it's a single word domain (like 'localhost')
  if (parts.length <= 1) return null;
  
  // If it's a two-part domain (like 'egydead.live')
  if (parts.length === 2) return hostname;
  
  // For longer domains, get the last two parts (registrable domain)
  // e.g., 'tv10.egydead.live' → 'egydead.live'
  // but 'sub.domain.co.uk' → 'domain.co.uk' (needs special handling)
  // For simplicity, we'll use the last two parts for most cases
  return parts.slice(-2).join('.');
}

export function isSameSite(urlStr) {
  const s = state;
  if (!s.primaryDomain) return true;
  try {
    const urlDomain = registrableDomain(new URL(urlStr).hostname);
    if (!urlDomain) return true;
    return urlDomain === s.primaryDomain;
  } catch (e) {
    return false;
  }
}

export function setPrimaryDomainFromUrl(urlStr) {
  if (!urlStr) return false;
  try {
    const url = new URL(urlStr);
    const domain = registrableDomain(url.hostname);
    if (domain) {
      state.primaryDomain = domain;
      console.log("[primaryDomain] Set to:", domain);
      return true;
    }
  } catch (e) {
    console.warn("[primaryDomain] Failed to set from URL:", urlStr, e);
  }
  return false;
}

// ═══ URL FILTERS ═══
export function shouldRecordUrl(url) {
  try {
    const hostname = new URL(url).hostname;
    const s = state;
    if (s.blockedDomains.some(d => hostname.includes(d))) return false;
    if (s.allowedDomains.length && !s.allowedDomains.some(d => hostname.includes(d))) return false;
    return true;
  } catch { return false; }
}

export function shouldRecordTab(tabId) {
  const s = state;
  if (s.recordTabId === null) return true;
  return tabId === s.recordTabId;
}

export function passesFilter(resourceType) {
  const s = state;
  if (s.filterMode === "xhr") return resourceType === "xmlhttprequest";
  return true;
}

// ═══ REQUEST HELPERS ═══
export function safeBodyToString(requestBody) {
  if (!requestBody) return null;
  try {
    if (requestBody.raw) {
      const decoder = new TextDecoder("utf-8", { fatal: false });
      const chunks = requestBody.raw
        .map((r) => (r.bytes ? decoder.decode(r.bytes) : ""))
        .join("");
      return chunks.length > CONFIG.MAX_BODY_CHARS ? chunks.slice(0, CONFIG.MAX_BODY_CHARS) + "…[truncated]" : chunks;
    }
    if (requestBody.formData) return JSON.stringify(requestBody.formData);
  } catch (e) {
    return `[unreadable body: ${e.message}]`;
  }
  return null;
}

export function headersToObject(headerArray) {
  if (!headerArray) return {};
  const obj = {};
  for (const h of headerArray) {
    obj[h.name] = h.value !== undefined ? h.value : (h.binaryValue ? "[binary]" : "");
  }
  return obj;
}

// ═══ FILENAME HELPERS ═══
export function slugifyUrlForFilename(urlStr) {
  try {
    const u = new URL(urlStr);
    let path = (u.pathname + u.search).replace(/^\/+|\/+$/g, '');
    try { path = decodeURIComponent(path); } catch (e) {}
    let slug = path
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 80)
      .replace(/^-+|-+$/g, '');
    return slug || 'home';
  } catch (e) {
    return 'page';
  }
}

export function timestampForFilename() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// ═══ STATE PERSISTENCE ═══
export function buildPersistPayload() {
  const s = state;
  return {
    recording: s.recording,
    filterMode: s.filterMode,
    autoSnapshot: s.autoSnapshot,
    primaryDomain: s.primaryDomain,
    actions: s.actions.length > CONFIG.MAX_PERSISTED_ACTION_ENTRIES
      ? s.actions.slice(-CONFIG.MAX_PERSISTED_ACTION_ENTRIES).map(a => ({
          ...a,
          text: a.text ? a.text.substring(0, 500) : undefined,
          value: a.value ? a.value.substring(0, 500) : undefined,
          pageState: a.pageState ? JSON.stringify(a.pageState).substring(0, 500) : undefined
        }))
      : s.actions.map(a => ({
          ...a,
          text: a.text ? a.text.substring(0, 500) : undefined,
          value: a.value ? a.value.substring(0, 500) : undefined,
          pageState: a.pageState ? JSON.stringify(a.pageState).substring(0, 500) : undefined
        })),
    networkLog: s.networkLog.length > CONFIG.MAX_PERSISTED_NETWORK_ENTRIES
      ? s.networkLog.slice(-CONFIG.MAX_PERSISTED_NETWORK_ENTRIES).map(n => ({
          ...n,
          requestBody: n.requestBody ? n.requestBody.substring(0, 2000) : null,
          responseBody: n.responseBody ? n.responseBody.substring(0, 2000) : null
        }))
      : s.networkLog.map(n => ({
          ...n,
          requestBody: n.requestBody ? n.requestBody.substring(0, 2000) : null,
          responseBody: n.responseBody ? n.responseBody.substring(0, 2000) : null
        })),
    pending: s.pending,
    userJourney: s.userJourney.slice(-100),
    contentPipeline: {
      ...s.contentPipeline,
      movieList: s.contentPipeline.movieList ? s.contentPipeline.movieList.slice(0, 50) : [],
      downloadLinks: s.contentPipeline.downloadLinks ? s.contentPipeline.downloadLinks.slice(0, 20) : [],
      sequence: s.contentPipeline.sequence ? s.contentPipeline.sequence.slice(0, 100) : []
    },
    screenshots: s.screenshots.slice(-CONFIG.MAX_SCREENSHOTS).map(s => ({
      timestamp: s.timestamp,
      tabId: s.tabId,
      dataUrl: s.dataUrl ? s.dataUrl.substring(0, 100) + '...' : null
    })),
    recordTabId: s.recordTabId,
    allowedDomains: s.allowedDomains,
    blockedDomains: s.blockedDomains
  };
}

export function persistState() {
  try {
    const payload = buildPersistPayload();
    
    try {
      chrome.storage.session.set({ srStateBackup: payload }).catch(() => {});
    } catch (e) {}

    const compressed = {
      recording: payload.recording,
      filterMode: payload.filterMode,
      autoSnapshot: payload.autoSnapshot,
      primaryDomain: payload.primaryDomain,
      actions: payload.actions.slice(0, 50),
      networkLog: payload.networkLog.slice(0, 50),
      userJourney: payload.userJourney.slice(0, 50),
      contentPipeline: {
        source: payload.contentPipeline.source || '',
        movieList: payload.contentPipeline.movieList ? payload.contentPipeline.movieList.slice(0, 20) : [],
        downloadLinks: payload.contentPipeline.downloadLinks ? payload.contentPipeline.downloadLinks.slice(0, 10) : [],
        metadata: payload.contentPipeline.metadata || {},
        sequence: payload.contentPipeline.sequence ? payload.contentPipeline.sequence.slice(0, 50) : []
      },
      screenshots: payload.screenshots.slice(0, 10),
      recordTabId: payload.recordTabId,
      allowedDomains: payload.allowedDomains || [],
      blockedDomains: payload.blockedDomains || []
    };
    
    try {
      chrome.storage.local.set({ srState: compressed }).catch((e) => {
        if (e.message && e.message.includes('QUOTA_BYTES')) {
          console.warn('Storage quota exceeded, saving minimal state');
          const minimal = {
            recording: payload.recording,
            filterMode: payload.filterMode,
            autoSnapshot: payload.autoSnapshot,
            primaryDomain: payload.primaryDomain,
            actions: payload.actions.slice(0, 20),
            networkLog: payload.networkLog.slice(0, 20),
            recordTabId: payload.recordTabId,
            allowedDomains: payload.allowedDomains || [],
            blockedDomains: payload.blockedDomains || []
          };
          chrome.storage.local.set({ srState: minimal }).catch(() => {});
        }
      });
    } catch (e) {
      console.warn('Failed to persist to local storage:', e);
    }
  } catch (e) {
    console.warn('Failed to persist recording state:', e);
  }
}

export function scheduleSave() {
  if (saveTimeout) return;
  saveTimeout = setTimeout(() => {
    saveTimeout = null;
    persistState();
  }, 1000);
}

export function restoreState(savedState) {
  if (!savedState) return;
  try {
    const s = state;
    s.recording = !!savedState.recording;
    s.filterMode = savedState.filterMode || "all";
    s.autoSnapshot = !!savedState.autoSnapshot;
    s.primaryDomain = savedState.primaryDomain || null;
    s.actions = savedState.actions || [];
    s.networkLog = savedState.networkLog || [];
    s.pending = savedState.pending || {};
    s.userJourney = savedState.userJourney || [];
    s.contentPipeline = savedState.contentPipeline || { source: '', movieList: [], downloadLinks: [], metadata: {}, sequence: [] };
    s.screenshots = savedState.screenshots || [];
    s.recordTabId = savedState.recordTabId || null;
    s.allowedDomains = savedState.allowedDomains || [];
    s.blockedDomains = savedState.blockedDomains || [];
  } catch (e) {
    console.warn('Failed to restore state:', e);
  }
}

export function cleanupMemory() {
  try {
    const s = state;
    if (s.networkLog.length > CONFIG.MAX_NETWORK_LOG_SIZE) {
      s.networkLog = s.networkLog.slice(-CONFIG.MAX_NETWORK_LOG_SIZE);
    }
    if (s.xhrBodies.length > CONFIG.MAX_XHR_BODIES_SIZE) {
      s.xhrBodies = s.xhrBodies.slice(-CONFIG.MAX_XHR_BODIES_SIZE);
    }
    if (s.screenshots.length > CONFIG.MAX_SCREENSHOTS) {
      s.screenshots = s.screenshots.slice(-CONFIG.MAX_SCREENSHOTS);
    }
    if (s.actions.length > CONFIG.MAX_PERSISTED_ACTION_ENTRIES * 2) {
      s.actions = s.actions.slice(-CONFIG.MAX_PERSISTED_ACTION_ENTRIES);
    }
    if (s.userJourney.length > 200) {
      s.userJourney = s.userJourney.slice(-200);
    }
    persistState();
  } catch (e) {
    console.warn('Cleanup error:', e);
  }
}

if (CONFIG && CONFIG.AUTO_CLEANUP_INTERVAL) {
  setInterval(() => {
    cleanupMemory();
  }, CONFIG.AUTO_CLEANUP_INTERVAL);
}
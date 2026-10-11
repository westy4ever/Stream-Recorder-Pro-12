// version-tracker.js - Site Version Tracking
import { state } from './state.js';

const VERSION_HISTORY_KEY = 'sr_version_history';

// [FIX] see the getHeaderCaseInsensitive note below and the [FIX] notes on trackSiteVersion/
// getBaseUrl -- same case-insensitive header lookup already confirmed and fixed in the
// sibling site-comparator.js this session.
function getHeaderCaseInsensitive(headers, name) {
  if (!headers) return undefined;
  const lowerName = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerName) return headers[key];
  }
  return undefined;
}

// [FIX] this file lives in background/, the same module graph as background.js/state.js/
// message-handlers.js -- all of which run in the extension's Manifest V3 service worker,
// which has NO DOM and NO window object at all. window.location.href here would throw
// "window is not defined" (or equivalent) the instant this ran in its real context; this is
// documented, standard Manifest V3 platform behavior, not something specific to this
// extension. Rewritten to ask the currently active tab for its URL via chrome.tabs.query,
// which is what a service worker actually has available.
function getBaseUrl() {
  return new Promise((resolve) => {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        try {
          const tabUrl = tabs && tabs[0] && tabs[0].url;
          if (!tabUrl) return resolve('unknown');
          const url = new URL(tabUrl);
          resolve(`${url.protocol}//${url.hostname}`);
        } catch (e) {
          resolve('unknown');
        }
      });
    } catch (e) {
      resolve('unknown');
    }
  });
}

export async function trackSiteVersion() {
  const s = state;
  const networkLog = s.networkLog || [];
  const xhrBodies = s.xhrBodies || [];

  const siteData = {
    url: await getBaseUrl(),
    version: detectVersion(networkLog, xhrBodies),
    endpoints: detectEndpoints(networkLog),
    fields: detectFields(xhrBodies),
    timestamp: Date.now()
  };

  // [FIX] localStorage does not exist in a Manifest V3 service worker either -- same root
  // cause as getBaseUrl() above. Replaced with chrome.storage.local, the actual storage API
  // available here (and already used by every other background/ file, e.g. proxy.js/state.js).
  let history = [];
  try {
    const stored = await new Promise((resolve) => {
      chrome.storage.local.get([VERSION_HISTORY_KEY], resolve);
    });
    if (stored && stored[VERSION_HISTORY_KEY]) history = stored[VERSION_HISTORY_KEY];
  } catch (e) {}

  // Check for changes
  const lastVersion = history.length > 0 ? history[history.length - 1] : null;
  const changes = detectChanges(lastVersion, siteData);

  // Store new version
  history.push(siteData);
  if (history.length > 100) history = history.slice(-100);
  try {
    await new Promise((resolve) => {
      chrome.storage.local.set({ [VERSION_HISTORY_KEY]: history }, resolve);
    });
  } catch (e) {}

  return {
    current: siteData,
    previous: lastVersion,
    changes: changes,
    history: history.slice(-10)
  };
}

function detectVersion(networkLog, xhrBodies) {
  const version = {
    apiVersion: null,
    uiVersion: null,
    framework: null,
    detected: []
  };

  // Check for API version headers
  for (const entry of networkLog) {
    // [FIX] real HTTP response headers use their standard, conventional casing
    // ("X-Api-Version", "X-Powered-By"), not lowercase -- plain object property access is
    // case-sensitive, so these could never actually match real-world header casing. Same bug
    // class already confirmed and fixed in site-comparator.js this session.
    const apiVersionHeader = getHeaderCaseInsensitive(entry.responseHeaders, 'x-api-version');
    if (apiVersionHeader) {
      version.apiVersion = apiVersionHeader;
      version.detected.push('api_version_header');
    }
    const poweredByHeader = getHeaderCaseInsensitive(entry.responseHeaders, 'x-powered-by');
    if (poweredByHeader) {
      version.framework = poweredByHeader;
      version.detected.push('x_powered_by');
    }

    // [FIX] this URL check ran unconditionally, silently overwriting an already-detected
    // apiVersion from the (now-working, case-insensitive) header check above whenever both
    // were present -- previously invisible, since the header check never actually fired due
    // to the case-sensitivity bug, so the URL guess was always the only thing that could set
    // this. An explicit, dedicated version header is a more authoritative signal than a
    // coincidental /v1/ path segment, so it's no longer overwritten once already set.
    if (entry.url && !version.apiVersion) {
      const urlMatch = entry.url.match(/\/v(\d+)(?:\/|$)/);
      if (urlMatch) {
        version.apiVersion = 'v' + urlMatch[1];
        version.detected.push('url_version');
      }
    }
  }

  // Check response bodies for version info
  for (const body of xhrBodies) {
    if (body.body) {
      const versionMatch = body.body.match(/"version"\s*:\s*"([^"]+)"/);
      if (versionMatch) {
        version.uiVersion = versionMatch[1];
        version.detected.push('json_version');
      }
      const frameworkMatch = body.body.match(/(?:react|vue|angular|next)/i);
      if (frameworkMatch && !version.framework) {
        version.framework = frameworkMatch[0];
        version.detected.push('framework_detected');
      }
    }
  }

  return version;
}

function detectEndpoints(networkLog) {
  const endpoints = [];
  for (const entry of networkLog) {
    if (entry.url && (entry.url.includes('/api/') || entry.url.includes('/ajax/'))) {
      try {
        const url = new URL(entry.url);
        endpoints.push({
          path: url.pathname,
          method: entry.method || 'GET',
          status: entry.statusCode || 0
        });
      } catch (e) {}
    }
  }
  return endpoints;
}

function detectFields(xhrBodies) {
  const fields = [];
  for (const body of xhrBodies) {
    if (body.body && body.contentType === 'json') {
      try {
        const data = JSON.parse(body.body);
        if (typeof data === 'object') {
          const objFields = Object.keys(data).filter(k => !k.startsWith('_'));
          fields.push(...objFields);
        }
      } catch (e) {}
    }
  }
  return [...new Set(fields)];
}

function detectChanges(previous, current) {
  const changes = {
    type: 'none',
    endpoints: [],
    fields: [],
    version: null,
    details: []
  };

  if (!previous) {
    changes.type = 'initial';
    changes.details.push('First time tracking this site');
    return changes;
  }

  // Check version changes
  if (previous.version.apiVersion !== current.version.apiVersion) {
    changes.version = `API: ${previous.version.apiVersion} → ${current.version.apiVersion}`;
    changes.details.push(changes.version);
    changes.type = 'api_version';
  }

  if (previous.version.uiVersion !== current.version.uiVersion) {
    changes.version = `UI: ${previous.version.uiVersion} → ${current.version.uiVersion}`;
    changes.details.push(changes.version);
    if (changes.type === 'none') changes.type = 'ui_version';
  }

  // Check endpoint changes
  const prevEndpoints = new Set(previous.endpoints.map(e => e.path));
  const currEndpoints = new Set(current.endpoints.map(e => e.path));

  const added = [...currEndpoints].filter(e => !prevEndpoints.has(e));
  const removed = [...prevEndpoints].filter(e => !currEndpoints.has(e));

  if (added.length > 0) {
    changes.endpoints.push({ added: added });
    changes.details.push(`Added endpoints: ${added.join(', ')}`);
    changes.type = changes.type === 'none' ? 'added_endpoints' : changes.type;
  }
  if (removed.length > 0) {
    changes.endpoints.push({ removed: removed });
    changes.details.push(`Removed endpoints: ${removed.join(', ')}`);
    changes.type = changes.type === 'none' ? 'removed_endpoints' : changes.type;
  }

  // Check field changes
  const prevFields = new Set(previous.fields);
  const currFields = new Set(current.fields);

  const fieldAdded = [...currFields].filter(f => !prevFields.has(f));
  const fieldRemoved = [...prevFields].filter(f => !currFields.has(f));

  if (fieldAdded.length > 0) {
    changes.fields.push({ added: fieldAdded });
    changes.details.push(`Added fields: ${fieldAdded.join(', ')}`);
    changes.type = changes.type === 'none' ? 'fields_added' : changes.type;
  }
  if (fieldRemoved.length > 0) {
    changes.fields.push({ removed: fieldRemoved });
    changes.details.push(`Removed fields: ${fieldRemoved.join(', ')}`);
    changes.type = changes.type === 'none' ? 'fields_removed' : changes.type;
  }

  if (changes.type === 'none') {
    changes.details.push('No significant changes detected');
  }

  return changes;
}

export async function generateVersionReport() {
  const tracking = await trackSiteVersion();

  let report = '=== SITE VERSION TRACKING ===\n\n';

  report += `📌 Site: ${tracking.current.url}\n`;
  report += `🕐 Captured: ${new Date(tracking.current.timestamp).toLocaleString()}\n\n`;

  report += '📊 CURRENT VERSION:\n';
  report += `  API Version: ${tracking.current.version.apiVersion || 'Unknown'}\n`;
  report += `  UI Version: ${tracking.current.version.uiVersion || 'Unknown'}\n`;
  report += `  Framework: ${tracking.current.version.framework || 'Unknown'}\n`;
  report += `  Detected: ${tracking.current.version.detected.join(', ') || 'None'}\n`;
  report += `  Endpoints: ${tracking.current.endpoints.length}\n`;
  report += `  Fields: ${tracking.current.fields.join(', ')}\n\n`;

  if (tracking.changes.type !== 'none' && tracking.changes.type !== 'initial') {
    report += '🔄 CHANGES DETECTED:\n';
    for (const detail of tracking.changes.details) {
      report += `  ⚠️ ${detail}\n`;
    }
    report += '\n';
  } else if (tracking.changes.type === 'initial') {
    report += '📝 First tracking - baseline established\n\n';
  } else {
    report += '✅ No changes detected\n\n';
  }

  if (tracking.history && tracking.history.length > 1) {
    report += '📜 VERSION HISTORY:\n';
    for (const entry of tracking.history) {
      const date = new Date(entry.timestamp).toLocaleDateString();
      const time = new Date(entry.timestamp).toLocaleTimeString();
      report += `  ${date} ${time}: API ${entry.version.apiVersion || '?'} | UI ${entry.version.uiVersion || '?'}\n`;
    }
  }

  // Recommendations
  report += '\n💡 RECOMMENDATIONS:\n';
  if (tracking.changes.type === 'api_version') {
    report += '  ⚠️ API version changed - update your extractor\n';
  }
  if (tracking.changes.endpoints.some(e => e.added)) {
    report += '  💡 New endpoints discovered - consider adding them to extractor\n';
  }
  if (tracking.changes.fields.some(f => f.added)) {
    report += '  💡 New fields discovered - update data extraction\n';
  }
  if (tracking.changes.type === 'none') {
    report += '  ✅ Site appears stable - no updates needed\n';
  }

  return report;
}

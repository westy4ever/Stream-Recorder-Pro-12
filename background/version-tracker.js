// version-tracker.js - Site Version Tracking
import { state } from './state.js';

const VERSION_HISTORY_KEY = 'sr_version_history';

export function trackSiteVersion() {
  const s = state;
  const networkLog = s.networkLog || [];
  const xhrBodies = s.xhrBodies || [];

  const siteData = {
    url: getBaseUrl(),
    version: detectVersion(networkLog, xhrBodies),
    endpoints: detectEndpoints(networkLog),
    fields: detectFields(xhrBodies),
    timestamp: Date.now()
  };

  // Load history
  let history = [];
  try {
    const stored = localStorage.getItem(VERSION_HISTORY_KEY);
    if (stored) history = JSON.parse(stored);
  } catch (e) {}

  // Check for changes
  const lastVersion = history.length > 0 ? history[history.length - 1] : null;
  const changes = detectChanges(lastVersion, siteData);

  // Store new version
  history.push(siteData);
  if (history.length > 100) history = history.slice(-100);
  try {
    localStorage.setItem(VERSION_HISTORY_KEY, JSON.stringify(history));
  } catch (e) {}

  return {
    current: siteData,
    previous: lastVersion,
    changes: changes,
    history: history.slice(-10)
  };
}

function getBaseUrl() {
  try {
    const url = new URL(window.location.href);
    return `${url.protocol}//${url.hostname}`;
  } catch (e) {
    return 'unknown';
  }
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
    if (entry.responseHeaders) {
      const headers = entry.responseHeaders;
      if (headers['x-api-version']) {
        version.apiVersion = headers['x-api-version'];
        version.detected.push('api_version_header');
      }
      if (headers['x-powered-by']) {
        version.framework = headers['x-powered-by'];
        version.detected.push('x_powered_by');
      }
    }
    
    // Check URL for version
    const urlMatch = entry.url.match(/\/v(\d+)(?:\/|$)/);
    if (urlMatch) {
      version.apiVersion = 'v' + urlMatch[1];
      version.detected.push('url_version');
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
    if (entry.url.includes('/api/') || entry.url.includes('/ajax/')) {
      const url = new URL(entry.url);
      endpoints.push({
        path: url.pathname,
        method: entry.method || 'GET',
        status: entry.statusCode || 0
      });
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

export function generateVersionReport() {
  const tracking = trackSiteVersion();
  
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
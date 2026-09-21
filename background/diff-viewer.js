// diff-viewer.js - Request/Response Diff Viewer
import { state } from './state.js';

export function findRequestChanges() {
  const s = state;
  const networkLog = s.networkLog || [];
  const xhrBodies = s.xhrBodies || [];

  const groups = {};
  for (const entry of networkLog) {
    try {
      const url = new URL(entry.url);
      const pattern = url.pathname.replace(/\d+/g, '{id}').replace(/[a-f0-9]{32,}/g, '{hash}');
      const key = `${entry.method || 'GET'}:${pattern}`;
      if (!groups[key]) {
        groups[key] = {
          method: entry.method || 'GET',
          pattern: pattern,
          baseUrl: `${url.protocol}//${url.hostname}${pattern}`,
          requests: [],
          bodySamples: []
        };
      }
      groups[key].requests.push({
        url: entry.url,
        params: Object.fromEntries(url.searchParams.entries()),
        status: entry.statusCode || 0,
        timestamp: entry.timestamp || Date.now(),
        requestHeaders: entry.requestHeaders || {},
        responseHeaders: entry.responseHeaders || {}
      });
      
      const body = xhrBodies.find(b => b.url === entry.url);
      if (body) {
        groups[key].bodySamples.push({
          url: entry.url,
          body: body.body || '',
          truncated: body.truncated || false,
          timestamp: body.timestamp || Date.now()
        });
      }
    } catch (e) {}
  }

  const diffs = [];
  for (const [key, group] of Object.entries(groups)) {
    if (group.requests.length < 2) continue;

    const requests = group.requests;
    const changes = [];

    const first = requests[0];
    const last = requests[requests.length - 1];

    const firstParams = first.params || {};
    const lastParams = last.params || {};
    const allKeys = new Set([...Object.keys(firstParams), ...Object.keys(lastParams)]);
    
    for (const keyName of allKeys) {
      if (firstParams[keyName] !== lastParams[keyName]) {
        changes.push({
          type: 'param_change',
          key: keyName,
          from: firstParams[keyName] || '(missing)',
          to: lastParams[keyName] || '(missing)'
        });
      }
    }

    const firstHeaders = first.requestHeaders || {};
    const lastHeaders = last.requestHeaders || {};
    const allHeaders = new Set([...Object.keys(firstHeaders), ...Object.keys(lastHeaders)]);
    
    for (const header of allHeaders) {
      if (firstHeaders[header] !== lastHeaders[header]) {
        changes.push({
          type: 'header_change',
          key: header,
          from: firstHeaders[header] || '(missing)',
          to: lastHeaders[header] || '(missing)'
        });
      }
    }

    const firstBody = group.bodySamples.find(b => b.url === first.url);
    const lastBody = group.bodySamples.find(b => b.url === last.url);
    
    if (firstBody && lastBody) {
      const bodyDiff = compareBodies(firstBody.body, lastBody.body);
      if (bodyDiff.changed) {
        changes.push({
          type: 'body_change',
          fromLength: firstBody.body?.length || 0,
          toLength: lastBody.body?.length || 0,
          fromPreview: firstBody.body?.substring(0, 100) || '',
          toPreview: lastBody.body?.substring(0, 100) || ''
        });
      }
    }

    if (changes.length > 0) {
      diffs.push({
        endpoint: key,
        url: group.baseUrl,
        requestCount: requests.length,
        changes: changes,
        firstRequest: first,
        lastRequest: last
      });
    }
  }

  return diffs;
}

function compareBodies(body1, body2) {
  if (!body1 && !body2) return { changed: false };
  if (!body1 || !body2) return { changed: true };
  
  try {
    const json1 = JSON.parse(body1);
    const json2 = JSON.parse(body2);
    const str1 = JSON.stringify(json1);
    const str2 = JSON.stringify(json2);
    return { changed: str1 !== str2, json1, json2 };
  } catch (e) {
    return { changed: body1 !== body2 };
  }
}

export function generateDiffReport() {
  const diffs = findRequestChanges();
  let report = '=== REQUEST/RESPONSE DIFF REPORT ===\n\n';
  
  for (const diff of diffs) {
    report += `📌 ${diff.endpoint}\n`;
    report += `   URL: ${diff.url}\n`;
    report += `   Requests: ${diff.requestCount}\n`;
    report += `   Changes: ${diff.changes.length}\n`;
    
    for (const change of diff.changes) {
      switch (change.type) {
        case 'param_change':
          report += `   🔄 Parameter "${change.key}": "${change.from}" → "${change.to}"\n`;
          break;
        case 'header_change':
          report += `   🔄 Header "${change.key}": "${change.from}" → "${change.to}"\n`;
          break;
        case 'body_change':
          report += `   📄 Body: ${change.fromLength} → ${change.toLength} chars\n`;
          report += `   Preview: ${change.toPreview.substring(0, 80)}...\n`;
          break;
      }
    }
    report += '\n';
  }
  
  return report;
}
// site-comparator.js - Site Comparison Tool
import { state } from './state.js';

export function compareSites(site1Data, site2Data) {
  const site1 = analyzeSiteData(site1Data, 'Site A');
  const site2 = analyzeSiteData(site2Data, 'Site B');

  const comparison = {
    site1: site1,
    site2: site2,
    similarities: [],
    differences: [],
    recommendations: []
  };

  // Compare API formats
  if (site1.apiFormat === site2.apiFormat) {
    comparison.similarities.push(`Both use ${site1.apiFormat} API format`);
  } else {
    comparison.differences.push(`API Format: ${site1.apiFormat} vs ${site2.apiFormat}`);
  }

  // Compare endpoints
  const commonEndpoints = site1.apiEndpoints.filter(e => site2.apiEndpoints.includes(e));
  if (commonEndpoints.length > 0) {
    comparison.similarities.push(`Shared API endpoints: ${commonEndpoints.join(', ')}`);
  }

  // Compare stream hosts
  const commonHosts = site1.streamHosts.filter(h => site2.streamHosts.includes(h));
  if (commonHosts.length > 0) {
    comparison.similarities.push(`Shared stream hosts: ${commonHosts.join(', ')}`);
  } else {
    comparison.differences.push('No common stream hosts');
  }

  // Compare categories
  if (site1.categories > 0 && site2.categories > 0) {
    comparison.differences.push(`Categories: ${site1.categories} vs ${site2.categories}`);
  }

  // Compare auth
  if (site1.hasAuth === site2.hasAuth) {
    if (site1.hasAuth) {
      comparison.similarities.push('Both require authentication');
    } else {
      comparison.similarities.push('Both are public (no auth required)');
    }
  } else {
    comparison.differences.push(`Auth: ${site1.hasAuth ? 'Yes' : 'No'} vs ${site2.hasAuth ? 'Yes' : 'No'}`);
  }

  // Generate recommendations
  if (commonEndpoints.length > 2 && commonHosts.length > 1) {
    comparison.recommendations.push('Sites are very similar - use the same extractor pattern');
  } else if (commonHosts.length > 0) {
    comparison.recommendations.push('Share some stream hosts - can reuse resolver code');
  } else {
    comparison.recommendations.push('Sites are different - implement separate extractors');
  }

  return comparison;
}

function analyzeSiteData(data, name) {
  const s = state;
  const networkLog = data?.networkLog || s.networkLog || [];
  const xhrBodies = data?.xhrBodies || s.xhrBodies || [];

  const analysis = {
    name: name,
    apiFormat: 'REST',
    apiEndpoints: [],
    streamHosts: [],
    categories: 0,
    hasAuth: false,
    cloudflare: false,
    totalRequests: networkLog.length,
    avgResponseSize: 0
  };

  // Detect API format
  for (const entry of networkLog) {
    if (entry.url.includes('/api/')) {
      if (entry.url.includes('/graphql')) {
        analysis.apiFormat = 'GraphQL';
      } else if (entry.url.includes('/v2/') || entry.url.includes('/v3/')) {
        analysis.apiFormat = 'REST (v' + entry.url.match(/\/v(\d+)\//)?.[1] + ')';
      }
    }
  }

  // Extract API endpoints
  for (const entry of networkLog) {
    if (entry.url.includes('/api/') || entry.url.includes('/ajax/')) {
      const url = new URL(entry.url);
      analysis.apiEndpoints.push(url.pathname);
    }
  }
  analysis.apiEndpoints = [...new Set(analysis.apiEndpoints)];

  // Extract stream hosts
  for (const entry of networkLog) {
    if (entry.url.includes('.m3u8') || entry.url.includes('.mp4')) {
      try {
        const host = new URL(entry.url).hostname;
        analysis.streamHosts.push(host);
      } catch (e) {}
    }
  }
  analysis.streamHosts = [...new Set(analysis.streamHosts)];

  // Check for auth
  for (const entry of networkLog) {
    if (entry.requestHeaders?.authorization || entry.requestHeaders?.cookie) {
      analysis.hasAuth = true;
      break;
    }
  }

  // Check for Cloudflare
  for (const entry of networkLog) {
    if (entry.responseHeaders?.['cf-ray'] || entry.url.includes('cloudflare')) {
      analysis.cloudflare = true;
      break;
    }
  }

  // Calculate average response size
  const totalSize = xhrBodies.reduce((acc, b) => acc + (b.body?.length || 0), 0);
  analysis.avgResponseSize = xhrBodies.length > 0 ? totalSize / xhrBodies.length : 0;

  return analysis;
}

export function generateComparisonReport(site1Data, site2Data) {
  const comparison = compareSites(site1Data, site2Data);
  
  let report = '=== SITE COMPARISON TOOL ===\n\n';
  
  report += `📊 ${comparison.site1.name} vs ${comparison.site2.name}\n\n`;
  
  report += '📈 SITE 1 METRICS:\n';
  report += `  API Format: ${comparison.site1.apiFormat}\n`;
  report += `  API Endpoints: ${comparison.site1.apiEndpoints.length}\n`;
  report += `  Stream Hosts: ${comparison.site1.streamHosts.join(', ')}\n`;
  report += `  Auth Required: ${comparison.site1.hasAuth ? 'Yes' : 'No'}\n`;
  report += `  Cloudflare: ${comparison.site1.cloudflare ? 'Yes' : 'No'}\n`;
  report += `  Total Requests: ${comparison.site1.totalRequests}\n\n`;

  report += '📈 SITE 2 METRICS:\n';
  report += `  API Format: ${comparison.site2.apiFormat}\n`;
  report += `  API Endpoints: ${comparison.site2.apiEndpoints.length}\n`;
  report += `  Stream Hosts: ${comparison.site2.streamHosts.join(', ')}\n`;
  report += `  Auth Required: ${comparison.site2.hasAuth ? 'Yes' : 'No'}\n`;
  report += `  Cloudflare: ${comparison.site2.cloudflare ? 'Yes' : 'No'}\n`;
  report += `  Total Requests: ${comparison.site2.totalRequests}\n\n`;

  report += '🔍 SIMILARITIES:\n';
  if (comparison.similarities.length === 0) {
    report += '  No similarities found\n';
  } else {
    for (const sim of comparison.similarities) {
      report += `  ✅ ${sim}\n`;
    }
  }
  report += '\n';

  report += '🔄 DIFFERENCES:\n';
  if (comparison.differences.length === 0) {
    report += '  No differences found (sites are identical)\n';
  } else {
    for (const diff of comparison.differences) {
      report += `  ❌ ${diff}\n`;
    }
  }
  report += '\n';

  report += '💡 RECOMMENDATIONS:\n';
  for (const rec of comparison.recommendations) {
    report += `  💡 ${rec}\n`;
  }

  return report;
}
// cookie-analyzer.js - Cookie & Session Analyzer
import { state } from './state.js';

export function analyzeCookies() {
  const s = state;
  const networkLog = s.networkLog || [];

  const analysis = {
    cookies: [],
    sessions: [],
    authTokens: [],
    cloudflareCookies: [],
    securityHeaders: [],
    summary: {}
  };

  const cookiePatterns = {
    session: ['PHPSESSID', 'JSESSIONID', 'SESSIONID', 'session', 'sid'],
    auth: ['token', 'jwt', 'bearer', 'api_key', 'apikey', 'authorization'],
    cloudflare: ['__cf_bm', 'cf_clearance', '__cfduid', 'cf_chl'],
    analytics: ['_ga', '_gid', '_gat', 'utm_', 'fbp', 'fr'],
    csrf: ['csrf', 'xsrf', 'xsrf-token', '_token']
  };

  for (const entry of networkLog) {
    const headers = entry.requestHeaders || {};
    const responseHeaders = entry.responseHeaders || {};

    // Analyze request headers
    for (const [key, value] of Object.entries(headers)) {
      const lowerKey = key.toLowerCase();
      
      if (lowerKey === 'cookie' || lowerKey === 'set-cookie') {
        const cookies = parseCookies(value);
        for (const cookie of cookies) {
          const analysis = analyzeCookie(cookie.name, cookie.value, cookiePatterns);
          analysis.source = 'request';
          analysis.url = entry.url;
          analysis.timestamp = entry.timestamp || Date.now();
          analysis.cookies.push(analysis);
        }
      }

      if (lowerKey === 'authorization') {
        analysis.authTokens.push({
          type: 'bearer',
          value: value,
          source: 'request',
          url: entry.url,
          timestamp: entry.timestamp || Date.now()
        });
      }
    }

    // Analyze response headers
    for (const [key, value] of Object.entries(responseHeaders)) {
      const lowerKey = key.toLowerCase();
      
      if (lowerKey === 'set-cookie') {
        const cookies = parseCookies(value);
        for (const cookie of cookies) {
          const analysis = analyzeCookie(cookie.name, cookie.value, cookiePatterns);
          analysis.source = 'response';
          analysis.url = entry.url;
          analysis.timestamp = entry.timestamp || Date.now();
          analysis.cookies.push(analysis);
        }
      }

      // Security headers
      if (['x-frame-options', 'x-content-type-options', 'x-xss-protection', 'strict-transport-security'].includes(lowerKey)) {
        analysis.securityHeaders.push({
          name: key,
          value: value,
          url: entry.url
        });
      }
    }
  }

  // Generate summary
  analysis.summary = {
    totalCookies: analysis.cookies.length,
    sessionCookies: analysis.cookies.filter(c => c.type === 'session').length,
    authCookies: analysis.cookies.filter(c => c.type === 'auth').length,
    cloudflareCookies: analysis.cookies.filter(c => c.type === 'cloudflare').length,
    analyticsCookies: analysis.cookies.filter(c => c.type === 'analytics').length,
    csrfCookies: analysis.cookies.filter(c => c.type === 'csrf').length,
    authTokens: analysis.authTokens.length,
    securityHeaders: analysis.securityHeaders.length
  };

  return analysis;
}

function parseCookies(headerValue) {
  const cookies = [];
  if (!headerValue) return cookies;
  
  const parts = headerValue.split(';');
  for (const part of parts) {
    const trimmed = part.trim();
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex > 0) {
      const name = trimmed.substring(0, eqIndex).trim();
      let value = trimmed.substring(eqIndex + 1).trim();
      // Remove quotes
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }
      cookies.push({ name, value });
    }
  }
  
  return cookies;
}

function analyzeCookie(name, value, patterns) {
  const analysis = {
    name: name,
    value: value,
    type: 'unknown',
    category: 'unknown',
    secure: false,
    httponly: false,
    samesite: 'none'
  };

  const lowerName = name.toLowerCase();

  // Check session cookies
  if (patterns.session.some(p => lowerName.includes(p))) {
    analysis.type = 'session';
    analysis.category = 'session';
  }

  // Check auth cookies
  if (patterns.auth.some(p => lowerName.includes(p))) {
    analysis.type = 'auth';
    analysis.category = 'auth';
  }

  // Check Cloudflare cookies
  if (patterns.cloudflare.some(p => lowerName.includes(p))) {
    analysis.type = 'cloudflare';
    analysis.category = 'cloudflare';
  }

  // Check analytics cookies
  if (patterns.analytics.some(p => lowerName.includes(p))) {
    analysis.type = 'analytics';
    analysis.category = 'analytics';
  }

  // Check CSRF cookies
  if (patterns.csrf.some(p => lowerName.includes(p))) {
    analysis.type = 'csrf';
    analysis.category = 'csrf';
  }

  // Check security flags (if value contains)
  if (value.toLowerCase().includes('secure')) analysis.secure = true;
  if (value.toLowerCase().includes('httponly')) analysis.httponly = true;
  const sameSiteMatch = value.match(/SameSite=([^;]+)/i);
  if (sameSiteMatch) analysis.samesite = sameSiteMatch[1].toLowerCase();

  return analysis;
}

export function generateCookieReport() {
  const analysis = analyzeCookies();
  
  let report = '=== COOKIE & SESSION ANALYSIS ===\n\n';
  
  report += '📊 SUMMARY:\n';
  report += `  Total Cookies: ${analysis.summary.totalCookies}\n`;
  report += `  Session Cookies: ${analysis.summary.sessionCookies}\n`;
  report += `  Auth Cookies: ${analysis.summary.authCookies}\n`;
  report += `  Cloudflare Cookies: ${analysis.summary.cloudflareCookies}\n`;
  report += `  CSRF Tokens: ${analysis.summary.csrfCookies}\n`;
  report += `  Auth Tokens: ${analysis.summary.authTokens}\n\n`;

  // Group by URL
  const byUrl = {};
  for (const cookie of analysis.cookies) {
    const url = cookie.url || 'unknown';
    if (!byUrl[url]) byUrl[url] = [];
    byUrl[url].push(cookie);
  }

  for (const [url, cookies] of Object.entries(byUrl)) {
    report += `🍪 ${url}\n`;
    for (const cookie of cookies) {
      const icon = cookie.type === 'session' ? '🔑' :
                   cookie.type === 'auth' ? '🔐' :
                   cookie.type === 'cloudflare' ? '☁️' :
                   cookie.type === 'analytics' ? '📊' :
                   cookie.type === 'csrf' ? '🛡️' : '🍪';
      report += `  ${icon} ${cookie.name}`;
      if (cookie.secure) report += ' (Secure)';
      if (cookie.httponly) report += ' (HttpOnly)';
      if (cookie.samesite !== 'none') report += ` (SameSite: ${cookie.samesite})`;
      report += `\n`;
    }
    report += '\n';
  }

  if (analysis.authTokens.length > 0) {
    report += '🔐 AUTH TOKENS:\n';
    for (const token of analysis.authTokens) {
      report += `  Bearer ${token.value.substring(0, 20)}...\n`;
      report += `    Source: ${token.url}\n`;
    }
    report += '\n';
  }

  if (analysis.securityHeaders.length > 0) {
    report += '🛡️ SECURITY HEADERS:\n';
    for (const header of analysis.securityHeaders) {
      report += `  ${header.name}: ${header.value}\n`;
    }
    report += '\n';
  }

  // Recommendations
  report += '💡 RECOMMENDATIONS:\n';
  if (analysis.summary.sessionCookies > 0) {
    report += '  ✅ Session cookies found - extractor can maintain session\n';
  }
  if (analysis.summary.csrfCookies > 0) {
    report += '  ✅ CSRF tokens found - include in POST requests\n';
  }
  if (analysis.summary.cloudflareCookies > 0) {
    report += '  ✅ Cloudflare cookies found - need CF bypass\n';
  }
  if (analysis.summary.authCookies === 0 && analysis.summary.authTokens === 0) {
    report += '  ⚠️ No authentication found - site may be public\n';
  }

  return report;
}
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
          // [FIX] this used to be named `analysis`, exactly shadowing the outer function's
          // own `analysis` result object (the one declared at the top of analyzeCookies()
          // with .cookies/.authTokens/etc.) within this loop's block scope. The very next
          // line then called .cookies.push() on THIS shadowing variable instead -- but
          // analyzeCookie()'s return shape has no .cookies property at all, so this crashed
          // immediately with "Cannot read properties of undefined (reading 'push')" the
          // moment ANY Cookie or Set-Cookie header appeared anywhere in the network log --
          // which is virtually every request to a real website. Confirmed with a direct,
          // faithful reproduction of the exact bug. The whole cookie-analysis feature could
          // not have completed successfully on any real capture with this in place.
          const cookieAnalysis = analyzeCookie(cookie.name, cookie.value, cookiePatterns);
          cookieAnalysis.source = 'request';
          cookieAnalysis.url = entry.url;
          cookieAnalysis.timestamp = entry.timestamp || Date.now();
          analysis.cookies.push(cookieAnalysis);
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
        // [FIX] a Set-Cookie header is fundamentally different from a request Cookie header:
        // it describes exactly ONE cookie (its first name=value pair) followed by that
        // cookie's OWN attributes (Secure, HttpOnly, SameSite=..., Path=..., Domain=...,
        // Max-Age=..., Expires=...) -- not additional, separate cookies. Using the same
        // parseCookies() meant for request headers here treated every "="-containing
        // attribute as its own bogus, fake cookie -- confirmed directly: SameSite=Strict
        // produced an extra, non-existent "SameSite" cookie entry. It also meant the real
        // cookie's secure/httponly/samesite flags could never be detected at all, since
        // analyzeCookie() checked for them inside the cookie's bare VALUE (e.g. "deadbeef"),
        // which obviously never contains its own attribute words -- confirmed every real
        // cookie showed secure:false/httponly:false/samesite:none regardless of what the
        // actual header said. parseSetCookie() correctly extracts just the one real cookie
        // plus its real attributes.
        const parsed = parseSetCookie(value);
        if (parsed) {
          const cookieAnalysis = analyzeCookie(parsed.name, parsed.value, cookiePatterns, {
            secure: parsed.secure, httponly: parsed.httponly, samesite: parsed.samesite
          });
          cookieAnalysis.source = 'response';
          cookieAnalysis.url = entry.url;
          cookieAnalysis.timestamp = entry.timestamp || Date.now();
          analysis.cookies.push(cookieAnalysis);
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

// [FIX] see the [FIX] note at the Set-Cookie call site above -- a Set-Cookie header value
// describes exactly one cookie plus that cookie's own attributes, never multiple cookies.
function parseSetCookie(headerValue) {
  if (!headerValue) return null;
  const parts = headerValue.split(';').map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;

  const eqIndex = parts[0].indexOf('=');
  if (eqIndex <= 0) return null;
  const name = parts[0].substring(0, eqIndex).trim();
  let value = parts[0].substring(eqIndex + 1).trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
  }

  const cookie = { name, value, secure: false, httponly: false, samesite: null };
  for (const attr of parts.slice(1)) {
    const lowerAttr = attr.toLowerCase();
    if (lowerAttr === 'secure') cookie.secure = true;
    else if (lowerAttr === 'httponly') cookie.httponly = true;
    else if (lowerAttr.startsWith('samesite=')) cookie.samesite = attr.split('=')[1].toLowerCase();
  }
  return cookie;
}

function analyzeCookie(name, value, patterns, flags) {
  const analysis = {
    name: name,
    value: value,
    type: 'unknown',
    category: 'unknown',
    // [FIX] these used to be re-derived by searching the cookie's own bare VALUE for the
    // words "secure"/"httponly" or a "SameSite=..." fragment -- a request Cookie header
    // never carries attributes at all, and a response Set-Cookie header's attributes live
    // in the header string alongside the cookie, never inside the cookie's value itself, so
    // this could never actually detect anything real. Now takes the already correctly-parsed
    // flags from parseSetCookie() when analyzing a response cookie; a request-header cookie
    // (no flags available at all) correctly stays at these safe defaults.
    secure: (flags && flags.secure) || false,
    httponly: (flags && flags.httponly) || false,
    samesite: (flags && flags.samesite) || 'none'
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

// js-deobfuscator.js - JavaScript Deobfuscator
import { state } from './state.js';

export function deobfuscateJavaScript(code) {
  if (!code) return null;

  const result = {
    original: code,
    decoded: null,
    extractedUrls: [],
    extractedVariables: {},
    extractedFunctions: [],
    extractedAPIEndpoints: [],
    quality: 'unknown'
  };

  // Detect obfuscation type
  const obfuscationType = detectObfuscation(code);
  result.obfuscationType = obfuscationType;

  // Try different deobfuscation methods
  let decoded = null;

  // 1. P.A.C.K.E.R. detection - SIMPLIFIED
  try {
    if (code.indexOf('eval(function(p,a,c,k,e,d)') !== -1 || code.indexOf('eval(function(p,a,c,k,e') !== -1) {
      decoded = decodePacker(code);
      if (decoded) {
        result.obfuscationType = 'packer';
        result.decoded = decoded;
      }
    }
  } catch (e) {
    // Ignore
  }

  // 2. Base64 detection
  if (!decoded && (code.indexOf('atob(') !== -1 || code.indexOf('btoa(') !== -1)) {
    decoded = decodeBase64(code);
    if (decoded) {
      result.obfuscationType = 'base64';
      result.decoded = decoded;
    }
  }

  // 3. Hex encoding detection
  if (!decoded && (code.indexOf('\\x') !== -1 || code.indexOf('\\u') !== -1)) {
    decoded = decodeHex(code);
    if (decoded) {
      result.obfuscationType = 'hex';
      result.decoded = decoded;
    }
  }

  // 4. String concatenation
  if (!decoded) {
    decoded = decodeConcat(code);
    if (decoded) {
      result.obfuscationType = 'concat';
      result.decoded = decoded;
    }
  }

  // Extract URLs from decoded code
  if (decoded) {
    result.extractedUrls = extractUrls(decoded);
    result.extractedVariables = extractVariables(decoded);
    result.extractedFunctions = extractFunctions(decoded);
    result.extractedAPIEndpoints = extractAPIEndpoints(decoded);
    result.quality = 'good';
  } else {
    // Try extracting from original code
    result.extractedUrls = extractUrls(code);
    result.extractedVariables = extractVariables(code);
    result.extractedFunctions = extractFunctions(code);
    result.extractedAPIEndpoints = extractAPIEndpoints(code);
    result.quality = 'partial';
  }

  return result;
}

function detectObfuscation(code) {
  if (code.indexOf('eval(function(p,a,c,k,e,d)') !== -1) return 'packer';
  if (code.indexOf('atob(') !== -1 || code.indexOf('btoa(') !== -1) return 'base64';
  if (code.indexOf('\\x') !== -1 || code.indexOf('\\u') !== -1) return 'hex';
  if (code.indexOf('String.fromCharCode') !== -1) return 'charCode';
  if (code.match(/\+["']["']/)) return 'concat';
  if (code.match(/[\w_]+\.replace\(/)) return 'replace';
  return 'unknown';
}

function decodePacker(code) {
  try {
    const match = code.match(/eval\(function\(p,a,c,k,e,d\)\{.*?\}\(.*?\)\)/s);
    if (!match) return null;
    
    const payloadMatch = code.match(/}\((.*?)\)\)$/);
    if (payloadMatch) {
      const parts = payloadMatch[1].split(',');
      if (parts.length >= 3) {
        const urlMatches = code.match(/https?:\/\/[^\s"']+/g) || [];
        if (urlMatches.length > 0) {
          return urlMatches.join('\n');
        }
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

function decodeBase64(code) {
  try {
    const matches = code.match(/atob\(["']([A-Za-z0-9+/=]+)["']\)/g) || [];
    let result = code;
    for (const match of matches) {
      try {
        const b64Match = match.match(/atob\(["']([A-Za-z0-9+/=]+)["']\)/);
        if (b64Match) {
          const decoded = atob(b64Match[1]);
          result = result.replace(match, `"${decoded}"`);
        }
      } catch (e) {}
    }
    return result !== code ? result : null;
  } catch (e) {
    return null;
  }
}

function decodeHex(code) {
  try {
    let result = code;
    const hexMatches = code.match(/\\x([0-9a-f]{2})/g) || [];
    for (const match of hexMatches) {
      const hex = match.replace('\\x', '');
      const char = String.fromCharCode(parseInt(hex, 16));
      result = result.replace(match, char);
    }
    const uniMatches = code.match(/\\u([0-9a-f]{4})/g) || [];
    for (const match of uniMatches) {
      const hex = match.replace('\\u', '');
      const char = String.fromCharCode(parseInt(hex, 16));
      result = result.replace(match, char);
    }
    return result !== code ? result : null;
  } catch (e) {
    return null;
  }
}

function decodeConcat(code) {
  try {
    let result = code;
    const concatMatches = code.match(/["']([^"']+)["']\s*\+\s*["']([^"']+)["']/g) || [];
    for (const match of concatMatches) {
      const parts = match.match(/["']([^"']+)["']/g);
      if (parts && parts.length >= 2) {
        const combined = parts.map(p => p.slice(1, -1)).join('');
        result = result.replace(match, `"${combined}"`);
      }
    }
    return result !== code ? result : null;
  } catch (e) {
    return null;
  }
}

function extractUrls(text) {
  const urls = [];
  const patterns = [
    /https?:\/\/[^\s"']+/g,
    /["'](https?:\/\/[^"']+)["']/g,
    /`(https?:\/\/[^`]+)`/g
  ];
  
  for (const pattern of patterns) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      const url = match[1] || match[0];
      if (url && url.startsWith('http')) {
        urls.push(url);
      }
    }
  }
  
  return [...new Set(urls)];
}

function extractVariables(text) {
  const vars = {};
  const varMatches = text.match(/(?:var|let|const)\s+(\w+)\s*=\s*["']([^"']+)["']/g) || [];
  for (const match of varMatches) {
    const parts = match.match(/(?:var|let|const)\s+(\w+)\s*=\s*["']([^"']+)["']/);
    if (parts) {
      vars[parts[1]] = parts[2];
    }
  }
  return vars;
}

function extractFunctions(text) {
  const functions = [];
  const funcMatches = text.match(/function\s+(\w+)\s*\([^)]*\)\s*\{/g) || [];
  for (const match of funcMatches) {
    const name = match.match(/function\s+(\w+)/);
    if (name) {
      functions.push(name[1]);
    }
  }
  return functions;
}

function extractAPIEndpoints(text) {
  const endpoints = [];
  const patterns = [
    /["'](\/[^"']*api[^"']*)["']/gi,
    /["'](\/[^"']*ajax[^"']*)["']/gi,
    /["'](\/[^"']*wp-json[^"']*)["']/gi,
    /["'](\/[^"']*graphql[^"']*)["']/gi,
    /["'](\/[^"']*v\d[^"']*)["']/gi,
    /url\s*:\s*["']([^"']+)["']/gi
  ];
  
  for (const pattern of patterns) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      const endpoint = match[1];
      if (endpoint && !endpoint.includes('.')) {
        endpoints.push(endpoint);
      }
    }
  }
  
  return [...new Set(endpoints)];
}

export function generateDeobfuscationReport(code) {
  const result = deobfuscateJavaScript(code);
  if (!result) return 'Failed to deobfuscate JavaScript.';

  let report = '=== JAVASCRIPT DEOBFUSCATION REPORT ===\n\n';
  
  report += `🔍 Obfuscation Type: ${result.obfuscationType || 'Unknown'}\n`;
  report += `📊 Quality: ${result.quality}\n\n`;

  if (result.decoded) {
    report += '📝 DECODED CODE:\n';
    report += '```javascript\n';
    report += result.decoded.substring(0, 2000) + (result.decoded.length > 2000 ? '\n... (truncated)' : '');
    report += '\n```\n\n';
  }

  if (result.extractedUrls.length > 0) {
    report += '🔗 EXTRACTED URLS:\n';
    for (const url of result.extractedUrls) {
      report += `  ${url}\n`;
    }
    report += '\n';
  }

  if (Object.keys(result.extractedVariables).length > 0) {
    report += '📦 EXTRACTED VARIABLES:\n';
    for (const [key, value] of Object.entries(result.extractedVariables)) {
      report += `  ${key} = "${value}"\n`;
    }
    report += '\n';
  }

  if (result.extractedFunctions.length > 0) {
    report += '🔧 EXTRACTED FUNCTIONS:\n';
    for (const func of result.extractedFunctions) {
      report += `  ${func}()\n`;
    }
    report += '\n';
  }

  if (result.extractedAPIEndpoints.length > 0) {
    report += '📡 EXTRACTED API ENDPOINTS:\n';
    for (const endpoint of result.extractedAPIEndpoints) {
      report += `  ${endpoint}\n`;
    }
    report += '\n';
  }

  return report;
}
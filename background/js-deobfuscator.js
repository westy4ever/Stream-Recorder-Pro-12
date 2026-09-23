// js-deobfuscator.js - JavaScript Deobfuscator
import { state } from './state.js';

// [FIX] Real P.A.C.K.E.R. (Dean Edwards) decoder. The previous decodePacker() never actually
// ran the packer algorithm -- it just regex-scanned the still-packed text for literal
// "https://" substrings, which real packed content never contains (the URL only exists after
// token substitution runs). This is a direct port of the algorithm already verified byte-exact
// against real captured MixDrop content: decoding
//   MDCore.wurl="//ebij8ni1d.mxcontent.net/v2/pjk1dnm1i6g9qo.mp4?s=...&e=...&_t=...";
// from its packed form correctly.
class Unbaser {
  constructor(base) {
    this.base = base;
    const ALPHABET62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const ALPHABET95 = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
    if (base > 36 && base <= 62) {
      this.dict = {};
      for (let i = 0; i < base; i++) this.dict[ALPHABET62[i]] = i;
      this.mode = 'dict';
    } else if (base === 95) {
      this.dict = {};
      for (let i = 0; i < base; i++) this.dict[ALPHABET95[i]] = i;
      this.mode = 'dict';
    } else {
      this.mode = 'radix';
    }
  }
  unbase(value) {
    if (this.mode === 'radix') return parseInt(value, this.base);
    let ret = 0;
    const chars = value.split('').reverse();
    for (let i = 0; i < chars.length; i++) {
      ret += Math.pow(this.base, i) * (this.dict[chars[i]] || 0);
    }
    return ret;
  }
}

// Quote-aware string reader (handles escaped quotes inside the packed p/k strings), same as
// the Python read_js_string() this was ported from.
function readJsString(text, startIdx) {
  if (startIdx >= text.length || (text[startIdx] !== "'" && text[startIdx] !== '"')) return [null, -1];
  const quote = text[startIdx];
  let idx = startIdx + 1;
  let out = '';
  while (idx < text.length) {
    if (text[idx] === '\\' && idx + 1 < text.length) {
      out += text[idx] + text[idx + 1];
      idx += 2;
      continue;
    }
    if (text[idx] === quote) { idx++; return [out.replace(/\\(.)/g, '$1'), idx]; }
    out += text[idx];
    idx++;
  }
  return [null, -1];
}

export function decodePackerReal(packed) {
  // Finds "}(" then reads p (quoted string), ",a,c," (radix, token count), then k (quoted
  // string, split on "|"). No fixed-length window and no assumption about what comes after
  // k -- real packer output commonly adds trailing fill-args (",0,{}") before its closing
  // parens, which a fixed-tail search would miss entirely.
  try {
    const start = packed.indexOf('}(');
    if (start === -1) return null;
    let idx = start + 2;
    while (idx < packed.length && /\s/.test(packed[idx])) idx++;
    const [p, idxAfterP] = readJsString(packed, idx);
    if (p === null) return null;
    idx = idxAfterP;
    const numsMatch = packed.slice(idx).match(/^\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*/);
    if (!numsMatch) return null;
    const a = parseInt(numsMatch[1], 10);
    idx += numsMatch[0].length;
    const [kStr, idxAfterK] = readJsString(packed, idx);
    if (kStr === null) return null;
    const k = kStr.split('|');
    const unbaser = new Unbaser(a);
    return p.replace(/\b\w+\b/g, (word) => {
      const index = unbaser.unbase(word);
      return (index >= 0 && index < k.length && k[index]) ? k[index] : word;
    });
  } catch (e) {
    return null;
  }
}

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

  // 1. P.A.C.K.E.R. detection - now actually decodes it instead of scanning raw text for URLs
  try {
    if (code.indexOf('eval(function(p,a,c,k,e,d)') !== -1 || code.indexOf('eval(function(p,a,c,k,e') !== -1) {
      decoded = decodePackerReal(code);
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
    /`(https?:\/\/[^`]+)`/g,
    // [FIX] protocol-relative URLs ("//host/path") -- extremely common on exactly the sites
    // this tool targets (confirmed on MixDrop, DoodStream, and others this session). Requires
    // quotes around it, same anti-false-positive approach the https?:// patterns above already
    // use, so a stray "//" JS comment can't be mistaken for a URL.
    /["'](\/\/[a-zA-Z0-9][^\s"']*)["']/g
  ];

  for (const pattern of patterns) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      let url = match[1] || match[0];
      // [FIX] the old check (url.startsWith('http')) silently dropped every match from the
      // new protocol-relative pattern above, since "//host/..." doesn't start with "http".
      // Normalize it to a real https:// URL, the same way a browser would resolve it.
      if (url && url.startsWith('//')) {
        url = 'https:' + url;
      }
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

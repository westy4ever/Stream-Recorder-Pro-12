// export-generator.js - Generate PERFECT Python extractor code
import { state } from './state.js';
import { isArabicMovieSite, isYTSSite, isSaveFilesSite, isAdDomain } from './site-detection.js';
// [NEW] see discoverStaticConstantsFromScriptBodies()'s own comment below -- reusing
// js-deobfuscator.js's already-working extraction (URLs, variables, API endpoints) on
// scriptBodies content rather than re-implementing a second copy of the same regexes here.
import { deobfuscateJavaScript } from './js-deobfuscator.js';
// [NEW v4.5] higher-level findings (Next.js data, TMDB ids, stream origin and its
// decoder, real search, server names, trailer filtering, NovaPlay compatibility)
import { isTrailerUrl, detectNextJs, detectTmdbSite, traceStreamOrigin, findRealSearch,
         mapServerLabels, checkNovaPlayCompat, buildServerTemplate } from './site-insights.js';

// [FIX] captured category titles and URLs were embedded into generated Python source as
// plain "..." string literals -- title got a partial escape (double-quotes only, no
// backslash handling), url got none at all. Confirmed directly: a captured URL containing
// its own quote character (a real, if uncommon, possibility -- unusual query parameters,
// oddly-encoded paths) broke the generated categories.append({...}) call with a SyntaxError,
// taking down the entire generated extractor file, not just that one category. Same bug
// class already found and fixed in sequence-recorder.js/schema-generator.js/test-generator.js
// this session; reusing that same, already-proven escaping helper here.
function toPythonStringLiteral(s) {
  return "'" + String(s)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t') + "'";
}

// [FIX] a captured URL/referer/redirect-target embedded directly into a method's own
// """...""" docstring (not a real code string, just explanatory text) breaks the SAME way an
// unescaped """ already broke the generated schema dataclass/parser text and the API-
// endpoints/route-tree overview blocks below -- those three spots were already fixed with
// this exact .replace(/"""/g, "'''") neutralization, but roughly a dozen other docstring
// interpolations of real captured data (referer, search endpoint, pagination pattern,
// journey/embed stream samples, redirect from/to, mirror hosts, base64-decoded sample,
// detail-route fullUrl) never got the same treatment -- any one of those containing a literal
// """ (not impossible in an arbitrary captured URL/query-string/referer) would prematurely
// close the docstring and corrupt the rest of the generated file, exactly like the schema
// case did before it was fixed. Centralizing the fix here so every docstring interpolation of
// captured/analysis data uses the same proven neutralization instead of each repeating it
// ad-hoc (or, as happened, some forgetting it entirely).
function safeDocstringText(s) {
  return String(s).replace(/"""/g, "'''");
}

// ═══ MAIN EXPORT FUNCTIONS ═══

// [NEW] error / bot-challenge pages are not site content. A real capture's Cloudflare 502 page
// ranked ".cf-wrapper" as the top item-container selector (70%) -- pure noise.
function isErrorOrChallengeHtml(html, status) {
  if (typeof status === 'number' && status >= 400) return true;
  if (typeof html !== 'string') return false;
  return /cf-error-details|id="cf-wrapper"|class="cf-wrapper"|<title>[^<]*(?:Just a moment|Attention Required|\| \d{3}: )/i.test(html) ||
         /challenges\.cloudflare\.com\/turnstile/i.test(html) && html.length < 20000;
}

// [NEW] frameDocuments (4.3.0+): live HTML of the top page and every iframe, captured from
// the same page load as the API calls. Inline <script> blocks in it are where many players
// keep per-load config/keys (e.g. window.__EM_PLAYER__), which never appear in scriptBodies
// (those are only <script src> files). Returned in scriptBodies' shape so every existing
// script analysis (constants, stream URLs) picks them up unchanged.
function inlineScriptsFromFrameDocuments(frameDocuments) {
  const out = [];
  for (const doc of (frameDocuments || [])) {
    if (!doc || typeof doc.html !== 'string' || !doc.url) continue;
    const re = /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
    let m, i = 0;
    while ((m = re.exec(doc.html)) !== null) {
      const body = m[1].trim();
      if (body.length < 40) continue;
      if (/^\s*[{\[]/.test(body) && /application\/ld\+json/i.test(m[0])) continue; // JSON-LD metadata
      out.push({ url: `${doc.url}#inline-${++i}`, status: 200, body, inline: true });
    }
  }
  return out;
}

export function generatePythonExtractor(siteName, capturedData) {
  const result = generatePluginExtractor(siteName, capturedData);
  return result.code;
}

export function generateResolverCode(host, capturedData) {
  const s = state;
  const networkLog = capturedData?.networkLog || s.networkLog || [];
  const xhrBodies = capturedData?.xhrBodies || s.xhrBodies || [];
  // [NEW] see discoverStaticConstantsFromScriptBodies()'s own comment in
  // generatePluginExtractor() -- this single-host generator is the most direct analog to the
  // real moviesapi.to case (one host, one resolver), so it gets the same treatment: scoped to
  // just the scripts this host itself loaded.
  const frameDocuments = capturedData?.frameDocuments || s.frameDocuments || [];
  const scriptBodies = (capturedData?.scriptBodies || s.scriptBodies || [])
    .concat(inlineScriptsFromFrameDocuments(frameDocuments));

  const hostRequests = networkLog.filter(entry => {
    try {
      return new URL(entry.url).hostname.includes(host);
    } catch { return false; }
  });
  const hostScripts = scriptBodies.filter(b => {
    try {
      return b.url && new URL(b.url).hostname.includes(host);
    } catch { return false; }
  });
  const hostScriptFindings = discoverStaticConstantsFromScriptBodies(hostScripts);

  let code = `# -*- coding: utf-8 -*-\n`;
  code += `"""\n`;
  code += `Resolver for ${host}\n`;
  code += `Auto-generated by Stream Recorder Pro\n`;
  code += `"""\n\n`;

  code += `from .base import fetch, fetch_json, find_m3u8, find_mp4, log, _correct_stream_url, _is_placeholder_media_url\n\n\n`;
  code += `def resolve_${host.replace(/[^a-zA-Z0-9]/g, '_')}(url):\n`;
  code += `    """\n`;
  code += `    Resolver for ${host}.\n`;

  const getRequests = hostRequests.filter(r => r.method === 'GET' || !r.method);
  const postRequests = hostRequests.filter(r => r.method === 'POST');

  if (postRequests.length > 0) {
    code += `    Detected POST requests to this host.\n`;
  }
  if (getRequests.length > 0) {
    code += `    Detected GET requests to this host.\n`;
  }
  // [NEW] hardcoded keys/endpoints found in THIS host's own captured JS bundle(s) --
  // UNCONFIRMED guesses, same caveat as generatePluginExtractor()'s equivalent block: a
  // human still needs to check where/how the site actually sends a "possible key" before
  // using it (this is exactly how moviesapi.to's real x-player-key was found, just
  // previously only by hand).
  if (hostScriptFindings.length > 0) {
    code += `    \n`;
    code += `    DETECTED in this host's own JS bundle(s) -- UNCONFIRMED, verify before use:\n`;
    for (const f of hostScriptFindings.slice(0, 5)) {
      code += `        ${safeDocstringText(f.scriptUrl)}\n`;
      for (const k of f.possibleKeys.slice(0, 5)) {
        code += `            possible key: ${safeDocstringText(k.name)} = "${safeDocstringText(k.value)}"\n`;
      }
      for (const ep of f.apiEndpoints.slice(0, 5)) {
        code += `            possible endpoint: ${safeDocstringText(ep)}\n`;
      }
    }
  }

  code += `    """\n`;
  code += `    try:\n`;
  code += `        log("resolve_${host.replace(/[^a-zA-Z0-9]/g, '_')}: Processing {}".format(url[:100]))\n`;
  code += `        \n`;
  code += `        if '.m3u8' in url or '.mp4' in url or '.txt' in url:\n`;
  code += `            log("resolve_${host.replace(/[^a-zA-Z0-9]/g, '_')}: Direct stream URL")\n`;
  code += `            return _correct_stream_url(url)\n`;
  code += `        \n`;

  if (postRequests.length > 0) {
    const samplePost = postRequests[0];
    code += `        # POST request detected to: ${samplePost.url}\n`;
    code += `        # TODO: Implement POST-based resolution\n`;
    code += `        \n`;
  }

  if (hostScriptFindings.length > 0 && hostScriptFindings.some(f => f.possibleKeys.length > 0)) {
    code += `        # TODO: this host's own JS bundle contained a possible hardcoded\n`;
    code += `        # key/constant (see the docstring above) -- if it's a fixed auth\n`;
    code += `        # header (confirm on the real site first), add it here, e.g.:\n`;
    code += `        # extra_headers={"x-player-key": "<value from docstring above>"}\n`;
    code += `        \n`;
  }

  code += `        # Fetch the page\n`;
  code += `        html, final_url = fetch(url, referer="https://${host}/")\n`;
  code += `        if not html:\n`;
  code += `            return None\n`;
  code += `        \n`;
  code += `        # Try to find stream URL\n`;
  code += `        stream = find_m3u8(html) or find_mp4(html)\n`;
  code += `        if stream:\n`;
  code += `            return stream\n`;
  code += `        \n`;
  code += `        # TODO: Add custom extraction logic\n`;
  code += `        \n`;
  code += `        return None\n`;
  code += `    except Exception as e:\n`;
  code += `        log("resolve_${host.replace(/[^a-zA-Z0-9]/g, '_')} error: {}".format(e))\n`;
  code += `        return None\n`;

  return code;
}

export function generateCompleteExtractor(siteName, capturedData) {
  const result = generatePluginExtractor(siteName, capturedData);
  return {
    // ═══ FIX: Return filename and content separately ═══
    filename: result.filename,
    content: result.code,
    metadata: result.metadata,
    // [FIX] confirmed directly: this wrapper built its own return object
    // and silently dropped result.warnings entirely, even after it was
    // added to generatePluginExtractor() -- meaning every validation
    // warning was computed correctly and then discarded before popup.js
    // (the actual caller, via this function) ever had a chance to see
    // it. Caught by tracing the real call chain end to end rather than
    // assuming the earlier fix was already reachable.
    warnings: result.warnings,
    // [NEW] same forwarding treatment, learned from the warnings lesson
    // just above -- added at generatePluginExtractor() AND forwarded
    // here in the same pass this time, rather than discovering later
    // that this wrapper silently dropped these too.
    testCode: result.testCode,
    testFilename: result.testFilename
  };
}

// ═══ PLUGIN EXTRACTOR GENERATOR ═══

export function generatePluginExtractor(siteName, capturedData) {
  const s = state;
  const networkLog = capturedData?.networkLog || s.networkLog || [];
  const xhrBodies = capturedData?.xhrBodies || s.xhrBodies || [];
  const actions = capturedData?.actions || s.actions || [];
  const contentPipeline = capturedData?.contentPipeline || s.contentPipeline || {};
  // [NEW] confirmed directly: userJourney is a real, top-level field in
  // every capture (message-handlers.js pushes a 'stream_urls_found' event
  // into it the moment a real stream URL is detected during recording --
  // a pre-identified, high-confidence signal) but was never even passed
  // into the analysis function at all, discarding it entirely.
  const userJourney = capturedData?.userJourney || s.userJourney || [];
  // [NEW] see discoverStaticConstantsFromScriptBodies()/discoverStreamResolversFromCapturedData()'s
  // own comments below -- scriptBodies (background/script-capture.js's re-fetched <script
  // src="..."> content) was captured but never actually fed into this analysis, so a site's own
  // app bundle -- exactly where a hardcoded key like moviesapi.to's x-player-key or a decrypt/
  // signing routine actually lives -- never surfaced in a generated extractor, even once it was
  // sitting right there in the recording.
  const frameDocuments = capturedData?.frameDocuments || s.frameDocuments || [];
  const scriptBodies = (capturedData?.scriptBodies || s.scriptBodies || [])
    .concat(inlineScriptsFromFrameDocuments(frameDocuments));

  const analysis = analyzeCapturedData(networkLog, xhrBodies, actions, contentPipeline, userJourney, scriptBodies, frameDocuments);

  const code = generateFullPluginExtractor(siteName, analysis);

  // ═══ FIX: Use site name for filename ═══
  const safeName = siteName.toLowerCase().replace(/[^a-z0-9]/g, '_');

  // [NEW] confirmed directly: nothing validated the generated file's
  // correctness anywhere in this flow, not even basic syntax, before it
  // reached the developer -- this generator runs in a browser extension
  // with no real Python interpreter available, so it can never replace
  // actually running python3 -m py_compile, but it CAN check for the
  // exact, specific failure patterns already proven to happen in this
  // generator (not a general-purpose Python validator, which would be
  // its own large source of false confidence): an invalid class-name
  // identifier (the original bug that started this entire investigation,
  // on egydead.ca), a quadruple-backslash escaping smell (the regex bug
  // found and fixed earlier this session), an unclosed docstring, and a
  // bare lowercase true/false leaking from this file's own JS into the
  // generated Python (a separate, already-fixed bug documented below in
  // the metadata footer, re-checked here in case it recurs).
  const warnings = validateGeneratedCode(code);

  // [NEW] confirmed directly: test-generator.js already produces a real,
  // runnable companion test file, wired into its own separate popup
  // button, but never generated alongside the extractor itself -- the
  // same "built but never connected to this generator" pattern as
  // selector-discovery.js and schema-generator.js this session. Reuses
  // the exact className this file itself just generated (extracted from
  // the real code rather than recomputed separately, so the two can
  // never drift out of sync with each other).
  let testCode = null;
  let testFilename = null;
  const classNameForTests = code.match(/^class (\S+)\(BaseExtractor\):/m);
  if (classNameForTests) {
    testCode = generateTestsFromCapturedData(
      siteName, classNameForTests[1], safeName, networkLog, xhrBodies, contentPipeline
    );
    testFilename = `test_${safeName}_extractor.py`;
  }

  return {
    code: code,
    filename: `${safeName}_extractor.py`,  // ← FIXED: proper filename
    warnings: warnings,
    testCode: testCode,
    testFilename: testFilename,
    metadata: {
      site: siteName,
      generated: new Date().toISOString(),
      version: '4.0.0',
      analysis: analysis
    }
  };
}

function validateGeneratedCode(code) {
  const warnings = [];

  const classNameMatch = code.match(/^class (\S+)\(BaseExtractor\):/m);
  if (classNameMatch) {
    const className = classNameMatch[1];
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(className)) {
      warnings.push(
        `Class name "${className}" is not a valid Python identifier -- this WILL cause a SyntaxError. ` +
        `(This is the exact bug class that broke a real generated egydead.ca extractor.)`
      );
    }
  } else {
    warnings.push('Could not find a "class ...(BaseExtractor):" line at all -- the file may be malformed.');
  }

  if (code.includes('\\\\\\\\')) {
    warnings.push(
      'Found a 4-backslash sequence in the generated code -- likely an escaping bug where a regex ' +
      'meant to use \\b, \\s, or \\d ended up doubled. Check any regex patterns closely.'
    );
  }

  const tripleQuoteCount = (code.match(/"""/g) || []).length;
  if (tripleQuoteCount % 2 !== 0) {
    warnings.push('Found an odd number of triple-quote (""") markers -- likely an unclosed docstring.');
  }

  // [NEW v4.5] (7) check against NovaPlay's real extractors/base.py and method signatures
  for (const w of checkNovaPlayCompat(code)) warnings.push(w);

  if (/[:=]\s*(true|false)\s*[,\n]/.test(code)) {
    warnings.push(
      'Found a bare lowercase true/false -- Python needs capitalized True/False. ' +
      'This usually means a JS boolean leaked into the generated text unconverted.'
    );
  }

  return warnings;
}

// ═══ ANALYZE CAPTURED DATA ═══

// ═══ Ported from selector-discovery.js ═══
// [NEW] confirmed directly: a far more complete, already-working
// selector-discovery engine existed in this codebase the whole time
// (selector-discovery.js's discoverSelectors()) but was never imported
// or called anywhere in this file -- the earlier jsonFields/
// realClickSelectors work this session was a simpler, partial
// reinvention of something that already existed in a more thorough
// form, built without knowing this file was there. Ported rather than
// imported directly: discoverSelectors() itself reads the live `state`
// object as a global, ignoring whatever capturedData was actually
// passed into generatePluginExtractor() -- these four helpers below are
// pure functions taking explicit parameters already, with no such
// dependency, so porting them keeps correct scoping to the passed-in
// capturedData with zero behavior change to the helpers themselves.
function analyzeField(samples, field) {
  const patterns = [];
  const values = samples.filter(s => s[field]).map(s => s[field]);

  if (values.length === 0) return null;

  if (field === 'poster' && values.every(v => v.startsWith('http'))) {
    patterns.push({
      type: 'url',
      selector: 'img[src*="' + extractDomainForSelectors(values[0]) + '"]',
      confidence: 90,
      matches: values.length
    });
    patterns.push({
      type: 'url',
      selector: '.poster img, .movie-poster img',
      confidence: 75,
      matches: values.length
    });
  }

  if (field === 'title') {
    patterns.push({
      type: 'text',
      selector: '.title, .movie-title, h1, h2, h3',
      confidence: 85,
      matches: values.length
    });
    patterns.push({
      type: 'text',
      selector: '[data-title]',
      confidence: 70,
      matches: values.length
    });
  }

  if (field === 'rating' && values.some(v => /^\d+(\.\d+)?$/.test(v))) {
    patterns.push({
      type: 'text',
      selector: '.rating, .score, .vote-average',
      confidence: 80,
      matches: values.length
    });
  }

  if (field === 'year' && values.some(v => /\d{4}/.test(v))) {
    patterns.push({
      type: 'text',
      selector: '.year, .release-year, .date',
      confidence: 75,
      matches: values.length
    });
  }

  return patterns;
}

function findBestContainerSelector(samples) {
  const containers = [];
  for (const sample of samples) {
    if (sample.url) {
      const path = sample.url.split('/').filter(p => p);
      if (path.length > 0) {
        containers.push(path[0]);
      }
    }
  }

  if (containers.length === 0) return null;

  const freq = {};
  for (const c of containers) {
    freq[c] = (freq[c] || 0) + 1;
  }

  let best = null;
  let maxCount = 0;
  for (const [key, count] of Object.entries(freq)) {
    if (count > maxCount) {
      maxCount = count;
      best = key;
    }
  }

  if (best) {
    return {
      selector: '.' + best + ', #' + best,
      confidence: Math.round((maxCount / samples.length) * 100),
      matches: maxCount,
      total: samples.length
    };
  }
  return null;
}

function extractSelectorsFromHTML(html) {
  const selectors = {
    itemContainers: [],
    titles: [],
    posters: [],
    ratings: [],
    years: [],
    genres: [],
    links: []
  };

  const containerMatches = html.match(/class=["']([^"']*?(?:movie|film|torrent|item|card|wrap)[^"']*?)["']/gi) || [];
  for (const match of containerMatches) {
    const className = match.replace(/class=["']/, '').replace(/["']/, '');
    const classes = className.split(' ');
    for (const cls of classes) {
      if (cls && (cls.includes('movie') || cls.includes('film') || cls.includes('torrent') || cls.includes('card') || cls.includes('wrap'))) {
        selectors.itemContainers.push({
          selector: '.' + cls,
          confidence: 70,
          source: 'html'
        });
      }
    }
  }

  const titleMatches = html.match(/class=["']([^"']*?(?:title|name|heading)[^"']*?)["']/gi) || [];
  for (const match of titleMatches) {
    const className = match.replace(/class=["']/, '').replace(/["']/, '');
    const classes = className.split(' ');
    for (const cls of classes) {
      if (cls && (cls.includes('title') || cls.includes('name') || cls.includes('heading'))) {
        selectors.titles.push({
          selector: '.' + cls,
          confidence: 65,
          source: 'html'
        });
      }
    }
  }

  // [FIX] confirmed directly, via a real test with an actual <img
  // class="poster-img" ...> tag: this regex's full match includes the
  // leading "<img" tag-name text (it has to, since it needs to confirm
  // this class= belongs to an <img> tag specifically) -- but the
  // extraction below used to run .replace() on that FULL match text
  // rather than the regex's own capture group, leaving a literal "<img"
  // fragment in the split class list. Since "<img" contains the
  // substring "img", it then incorrectly passed the cls.includes('img')
  // check and was pushed as a bogus ".{<img}" selector candidate. None
  // of the other field regexes have this issue (they all start matching
  // at "class=" itself, with no tag-name prefix to leak) -- fixed by
  // using the regex's own capture group directly instead of the fragile
  // match-then-replace approach.
  const posterRe = /<img[^>]*class=["']([^"']*?(?:poster|thumb|img|cover)[^"']*?)["']/gi;
  let posterMatch;
  while ((posterMatch = posterRe.exec(html)) !== null) {
    const className = posterMatch[1];
    const classes = className.split(' ');
    for (const cls of classes) {
      if (cls && (cls.includes('poster') || cls.includes('thumb') || cls.includes('img') || cls.includes('cover'))) {
        selectors.posters.push({
          selector: '.' + cls,
          confidence: 65,
          source: 'html'
        });
      }
    }
  }

  const ratingMatches = html.match(/class=["']([^"']*?(?:rating|score|vote)[^"']*?)["']/gi) || [];
  for (const match of ratingMatches) {
    const className = match.replace(/class=["']/, '').replace(/["']/, '');
    const classes = className.split(' ');
    for (const cls of classes) {
      if (cls && (cls.includes('rating') || cls.includes('score') || cls.includes('vote'))) {
        selectors.ratings.push({
          selector: '.' + cls,
          confidence: 60,
          source: 'html'
        });
      }
    }
  }

  const yearMatches = html.match(/class=["']([^"']*?(?:year|date|release)[^"']*?)["']/gi) || [];
  for (const match of yearMatches) {
    const className = match.replace(/class=["']/, '').replace(/["']/, '');
    const classes = className.split(' ');
    for (const cls of classes) {
      if (cls && (cls.includes('year') || cls.includes('date') || cls.includes('release'))) {
        selectors.years.push({
          selector: '.' + cls,
          confidence: 60,
          source: 'html'
        });
      }
    }
  }

  const genreMatches = html.match(/class=["']([^"']*?(?:genre|category|tag)[^"']*?)["']/gi) || [];
  for (const match of genreMatches) {
    const className = match.replace(/class=["']/, '').replace(/["']/, '');
    const classes = className.split(' ');
    for (const cls of classes) {
      if (cls && (cls.includes('genre') || cls.includes('category') || cls.includes('tag'))) {
        selectors.genres.push({
          selector: '.' + cls,
          confidence: 55,
          source: 'html'
        });
      }
    }
  }

  const linkMatches = html.match(/href=["']([^"']*\/movie\/[^"']*)["']/gi) || [];
  for (const match of linkMatches) {
    selectors.links.push({
      selector: 'a[href*="/movie/"]',
      confidence: 80,
      source: 'html',
      matches: linkMatches.length
    });
  }

  return selectors;
}

function rankSelectorsForDiscovery(selectors) {
  const grouped = {};
  for (const s of selectors) {
    if (!grouped[s.selector]) {
      grouped[s.selector] = {
        selector: s.selector,
        confidence: 0,
        sources: [],
        matches: 0
      };
    }
    grouped[s.selector].confidence = Math.max(grouped[s.selector].confidence, s.confidence || 50);
    if (s.source) grouped[s.selector].sources.push(s.source);
    grouped[s.selector].matches++;
  }

  return Object.values(grouped).sort((a, b) => b.confidence - a.confidence);
}

function extractDomainForSelectors(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return '';
  }
}

// [NEW] mirrors selector-discovery.js's discoverSelectors() exactly, just
// taking networkLog/xhrBodies/contentPipeline/actions as explicit
// parameters (the same local variables analyzeCapturedData() already
// has) instead of reading the global `state` object.
function discoverSelectorsFromCapturedData(networkLog, xhrBodies, contentPipeline, actions, frameDocuments) {
  const selectors = {
    itemContainers: [],
    titles: [],
    posters: [],
    ratings: [],
    years: [],
    genres: [],
    descriptions: [],
    links: [],
    bestSelector: null,
    samples: {
      htmlSample: null,
      movieSample: null,
      urlSample: null
    }
  };

  for (const entry of networkLog) {
    if (entry.url && (entry.url.includes('/category/') || entry.url.includes('/movie/') || entry.url.includes('/watch/'))) {
      const body = xhrBodies.find(b => b.url === entry.url);
      if (body && body.body && body.body.length > 1000 && !isErrorOrChallengeHtml(body.body, body.status)) {
        const htmlSelectors = extractSelectorsFromHTML(body.body);
        selectors.itemContainers.push(...htmlSelectors.itemContainers);
        selectors.titles.push(...htmlSelectors.titles);
        selectors.posters.push(...htmlSelectors.posters);
        selectors.ratings.push(...htmlSelectors.ratings);
        selectors.years.push(...htmlSelectors.years);
        selectors.genres.push(...htmlSelectors.genres);
        selectors.links.push(...htmlSelectors.links);

        if (!selectors.samples.htmlSample) {
          selectors.samples.htmlSample = body.body.substring(0, 1000);
          selectors.samples.urlSample = entry.url;
        }
      }
    }
  }

  for (const body of xhrBodies) {
    if (body.body && body.body.length > 100) {
      try {
        const data = JSON.parse(body.body);
        if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object') {
          selectors.samples.movieSample = JSON.stringify(data[0], null, 2);
          for (const key of Object.keys(data[0])) {
            if (key === 'title' || key === 'name') {
              selectors.titles.push({ selector: `[data-${key}]`, confidence: 70, source: 'json', matches: data.length });
            }
            if (key === 'poster' || key === 'image' || key === 'cover') {
              selectors.posters.push({ selector: `[data-${key}]`, confidence: 70, source: 'json', matches: data.length });
            }
            if (key === 'rating' || key === 'score' || key === 'vote') {
              selectors.ratings.push({ selector: `[data-${key}]`, confidence: 70, source: 'json', matches: data.length });
            }
            if (key === 'year' || key === 'release_date') {
              selectors.years.push({ selector: `[data-${key}]`, confidence: 70, source: 'json', matches: data.length });
            }
          }
        }
      } catch (e) {
        if (body.body.includes('<div') && body.body.includes('<a') && !isErrorOrChallengeHtml(body.body, body.status)) {
          const htmlSelectors = extractSelectorsFromHTML(body.body);
          selectors.itemContainers.push(...htmlSelectors.itemContainers);
          selectors.titles.push(...htmlSelectors.titles);
          selectors.posters.push(...htmlSelectors.posters);
          selectors.ratings.push(...htmlSelectors.ratings);
          selectors.years.push(...htmlSelectors.years);
          selectors.genres.push(...htmlSelectors.genres);
          selectors.links.push(...htmlSelectors.links);
        }
      }
    }
  }

  // [NEW] the real listing/detail pages. Page HTML is a document request, which never lands
  // in xhrBodies (fetch/XHR only), so for an ordinary server-rendered site selector discovery
  // had almost no real page HTML to work from. Top frames only: iframes are players, whose
  // markup would only add noise to listing-page selectors.
  for (const doc of (frameDocuments || [])) {
    if (!doc || !doc.isTop || typeof doc.html !== 'string' || doc.html.length < 1000) continue;
    if (isErrorOrChallengeHtml(doc.html)) continue;
    const htmlSelectors = extractSelectorsFromHTML(doc.html);
    selectors.itemContainers.push(...htmlSelectors.itemContainers);
    selectors.titles.push(...htmlSelectors.titles);
    selectors.posters.push(...htmlSelectors.posters);
    selectors.ratings.push(...htmlSelectors.ratings);
    selectors.years.push(...htmlSelectors.years);
    selectors.genres.push(...htmlSelectors.genres);
    selectors.links.push(...htmlSelectors.links);
    if (!selectors.samples.htmlSample) {
      selectors.samples.htmlSample = doc.html.substring(0, 1000);
      selectors.samples.urlSample = doc.url;
    }
  }

  if (contentPipeline.movieList && contentPipeline.movieList.length > 0) {
    const samples = contentPipeline.movieList;

    const titlePatterns = analyzeField(samples, 'title');
    if (titlePatterns) selectors.titles.push(...titlePatterns);

    const posterPatterns = analyzeField(samples, 'poster');
    if (posterPatterns) selectors.posters.push(...posterPatterns);

    const ratingPatterns = analyzeField(samples, 'rating');
    if (ratingPatterns) selectors.ratings.push(...ratingPatterns);

    const yearPatterns = analyzeField(samples, 'year');
    if (yearPatterns) selectors.years.push(...yearPatterns);

    const genrePatterns = analyzeField(samples, 'genre');
    if (genrePatterns) selectors.genres.push(...genrePatterns);

    selectors.bestSelector = findBestContainerSelector(samples);
    selectors.samples.movieSample = JSON.stringify(samples[0], null, 2);
  }

  for (const action of actions) {
    if (action.href && action.href.includes('/category/')) {
      selectors.links.push({ selector: `a[href*="/category/"]`, confidence: 80, source: 'action', matches: 1 });
    }
    if (action.href && action.href.includes('/movie/')) {
      selectors.links.push({ selector: `a[href*="/movie/"]`, confidence: 80, source: 'action', matches: 1 });
    }
  }

  selectors.itemContainers = rankSelectorsForDiscovery(selectors.itemContainers);
  selectors.titles = rankSelectorsForDiscovery(selectors.titles);
  selectors.posters = rankSelectorsForDiscovery(selectors.posters);
  selectors.ratings = rankSelectorsForDiscovery(selectors.ratings);
  selectors.years = rankSelectorsForDiscovery(selectors.years);
  selectors.genres = rankSelectorsForDiscovery(selectors.genres);
  selectors.links = rankSelectorsForDiscovery(selectors.links);

  return selectors;
}

// ═══ Ported from schema-generator.js ═══
// [NEW] confirmed directly: generateSchema() is a completely pure
// function (no `state` dependency at all -- only generateSchemaReport(),
// which this doesn't need, touches state), already wired into its own
// separate popup button, but never connected to this generator's own
// output at all. Ported verbatim rather than imported, for the same
// module-boundary-safety reasons as selector-discovery.js, even though
// this one has no state dependency to worry about -- keeping the
// integration pattern consistent across both ports.
function analyzeSchemaObject(obj, name) {
  const schema = {
    name: name,
    type: 'object',
    fields: [],
    optional: false
  };

  if (Array.isArray(obj)) {
    schema.type = 'array';
    if (obj.length > 0) {
      schema.items = analyzeSchemaObject(obj[0], name + 'Item');
    }
    return schema;
  }

  if (typeof obj !== 'object' || obj === null) {
    return {
      name: name,
      type: typeof obj,
      value: obj,
      optional: false
    };
  }

  for (const [key, value] of Object.entries(obj)) {
    const field = {
      name: key,
      type: getSchemaFieldType(value),
      optional: false,
      sample: value
    };

    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      field.nested = analyzeSchemaObject(value, key.charAt(0).toUpperCase() + key.slice(1));
    } else if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object') {
      field.nested = analyzeSchemaObject(value[0], key.charAt(0).toUpperCase() + key.slice(1));
      field.type = 'List[' + field.nested.name + ']';
    }

    schema.fields.push(field);
  }

  return schema;
}

function getSchemaFieldType(value) {
  if (value === null) return 'Optional[Any]';
  if (Array.isArray(value)) {
    if (value.length === 0) return 'List[Any]';
    return 'List[' + getSchemaFieldType(value[0]) + ']';
  }
  if (typeof value === 'object') return 'dict';
  if (typeof value === 'string') {
    if (value.match(/^\d{4}-\d{2}-\d{2}/)) return 'datetime';
    if (value.match(/^https?:\/\//)) return 'str'; // URL
    return 'str';
  }
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return 'int';
    return 'float';
  }
  if (typeof value === 'boolean') return 'bool';
  return 'Any';
}

function generateSchemaDataclass(schema, isTopLevel = true) {
  if (!schema || schema.type === 'array') {
    return generateSchemaDataclassArray(schema, isTopLevel);
  }

  let nestedCode = '';
  for (const field of schema.fields) {
    if (field.nested && field.nested.type === 'object') {
      nestedCode += generateSchemaDataclass(field.nested, false) + '\n\n';
    }
  }

  let classCode = `@dataclass\n`;
  classCode += `class ${schema.name}:\n`;

  for (const field of schema.fields) {
    const fieldType = field.type || 'Any';
    const isOptional = field.sample === null || field.sample === undefined;

    if (isOptional) {
      const optionalType = fieldType.startsWith('Optional[') ? fieldType : `Optional[${fieldType}]`;
      classCode += `    ${field.name}: ${optionalType} = None\n`;
    } else {
      const defaultValue = getSchemaDefaultValue(field.sample, fieldType);
      if (defaultValue !== null) {
        classCode += `    ${field.name}: ${fieldType} = ${defaultValue}\n`;
      } else {
        classCode += `    ${field.name}: Optional[${fieldType}] = None\n`;
      }
    }
  }

  if (isTopLevel) {
    let header = 'from dataclasses import dataclass\n';
    header += 'from typing import List, Optional, Any\n\n\n';
    return header + nestedCode + classCode;
  }
  return nestedCode + classCode;
}

function generateSchemaDataclassArray(schema, isTopLevel = true) {
  if (!schema || !schema.items) return '';

  let itemsCode = '';
  if (schema.items) {
    itemsCode = generateSchemaDataclass(schema.items, false) + '\n\n';
  }

  let classCode = `@dataclass\n`;
  classCode += `class ${schema.name}:\n`;
  classCode += `    items: List[${schema.items.name || 'Any'}]\n`;

  if (isTopLevel) {
    let header = 'from dataclasses import dataclass\n';
    header += 'from typing import List, Optional, Any\n\n\n';
    return header + itemsCode + classCode;
  }
  return itemsCode + classCode;
}

function getSchemaDefaultValue(sample, type) {
  if (sample === null || sample === undefined) return null;
  // [FIX] confirmed directly, via a real test with a realistic title
  // containing its own embedded quote (e.g. Movie: "The Reckoning"):
  // this embedded the sample directly as "${sample}" with zero escaping,
  // producing name: str = "Movie: "The Reckoning"" -- genuinely invalid
  // Python the instant anyone uncommented and tried to use this
  // reference code, exactly as it's designed to be used. Didn't surface
  // as a compile failure only because this whole block is currently
  // emitted as a # comment, which Python never parses as code at all --
  // the bug was real regardless. Reuses the same proven escaping helper
  // (toPythonStringLiteralForTests, defined below) already fixing this
  // exact bug class elsewhere in this file, rather than duplicating
  // ad-hoc escaping logic.
  if (type === 'str') return toPythonStringLiteralForTests(sample);
  if (type === 'int' || type === 'float') return String(sample);
  if (type === 'bool') return sample ? 'True' : 'False';
  if (type === 'List') return '[]';
  if (type === 'dict') return '{}';
  return null;
}

function generateSchemaParserCode(schema) {
  if (!schema) return '';

  let code = 'def parse_response(data):\n';
  code += '    """Parse API response into dataclass."""\n';
  code += '    if not data:\n';
  code += '        return None\n';
  code += '    \n';
  code += `    return ${schema.name}(\n`;

  for (const field of schema.fields) {
    const fieldName = field.name;
    // [FIX] confirmed directly, via a real test with an array-of-objects
    // field (e.g. "genres": [{...}, {...}]): field.nested gets set the
    // same way for BOTH a genuine single nested object (e.g.
    // "primary_video": {...}) and a list of nested objects, since both
    // are analyzed by calling analyzeObject() on one representative
    // object either way -- so this check alone can't tell them apart.
    // The old code always took the single-object branch in both cases,
    // generating "parse_genres(data.get(\"genres\", {}))" for a field
    // that's actually a list: wrong default ({} instead of []) and a
    // call to a parse_genres() function that's never defined anywhere in
    // the output. field.type already correctly distinguishes the two
    // cases ("List[Genres]" vs just "PrimaryVideo"), so checking that
    // first instead fixes both the list case and leaves the genuine
    // single-nested-object case working exactly as before.
    if (field.type && field.type.startsWith('List')) {
      code += `        ${fieldName}=data.get("${fieldName}", []),\n`;
    } else if (field.nested && field.nested.type === 'object') {
      code += `        ${fieldName}=parse_${fieldName}(data.get("${fieldName}", {})),\n`;
    } else if (field.type === 'datetime') {
      code += `        ${fieldName}=datetime.fromisoformat(data.get("${fieldName}")) if data.get("${fieldName}") else None,\n`;
    } else {
      code += `        ${fieldName}=data.get("${fieldName}"),\n`;
    }
  }

  code += '    )\n';
  return code;
}

function generateSchemaFromCapturedData(sampleData) {
  if (!sampleData) return null;
  let data = sampleData;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch (e) {
      return null;
    }
  }
  const schema = analyzeSchemaObject(data, 'Response');
  return {
    dataclass: generateSchemaDataclass(schema),
    parserCode: generateSchemaParserCode(schema)
  };
}

// ═══ Ported from test-generator.js ═══
// [NEW] confirmed directly: generateTests() already takes an explicit
// capturedData parameter (falling back to live `state` only when it's
// not provided), already wired into its own separate popup button, and
// already produces a real, runnable unittest.TestCase that exercises the
// extractor's actual methods against real captured sample URLs -- a
// genuinely different kind of check than validateGeneratedCode()'s
// static syntax patterns, catching runtime/logic issues instead. Ported
// (not imported) for the same module-boundary-safety consistency as the
// other two ports this session. toPythonStringLiteral's own quote/
// backslash escaping is carried over verbatim -- it already has its own
// confirmed fix for exactly the kind of embedding risk the schema
// dataclass embedding above just hit.
function toPythonStringLiteralForTests(s) {
  return "'" + String(s)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t') + "'";
}

function generateTestsFromCapturedData(siteName, className, safeName, networkLog, xhrBodies, contentPipeline) {
  // [FIX] siteName is developer-typed, not scraped from a site -- lower risk than the
  // captured-data escaping this file already does elsewhere, but still gets interpolated
  // directly into real double-quoted Python string literals below (log("Running tests for
  // ${siteName}")); a name containing a literal " or \ would still break the generated file,
  // same bug class, just a less likely trigger. Escaped once here for every log() call below
  // that embeds it mid-string, consistent with how every other embedded value in this file
  // is treated.
  const siteNameDQ = String(siteName)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  const testData = {
    // [FIX] confirmed directly, via a real test with no captured
    // samples at all: these used to fall back to a hardcoded, generic
    // placeholder URL ('/category/english-movies/', '/movie/example')
    // that has no reason to exist on whatever real site this test is
    // actually for -- and since that fallback value is never falsy, the
    // template's own "else" branch below (querying the site's real
    // categories/items dynamically at test time, which is clearly
    // already written and intended for exactly this situation) could
    // never actually run. Left undefined instead when no real sample
    // exists, so that already-written dynamic-query path is the one
    // that actually executes.
    sampleCategory: contentPipeline.movieList?.[0]?.url || null,
    sampleMovie: contentPipeline.movieList?.[0]?.url || null,
    sampleSearch: contentPipeline.movieList?.[0]?.title || 'avengers',
    sampleStream: null
  };

  for (const body of xhrBodies) {
    if (body.body && (body.body.includes('.m3u8') || body.body.includes('.mp4'))) {
      const urls = body.body.match(/https?:\/\/[^\s"']+\.(?:m3u8|mp4)[^\s"']*/g) || [];
      if (urls.length > 0) {
        testData.sampleStream = urls[0];
        break;
      }
    }
  }

  let code = `# -*- coding: utf-8 -*-\n`;
  code += `"""\n`;
  code += `Unit tests for ${siteName} extractor.\n`;
  code += `Auto-generated by Stream Recorder Pro\n`;
  code += `Generated: ${new Date().toISOString()}\n`;
  code += `"""\n\n`;

  code += `import unittest\n`;
  code += `import sys\n`;
  code += `import os\n\n`;
  code += `# Add parent directory to path\n`;
  code += `sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))\n\n`;
  code += `from extractors.${safeName} import ${className}\n`;
  code += `from extractors.base import fetch, log\n\n\n`;

  code += `class Test${className}(unittest.TestCase):\n`;
  code += `    """Test suite for ${siteName} extractor."""\n\n`;

  code += `    def setUp(self):\n`;
  code += `        """Set up test environment."""\n`;
  code += `        self.extractor = ${className}()\n`;
  code += `        log("Running tests for ${siteNameDQ}")\n\n`;

  code += `    def test_get_categories(self):\n`;
  code += `        """Test getting categories from ${siteName}."""\n`;
  code += `        categories = self.extractor.get_categories("movie")\n`;
  code += `        self.assertIsInstance(categories, list)\n`;
  code += `        if categories:\n`;
  code += `            self.assertIn("title", categories[0])\n`;
  code += `            self.assertIn("url", categories[0])\n`;
  code += `        log(f"Found {len(categories)} categories")\n`;
  code += `\n`;

  code += `    def test_get_category_items(self):\n`;
  code += `        """Test getting category items from ${siteName}."""\n`;
  code += `        categories = self.extractor.get_categories("movie")\n`;
  code += `        if not categories:\n`;
  code += `            self.skipTest("No categories available")\n`;
  if (testData.sampleCategory) {
    code += `        # Use captured sample category URL\n`;
    code += `        url = ${toPythonStringLiteralForTests(testData.sampleCategory)}\n`;
  } else {
    code += `        url = categories[0].get("url")\n`;
  }
  code += `        items = self.extractor.get_category_items(url, page=1)\n`;
  code += `        self.assertIsInstance(items, list)\n`;
  code += `        if items:\n`;
  code += `            self.assertIn("title", items[0])\n`;
  code += `            self.assertIn("url", items[0])\n`;
  code += `        log(f"Found {len(items)} category items")\n`;
  code += `\n`;

  code += `    def test_search(self):\n`;
  code += `        """Test searching on ${siteName}."""\n`;
  if (testData.sampleSearch) {
    code += `        query = ${toPythonStringLiteralForTests(testData.sampleSearch)}\n`;
  } else {
    code += `        query = "test"\n`;
  }
  code += `        results = self.extractor.search(query)\n`;
  code += `        self.assertIsInstance(results, list)\n`;
  code += `        if results:\n`;
  code += `            self.assertIn("title", results[0])\n`;
  code += `            self.assertIn("url", results[0])\n`;
  code += `        log(f"Found {len(results)} search results")\n`;
  code += `\n`;

  code += `    def test_get_page(self):\n`;
  code += `        """Test getting detail page from ${siteName}."""\n`;
  code += `        # Get a movie from category\n`;
  code += `        categories = self.extractor.get_categories("movie")\n`;
  code += `        if not categories:\n`;
  code += `            self.skipTest("No categories available")\n`;
  if (testData.sampleMovie) {
    code += `        # Use captured sample movie URL\n`;
    code += `        url = ${toPythonStringLiteralForTests(testData.sampleMovie)}\n`;
  } else {
    code += `        items = self.extractor.get_category_items(categories[0].get("url"), page=1)\n`;
    code += `        if not items:\n`;
    code += `            self.skipTest("No items available")\n`;
    code += `        url = items[0].get("url")\n`;
  }
  code += `        data = self.extractor.get_page(url)\n`;
  code += `        self.assertIsInstance(data, dict)\n`;
  code += `        self.assertIn("title", data)\n`;
  code += `        self.assertIn("servers", data)\n`;
  code += `        log(f"Found page: {data.get('title', 'Unknown')}")\n`;
  code += `\n`;

  code += `    def test_extract_stream(self):\n`;
  code += `        """Test stream extraction from ${siteName}."""\n`;
  if (testData.sampleStream) {
    code += `        # Use captured sample stream URL\n`;
    code += `        url = ${toPythonStringLiteralForTests(testData.sampleStream)}\n`;
  } else {
    code += `        # Get a server URL from a detail page\n`;
    code += `        categories = self.extractor.get_categories("movie")\n`;
    code += `        if not categories:\n`;
    code += `            self.skipTest("No categories available")\n`;
    code += `        items = self.extractor.get_category_items(categories[0].get("url"), page=1)\n`;
    code += `        if not items:\n`;
    code += `            self.skipTest("No items available")\n`;
    code += `        data = self.extractor.get_page(items[0].get("url"))\n`;
    code += `        if not data.get("servers"):\n`;
    code += `            self.skipTest("No servers available")\n`;
    code += `        url = data["servers"][0].get("url")\n`;
  }
  code += `        result = self.extractor.extract_stream(url)\n`;
  code += `        self.assertIsNotNone(result)\n`;
  code += `        stream_url = result[0] if result else None\n`;
  code += `        if stream_url:\n`;
  code += `            self.assertTrue(stream_url.startswith("http"))\n`;
  code += `            self.assertIn(".m3u8", stream_url.lower())\n`;
  code += `            log(f"Found stream: {stream_url[:80]}...")\n`;
  code += `        else:\n`;
  code += `            log("No stream found")\n`;
  code += `\n`;

  code += `    def test_metadata(self):\n`;
  code += `        """Test extractor metadata."""\n`;
  code += `        self.assertTrue(hasattr(self.extractor, "main_url"))\n`;
  code += `        self.assertTrue(hasattr(self.extractor, "base_url"))\n`;
  code += `        self.assertTrue(self.extractor.main_url)\n`;
  code += `        log(f"Main URL: {self.extractor.main_url}")\n`;
  code += `\n`;

  code += `\nif __name__ == "__main__":\n`;
  code += `    unittest.main()\n`;

  return code;
}

// ═══ Ported from spa-route-mapper.js ═══
// [NEW] confirmed directly: this classifies real captured navigation
// into route types (home/category/detail/search/page) that nothing else
// in this generator does -- deliberately NOT porting api-discoverer.js
// or route-discoverer.js alongside it, since both overlap heavily with
// this generator's own existing, already-tested category-pattern
// detection (and with each other); replacing proven, working logic with
// an unverified port risked a real regression for no confirmed gain.
// This one is additive and genuinely complementary instead. Carries over
// its own already-confirmed real bug fix verbatim: a click action's own
// "url" field is the page the click happened ON, while "href" is the
// clicked link's actual destination -- for a click specifically, href
// must be preferred, or every click just re-records the already-known
// current page instead of the destination being discovered.
function mapSPARoutesFromCapturedData(actions) {
  const routes = [];
  const seen = new Set();

  const navActions = actions.filter(a =>
    a.type === 'spa_navigate' || a.type === 'navigate' || a.type === 'click'
  );

  for (const action of navActions) {
    try {
      const resolvedUrl = action.type === 'click'
        ? (action.href || action.url || '')
        : (action.url || action.href || '');
      const url = new URL(resolvedUrl);
      const path = url.pathname;
      const route = {
        path: path,
        fullUrl: resolvedUrl,
        type: action.type,
        selector: action.selector || 'auto'
      };

      const paramMatch = path.match(/\/([^\/]+)\/(\d+)/);
      if (paramMatch) {
        route.routeType = 'detail';
        route.routeKey = paramMatch[1];
        route.routeId = paramMatch[2];
      } else if (path.includes('/category/') || path.includes('/genre/')) {
        route.routeType = 'category';
      } else if (path.includes('/search')) {
        route.routeType = 'search';
      } else if (path === '/' || path === '') {
        route.routeType = 'home';
      } else {
        route.routeType = 'page';
      }

      const routeKey = route.path;
      if (!seen.has(routeKey)) {
        seen.add(routeKey);
        routes.push(route);
      }
    } catch (e) { /* not a parseable absolute URL -- skip */ }
  }

  return routes;
}

// ═══ Ported from api-discoverer.js ═══
// [NEW] confirmed directly: discoverStreamResolvers() is genuinely new,
// non-overlapping information -- not another category/API-pattern
// detector (which is why discoverAPIEndpoints() and discoverSiteStructure()
// from this same file, and all of route-discoverer.js, were deliberately
// left alone: they overlap too heavily with this generator's own
// existing, already-tested category-pattern detection to integrate
// safely). This groups real captured stream URLs by HOST, with the
// REAL referer(s) and URL pattern(s) confirmed for each one specifically
// -- more precise than this generator's existing single, site-wide
// refererSample, since different hosts were directly confirmed tonight
// to sometimes need different referers from each other.
// [FIX] confirmed directly, by comparing against popup.js's own real
// "copy stream links" feature (getStreamLinks in message-handlers.js, a
// separate, already-working, more refined detector): this function's own
// URL matching was narrower (only .m3u8/.mp4) and had no segment-URL
// exclusion at all, which matters a lot -- a real HLS stream generates
// hundreds of tiny .ts segment-chunk URLs, which would otherwise flood
// perHostStreamInfo with noise instead of the one meaningful master/
// playlist URL per host. Replaced with the same, already-proven pattern
// set (adds .ts/.txt extensions and /hls<N>/ paths, plus a Content-Type
// header fallback for streams with no recognizable extension at all) and
// the same segment exclusion, carried over from that working feature
// rather than re-derived independently.
const urlPattern = /\.(m3u8|mp4|ts|txt)(\?|$)|\/hls\d?\//i;
const contentTypePattern = /video\/|mpegurl|application\/x-mpegurl/i;
const isSegmentUrl = (u) => /\/seg-\d+-/i.test(u);
// [FIX-adjunk] same fix as message-handlers.js's getStreamLinks: require a
// real path (not just a bare host whose TLD happens to spell a media
// extension, e.g. "https://pool.ts" -- .ts is a real ccTLD) before this
// counts as a candidate stream URL, and skip known ad/analytics hosts plus
// the S3-path-style "files.prebid.org" bucket-name trick. This feeds
// generated resolver code, so a false positive here is worse than noise --
// it produces a bogus resolver stub for an ad domain.
const bodyUrlPattern = /https?:\/\/[^\s"'<>\\]+?\/[^\s"'<>\\]*?\.(?:m3u8|mp4|ts|txt)(?:\?[^\s"'<>\\]*)?/gi;
const isAdOrJunkUrl = (u) => isAdDomain(u) || /prebid/i.test(u);

function discoverStreamResolversFromCapturedData(networkLog, xhrBodies, scriptBodies) {
  const streamUrls = [];
  for (const entry of networkLog) {
    if (!entry.url || isSegmentUrl(entry.url) || isAdOrJunkUrl(entry.url)) continue;
    const ct = entry.responseHeaders && (entry.responseHeaders['content-type'] || entry.responseHeaders['Content-Type']);
    const matches = urlPattern.test(entry.url) || (ct && contentTypePattern.test(ct));
    if (matches) {
      streamUrls.push({
        url: entry.url,
        referer: entry.referer || entry.initiator || '',
        status: entry.statusCode || 0
      });
    }
  }

  for (const body of xhrBodies) {
    if (!body.body) continue;
    const matches = body.body.match(bodyUrlPattern) || [];
    for (const rawUrl of matches) {
      const url = rawUrl.replace(/\\\//g, '/');
      if (isSegmentUrl(url) || isAdOrJunkUrl(url)) continue;
      streamUrls.push({
        url: url,
        referer: body.url || '',
        status: body.status || 0
      });
    }
  }

  // [NEW] same bodyUrlPattern scan as xhrBodies just above, now also run over scriptBodies
  // (background/script-capture.js's re-fetched <script src="..."> content) -- a site's own
  // app bundle can embed a literal stream URL (a hardcoded fallback/default, a CDN base,
  // a sample used during a signing routine) the same way an XHR JSON response can, and
  // there was previously no path for that to reach this host list at all.
  for (const body of (scriptBodies || [])) {
    if (!body.body) continue;
    const matches = body.body.match(bodyUrlPattern) || [];
    for (const rawUrl of matches) {
      const url = rawUrl.replace(/\\\//g, '/');
      if (isSegmentUrl(url) || isAdOrJunkUrl(url)) continue;
      streamUrls.push({
        url: url,
        referer: body.url || '',
        status: body.status || 0
      });
    }
  }

  const byHost = {};
  for (const stream of streamUrls) {
    try {
      const host = new URL(stream.url).hostname;
      if (!byHost[host]) {
        byHost[host] = {
          host: host,
          urls: [],
          referers: new Set(),
          patterns: new Set()
        };
      }
      byHost[host].urls.push(stream.url);
      if (stream.referer) byHost[host].referers.add(stream.referer);
      byHost[host].patterns.add(stream.url.replace(/\d+/g, '{id}').replace(/[a-f0-9]{32,}/g, '{hash}'));
    } catch (e) { /* not a parseable absolute URL -- skip */ }
  }

  return Object.values(byHost).map(h => ({
    host: h.host,
    urls: h.urls,
    referers: [...h.referers],
    patterns: [...h.patterns]
  }));
}

// [NEW] this is the other half of wiring scriptBodies into this generator (see
// discoverStreamResolversFromCapturedData above for the stream-URL half). A site's own app
// bundle is exactly where a hardcoded signing/auth constant lives -- confirmed directly on a
// real site this session: moviesapi.to's x-player-key header turned out to be a plain
// hardcoded JS string literal (`var fz = "<64-hex-char value>"`), not a per-session token, and
// was only found because its actual JS bundle was manually supplied and read by hand. With
// scriptBodies now captured automatically, this does that same kind of read automatically on
// every recording, instead of needing a one-off manual JS dump every time a new site needs it.
// Reuses js-deobfuscator.js's deobfuscateJavaScript() (URL/variable/API-endpoint extraction)
// rather than re-implementing a second copy of the same regexes here. Only returns an entry
// for a script where something was actually found, to avoid drowning the real finds in noise
// from the 20-60+ small webpack/CSS-module shims a modern SPA can load per page.
// [NEW] values that look like secret keys but are public constants built into every video
// player: the DRM system IDs (a real vidcore.io capture flagged Widevine's as a "possible key").
const KNOWN_NON_SECRET_HEX = new Set([
  'edef8ba979d64acea3c827dcd51d21ed', // Widevine system ID
  '9a04f07998404286ab92e65be0885f95', // PlayReady system ID
  '94ce86fb07ff4f43adb893d2fa968ca2', // FairPlay system ID
  '1077efecc0b24d02ace33c1e52e2fb4b', // W3C ClearKey system ID
  'e2719d58a985b3c9781ab030af78d30e'  // ClearKey (alt)
]);

// [NEW] spec/docs/framework URLs that appear in every bundle and never matter for extraction
// (a real capture listed w3.org, nextjs.org, react.dev, aomedia.org and ad-network URLs).
const NOISE_URL_HOSTS = ['w3.org', 'nextjs.org', 'react.dev', 'reactjs.org', 'aomedia.org',
  'schema.org', 'mozilla.org', 'developer.mozilla.org', 'github.com', 'npmjs.com',
  'googleapis.com', 'gstatic.com', 'apple.com', 'microsoft.com', 'hlsjs.video-dev.org',
  'video-dev.org', 'dashif.org', 'mpeg.org', 'ietf.org', 'whatwg.org', 'example.com'];
function isNoiseUrl(u) {
  try {
    const host = new URL(u).hostname.toLowerCase();
    if (!host || host.length < 4 || !host.includes('.')) return true;   // "http://n" etc.
    if (NOISE_URL_HOSTS.some(h => host === h || host.endsWith('.' + h))) return true;
    if (typeof isAdDomain === 'function' && isAdDomain(u)) return true;
    if (/cpm|adnetwork|popads|propeller|adsterra|profitable/i.test(host)) return true;
    return false;
  } catch (e) {
    return true;
  }
}

function discoverStaticConstantsFromScriptBodies(scriptBodies) {
  const findings = [];
  for (const script of (scriptBodies || [])) {
    if (!script.body) continue;
    let result;
    try {
      result = deobfuscateJavaScript(script.body);
    } catch (e) {
      continue;
    }
    if (!result) continue;

    // Variables whose value looks like a fixed auth/signing constant: a long hex string
    // (the exact shape of moviesapi.to's real x-player-key) is the strongest, lowest-noise
    // signal available without actually understanding the site-specific code -- a short or
    // mixed-content value is far more likely to be an ordinary UI string, so this
    // deliberately stays conservative rather than flooding results with false positives.
    const possibleKeys = Object.entries(result.extractedVariables || {})
      .filter(([, value]) => typeof value === 'string' && /^[a-f0-9]{24,}$/i.test(value))
      .filter(([, value]) => !KNOWN_NON_SECRET_HEX.has(value.toLowerCase()))
      .map(([name, value]) => ({ name, value }));

    const apiEndpoints = (result.extractedAPIEndpoints || []).slice(0, 10);
    const notableUrls = (result.extractedUrls || []).filter(u => !isNoiseUrl(u)).slice(0, 10);

    if (possibleKeys.length === 0 && apiEndpoints.length === 0 && notableUrls.length === 0) continue;

    findings.push({
      scriptUrl: script.url || '',
      possibleKeys,
      apiEndpoints,
      notableUrls
    });
  }
  return findings;
}

// [NEW] confirmed directly, with a real grep against this entire file
// before porting: nothing anywhere here detects /api/, /ajax/,
// /wp-json/, /graphql, or similar API-shaped URLs at all -- this
// generator's existing category detection is about LISTING-PAGE shapes
// (/category/, /genre/, etc.), a genuinely different thing, not a
// duplicate of this. Groups real captured API-shaped requests by
// method+path (numeric ids and long hashes normalized to {id}/{hash}
// placeholders), with real sample params -- confirming the exact
// parameterized endpoint shapes a site actually uses, beyond just its
// listing/category URLs.
function discoverAPIEndpointsFromCapturedData(networkLog) {
  const endpoints = [];

  for (const entry of networkLog) {
    try {
      const url = new URL(entry.url);
      const isAPI = (
        entry.url.includes('/api/') ||
        entry.url.includes('/ajax/') ||
        entry.url.includes('/wp-json/') ||
        entry.url.includes('/graphql') ||
        entry.url.includes('.json') ||
        entry.url.includes('/v2/') ||
        entry.url.includes('/v3/') ||
        entry.url.includes('/rest/') ||
        entry.url.includes('/service/')
      );

      if (isAPI) {
        endpoints.push({
          url: entry.url,
          method: entry.method || 'GET',
          params: Object.fromEntries(url.searchParams.entries()),
          // [FIX] confirmed directly, with a real test against
          // "/api/v1/channel/2": the plain /\d+/g replacement below
          // treated "v1"'s own digit the same as a real resource id,
          // normalizing to "/api/v{id}/channel/{id}" -- a site with
          // multiple live API versions (v1 and v2 of the same endpoint)
          // would then be incorrectly grouped as "the same" endpoint
          // pattern. A negative lookbehind excludes a digit run
          // immediately preceded by "v" (an API version segment) from
          // the generic id-placeholder substitution, leaving every
          // other numeric id correctly normalized exactly as before.
          pathPattern: url.pathname.replace(/(^|\/)\d+(?=\/|\.|$)/g, '$1{id}').replace(/[a-f0-9]{32,}/g, '{hash}')  // [FIX v4.5] whole numeric segments only (a Next.js build id like PHsm1fHs... was mangled)
        });
      }
    } catch (e) { /* not a parseable absolute URL -- skip */ }
  }

  const grouped = {};
  for (const endpoint of endpoints) {
    const key = `${endpoint.method}:${endpoint.pathPattern}`;
    if (!grouped[key]) {
      grouped[key] = {
        method: endpoint.method,
        pattern: endpoint.pathPattern,
        sampleUrl: endpoint.url,
        sampleParams: endpoint.params
      };
    }
  }

  return Object.values(grouped);
}

// ═══ Ported from route-discoverer.js ═══
// [NEW] a whole-site route tree -- every distinct path actually seen,
// organized into pages/API endpoints/dynamic (numeric-id) routes/static
// assets, plus a nested tree view. Confirmed directly before porting
// that this doesn't fix a concrete problem the way discoverAPIEndpoints
// did (a realistic mix of real API calls and real static assets produced
// zero false positives in this generator's existing, narrower
// detectors) -- this is a genuinely different kind of addition: a
// comprehensive overview for a developer to see the whole site's shape
// at a glance, not a bug fix or a gap closure.
function buildRouteTreeFromPaths(paths) {
  const tree = {};
  for (const route of paths) {
    const parts = route.path.split('/').filter(p => p);
    let current = tree;
    for (const part of parts) {
      if (!current[part]) current[part] = {};
      current = current[part];
    }
    current['__route'] = {
      method: route.method,
      url: route.fullUrl,
      count: route.count
    };
  }
  return tree;
}

function discoverAllRoutesFromCapturedData(networkLog, actions) {
  const routes = { pages: [], apiEndpoints: [], dynamicRoutes: [], staticRoutes: [] };

  const pathMap = new Map();
  for (const entry of networkLog) {
    try {
      const url = new URL(entry.url);
      const path = url.pathname;
      const method = entry.method || 'GET';
      const key = `${method}:${path}`;
      if (!pathMap.has(key)) {
        pathMap.set(key, { path, method, fullUrl: entry.url, count: 1 });
      } else {
        pathMap.get(key).count++;
      }
    } catch (e) { /* not a parseable absolute URL -- skip */ }
  }

  const navActions = actions.filter(a => a.type === 'spa_navigate' || a.type === 'navigate');
  for (const action of navActions) {
    try {
      const url = new URL(action.url || '');
      const path = url.pathname;
      const key = `SPA:${path}`;
      if (!pathMap.has(key)) {
        pathMap.set(key, { path, method: 'SPA', fullUrl: action.url, count: 1 });
      }
    } catch (e) { /* not a parseable absolute URL -- skip */ }
  }

  for (const [, route] of pathMap) {
    const isDynamic = route.path.match(/\d+/) || route.path.match(/[a-f0-9]{32,}/);
    const isAPI = route.path.includes('/api/') || route.path.includes('/ajax/') ||
                  route.path.includes('/wp-json/') || route.path.includes('/graphql');
    const isStatic = route.path.match(/\.(css|js|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot)$/);

    if (isAPI) {
      routes.apiEndpoints.push(route);
    } else if (isStatic) {
      routes.staticRoutes.push(route);
    } else if (isDynamic) {
      routes.dynamicRoutes.push(route);
    } else {
      routes.pages.push(route);
    }
  }

  routes.routeTree = buildRouteTreeFromPaths(routes.pages);
  routes.summary = {
    totalPages: routes.pages.length,
    totalAPI: routes.apiEndpoints.length,
    totalDynamic: routes.dynamicRoutes.length,
    totalStatic: routes.staticRoutes.length
  };

  return routes;
}

function formatRouteTreeForDisplay(tree, depth) {
  let output = '';
  const indent = '    '.repeat(depth);
  for (const [key, value] of Object.entries(tree)) {
    if (key === '__route') continue;
    output += `${indent}${key}/\n`;
    if (typeof value === 'object') {
      output += formatRouteTreeForDisplay(value, depth + 1);
    }
  }
  return output;
}

function analyzeCapturedData(networkLog, xhrBodies, actions, contentPipeline, userJourney, scriptBodies, frameDocuments) {
  scriptBodies = scriptBodies || [];
  frameDocuments = frameDocuments || [];
  const analysis = {
    baseUrl: null,
    categories: [],
    searchEndpoint: null,
    searchPattern: null,
    itemSelectors: [],
    posterSelectors: [],
    titleSelectors: [],
    streamResolvers: [],
    apiEndpoints: [],
    navigationPatterns: [],
    paginationPatterns: [],
    detailPatterns: [],
    htmlSample: null,
    jsonSample: null,
    streamSample: null
  };

  userJourney = userJourney || [];

  // [NEW] confirmed directly: a 'stream_urls_found' userJourney event is
  // written the moment this extension's own live page-hook already
  // identified a real stream URL during recording -- this is a stronger,
  // more direct signal than re-deriving one from raw xhrBodies text (the
  // existing streamResolvers/streamSample logic below), since it reflects
  // a URL the capture pipeline itself already trusted enough to log as a
  // journey event. Surfaced separately so the generated file can lead
  // with it rather than rely solely on the weaker text-scan.
  const journeyStreamUrls = [];
  for (const event of userJourney) {
    if (event && event.action === 'stream_urls_found' && event.data && Array.isArray(event.data.streamUrls)) {
      for (const u of event.data.streamUrls) {
        if (u && !journeyStreamUrls.includes(u)) journeyStreamUrls.push(u);
      }
    }
  }
  if (journeyStreamUrls.length > 0) {
    analysis.journeyStreamSample = journeyStreamUrls[0];
    analysis.journeyStreamUrls = journeyStreamUrls;
  }

  // [NEW] confirmed directly: neither request nor response headers were
  // ever examined anywhere in this file, even though real sites built by
  // hand this session (akwams.org, egydead.ca) both genuinely needed a
  // specific Referer header to work at all -- a generated extractor could
  // easily be missing this silently, with no indication anything was
  // wrong until it failed at runtime. This surfaces whatever Referer
  // value this site's own real requests actually carried (case-
  // insensitive lookup, since the exact header-object casing isn't
  // confirmed), as a concrete, labeled hint rather than invented advice.
  const refererCounts = {};
  for (const entry of networkLog) {
    const headers = entry && entry.requestHeaders;
    if (!headers || typeof headers !== 'object') continue;
    let refererValue = null;
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'referer') { refererValue = headers[key]; break; }
    }
    if (refererValue) {
      refererCounts[refererValue] = (refererCounts[refererValue] || 0) + 1;
    }
  }
  const refererEntries = Object.entries(refererCounts).sort((a, b) => b[1] - a[1]);
  if (refererEntries.length > 0) {
    analysis.refererSample = refererEntries[0][0];
  }

  // Extract base URL
  // [FIX] baseUrl used to be the host of whatever request happened to be FIRST in the log --
  // fine when that was the page itself, but an ad, font or analytics request recorded first
  // made the whole extractor point at the wrong site. Prefer the real top-level page
  // (main_frame request, then a top-frame document), then fall back to the old behaviour.
  const _origin = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? `${x.protocol}//${x.hostname}` : null; } catch (e) { return null; } };
  const mainFrame = networkLog.find(e => e && e.type === 'main_frame' && _origin(e.url));
  const topDoc = frameDocuments.find(d => d && d.isTop && _origin(d.url));
  analysis.baseUrl = (mainFrame && _origin(mainFrame.url)) || (topDoc && _origin(topDoc.url)) || null;
  for (const entry of networkLog) {
    if (analysis.baseUrl) break;
    analysis.baseUrl = _origin(entry && entry.url);
  }

  // Extract categories from actions
  // [FIX] real sites use many different URL shapes for category-like listings, not just
  // "/category/" -- confirmed directly against EgyDead alone, which uses /category/, /serie/,
  // /season/, /type/, /series-category/, /genre/, /language/, /country/, /year/, /channel/.
  // The old check caught only the first of these, silently missing the rest for any real site.
  // [FIX] confirmed directly: this list's own comment above already names
  // "/channel/" as a confirmed-real EgyDead pattern, alongside /serie/,
  // /season/, /language/, /country/, /year/ -- none of which were actually
  // in the array. A real EgyDead capture (2026-10-04) produced zero
  // detected categories as a direct result, despite the site's real
  // category URLs being exactly this shape.
  const CATEGORY_URL_PATTERNS = [
    '/category/', '/categories/', '/genre/', '/genres/', '/type/', '/types/',
    '/series-category/', '/movies-category/', '/tag/', '/tags/',
    '/channel/', '/serie/', '/series/', '/season/', '/language/', '/country/', '/year/'
  ];
  const seenCategoryUrls = new Set();

  // [FIX] confirmed directly against a real egydead.ca capture: generated
  // category titles came out as raw numeric/opaque path segments (e.g.
  // "5381") instead of real names ("Movies", "Series"). Root cause: this
  // site (and others sharing its template) is a client-rendered SPA whose
  // real nav labels never appear as anchor text or in the URL at all --
  // they only exist in a JSON data blob the server embeds directly in the
  // page HTML (confirmed as `window.bootstrapData.settings.menus[].items[]
  // .{label,action}` on egydead.ca). Scans any captured page body for a
  // `window.<name> = {...};` assignment, parses it, and recursively
  // collects any {label|title|name, action|url|href} pairs that look like
  // short in-site nav links, so a real captured label can be preferred
  // over the last-path-segment guess below when one is actually available.
  // [FIX] confirmed directly: the {label,action} shape above only covers
  // top-level nav links ("Movies" -> "/Movies"). The actual "5381"/"2"/"4"
  // numeric titles traced back to a *different* embedded shape this same
  // site uses for its real channel/genre listings -- a plain
  // {"id":5381,"name":"Trending","slug":"trending",...} record with no
  // path/action field at all (the client builds the URL from the id at
  // render time). Collected separately, keyed by numeric id, since the
  // category URL's own last path segment is exactly that id.
  function extractIdTitlesFromCapturedHTML(bodies) {
    const idMap = {};
    const visited = new Set();
    for (const body of (bodies || [])) {
      if (!body || typeof body.body !== 'string') continue;
      let m;
      const re = /window\.[A-Za-z_][A-Za-z0-9_]*\s*=\s*(\{[\s\S]*?\});/g;
      while ((m = re.exec(body.body)) !== null) {
        let data;
        try { data = JSON.parse(m[1]); } catch (e) { continue; }
        const walk = (obj) => {
          if (!obj || typeof obj !== 'object' || visited.has(obj)) return;
          visited.add(obj);
          if (Array.isArray(obj)) {
            for (const item of obj) walk(item);
            return;
          }
          const id = obj.id;
          const name = obj.name || obj.title;
          if ((typeof id === 'number' || (typeof id === 'string' && /^\d+$/.test(id)))
              && typeof name === 'string' && name.length > 0 && name.length < 80
              && !idMap[String(id)]) {
            idMap[String(id)] = name;
          }
          for (const key of Object.keys(obj)) walk(obj[key]);
        };
        walk(data);
      }
    }
    return idMap;
  }
  function extractNavTitlesFromCapturedHTML(bodies) {
    const titleMap = {};
    const visited = new Set();
    for (const body of (bodies || [])) {
      if (!body || typeof body.body !== 'string') continue;
      let m;
      const re = /window\.[A-Za-z_][A-Za-z0-9_]*\s*=\s*(\{[\s\S]*?\});/g;
      while ((m = re.exec(body.body)) !== null) {
        let data;
        try { data = JSON.parse(m[1]); } catch (e) { continue; }
        const walk = (obj) => {
          if (!obj || typeof obj !== 'object' || visited.has(obj)) return;
          visited.add(obj);
          if (Array.isArray(obj)) {
            for (const item of obj) walk(item);
            return;
          }
          const label = obj.label || obj.title || obj.name;
          const action = obj.action || obj.url || obj.href;
          if (typeof label === 'string' && typeof action === 'string'
              && action.startsWith('/') && action.length < 60 && !titleMap[action]) {
            titleMap[action] = label;
          }
          for (const key of Object.keys(obj)) walk(obj[key]);
        };
        walk(data);
      }
    }
    return titleMap;
  }
  const navTitles = extractNavTitlesFromCapturedHTML(xhrBodies);
  const idTitles = extractIdTitlesFromCapturedHTML(xhrBodies);
  function lookupNavTitle(url) {
    try {
      const path = new URL(url).pathname;
      if (navTitles[path]) return navTitles[path];
      const norm = path.replace(/\/$/, '').toLowerCase();
      for (const p of Object.keys(navTitles)) {
        if (p.replace(/\/$/, '').toLowerCase() === norm) return navTitles[p];
      }
      const parts = path.split('/').filter(Boolean);
      const lastPart = parts[parts.length - 1];
      if (lastPart && idTitles[lastPart]) return idTitles[lastPart];
    } catch (e) {}
    return null;
  }
  // A title is treated as "not a real label" (worth overriding with a
  // looked-up nav title, if one is found) when it's purely numeric or an
  // opaque hash/ID-looking token -- a guess is still used as a last resort
  // when no nav title is found, so this never produces an empty title.
  function isOpaqueTitle(title) {
    return !title || /^[0-9a-f]{6,}$/i.test(title.trim()) || /^\d+$/.test(title.trim());
  }

  for (const action of actions) {
    if (action.href && CATEGORY_URL_PATTERNS.some(p => action.href.includes(p))) {
      let title = action.text;
      if (isOpaqueTitle(title)) {
        title = lookupNavTitle(action.href) || title;
      }
      title = title || action.href.split('/').pop() || 'Category';
      analysis.categories.push({
        title: title,
        url: action.href
      });
      seenCategoryUrls.add(action.href);
    }
  }
  // [NEW] confirmed directly: relying only on actions[].href means a
  // category is only ever detected if the user happened to click a link
  // whose text/href got recorded that way -- any category URL that was
  // merely fetched (navigation, an XHR triggered by page load, etc.)
  // without a matching recorded click was silently invisible to this
  // analysis. Scanning networkLog too catches those as well, with a
  // best-effort title derived from the URL's own last path segment
  // (honest about being a guess, not a real captured label) when no
  // better title is available from an action, or from the nav-titles map
  // above when one is available.
  function deriveCategoryTitleFromUrl(url) {
    const navTitle = lookupNavTitle(url);
    if (navTitle) return navTitle;
    try {
      const u = new URL(url);
      const parts = u.pathname.split('/').filter(Boolean);
      return decodeURIComponent(parts[parts.length - 1] || 'Category');
    } catch (e) {
      return 'Category';
    }
  }
  for (const entry of networkLog) {
    if (entry.url && CATEGORY_URL_PATTERNS.some(p => entry.url.includes(p))
        && !seenCategoryUrls.has(entry.url)) {
      analysis.categories.push({
        title: deriveCategoryTitleFromUrl(entry.url),
        url: entry.url
      });
      seenCategoryUrls.add(entry.url);
    }
  }

  // Extract search endpoint
  // [FIX] entry.url read unguarded -- this function accepts externally-supplied
  // capturedData (capturedData?.networkLog), not just the live session, so a malformed entry
  // is more plausible here than in the live-only capture path.
  for (const entry of networkLog) {
    if (entry.url && (entry.url.includes('search') || entry.url.includes('find'))) {
      analysis.searchEndpoint = entry.url;
      analysis.searchPattern = entry.method || 'GET';
    }
  }

  // Extract selectors from content pipeline
  if (contentPipeline.movieList && contentPipeline.movieList.length > 0) {
    const sample = contentPipeline.movieList[0];
    analysis.htmlSample = JSON.stringify(sample);
    // [FIX] confirmed directly against a real captured sample: this
    // checked specifically for sample.title, but a real site's actual
    // field was named "name" instead -- so titleSelectors came back
    // completely empty even though a perfectly good title field existed
    // right there under a different key. And even when it DID trigger,
    // the result was a fixed, hardcoded CSS-selector guess with no
    // relationship to what the sample actually contains -- meaningless
    // for a JSON sample in the first place, since JSON has no CSS
    // selectors to find at all. When the sample is a real object (JSON
    // data, not an HTML string), find its ACTUAL key names instead of
    // guessing.
    const isJsonSample = sample && typeof sample === 'object';
    if (isJsonSample) {
      const TITLE_KEYS = ['title', 'name', 'movie_title'];
      const POSTER_KEYS = ['poster', 'image', 'thumbnail', 'thumb', 'cover'];
      const PLOT_KEYS = ['description', 'plot', 'overview', 'summary'];
      const ID_KEYS = ['id', '_id', 'uuid', 'slug'];
      const RATING_KEYS = ['rating', 'vote_average', 'score'];
      const keys = Object.keys(sample);
      analysis.jsonFields = {
        titleField: keys.find(k => TITLE_KEYS.includes(k)) || null,
        posterField: keys.find(k => POSTER_KEYS.includes(k)) || null,
        plotField: keys.find(k => PLOT_KEYS.includes(k)) || null,
        idField: keys.find(k => ID_KEYS.includes(k)) || null,
        ratingField: keys.find(k => RATING_KEYS.includes(k)) || null,
      };
      // [NEW] confirmed directly: schema-generator.js already produces a
      // real, runnable Python dataclass + parser function from exactly
      // this kind of sample, wired into its own separate popup button,
      // but never connected to this generator's own output -- a strict
      // upgrade over the field-name hints above (actual code, not a
      // comment telling the developer which fields exist).
      analysis.generatedSchema = generateSchemaFromCapturedData(sample);
      // [NEW] confirmed directly: series/season/episode handling had no
      // equivalent anywhere in this generator at all -- not even
      // detection. A real JSON sample carrying an is_series-shaped field
      // is direct, confirmed evidence this site has series content, not
      // a guess.
      const SERIES_FLAG_KEYS = ['is_series', 'isSeries', 'is_tv', 'type'];
      for (const k of SERIES_FLAG_KEYS) {
        if (k in sample) {
          const v = sample[k];
          if (v === true || v === 'series' || v === 'tv') {
            analysis.hasSeriesSignal = true;
            break;
          }
        }
      }
    } else {
      // Not real evidence this is JSON -- keep the old, honestly-labeled
      // CSS-selector guess as a fallback for an HTML-shaped sample only.
      if (sample.title) {
        analysis.titleSelectors.push('.title', '.movie-title', 'h1', '.browse-movie-title');
      }
      if (sample.poster) {
        analysis.posterSelectors.push('img', '.poster', '.movie-poster');
      }
    }
  }

  // [NEW] confirmed directly: content.js already computes a real, precise
  // CSS selector for every element the user actually clicked during
  // recording (selector: getSelector(target)) and stores it on each
  // actions entry -- but none of that was ever read here, even while the
  // code immediately above this falls back to a fixed, invented selector
  // guess for exactly the same purpose. These are real, observed
  // selectors from this specific site, not a guess, so they're surfaced
  // honestly as candidates rather than asserted to be "the" title/poster
  // selector -- this function has no reliable way to know which clicked
  // element was a movie title versus something else from the selector
  // string alone.
  const SYNTHETIC_SELECTORS = new Set(['SPA_content_update', 'SPA_navigation', 'pushState', 'replaceState']);
  const realSelectors = [];
  for (const action of actions) {
    const sel = action && action.selector;
    if (sel && !SYNTHETIC_SELECTORS.has(sel) && !realSelectors.includes(sel)) {
      realSelectors.push(sel);
    }
  }
  if (realSelectors.length > 0) {
    analysis.realClickSelectors = realSelectors.slice(0, 15);
  }

  // Extract stream resolvers
  const streamUrls = [];
  for (const entry of networkLog) {
    if (entry.url && (entry.url.includes('.m3u8') || entry.url.includes('.mp4'))) {
      streamUrls.push(entry.url);
    }
  }
  for (const body of xhrBodies) {
    if (body.body && (body.body.includes('.m3u8') || body.body.includes('.mp4'))) {
      const urls = body.body.match(/https?:\/\/[^\s"']+\.(?:m3u8|mp4)[^\s"']*/g) || [];
      streamUrls.push(...urls);
    }
  }
  // [NEW] confirmed directly against a real site (EgyDead, 2026-10-04):
  // not every site exposes a direct .m3u8/.mp4 URL anywhere in its API
  // responses at all -- EgyDead's real watch API returns an EMBED page
  // URL instead ("src":"https://host.com/embed-<id>.html","type":"embed"),
  // which the check above never matches, even with xhrBodies fully
  // populated. Catching this shape too means a captured embed URL still
  // becomes a real streamSample instead of leaving the generator with
  // nothing at all for sites built this way.
  const embedSrcPattern = /"src"\s*:\s*"(https?:\/\/[^"]+)"[^}]*"type"\s*:\s*"embed"/g;
  const embedSources = [];
  for (const body of xhrBodies) {
    if (!body.body) continue;
    let m;
    embedSrcPattern.lastIndex = 0;
    while ((m = embedSrcPattern.exec(body.body)) !== null) {
      embedSources.push(m[1].replace(/\\\//g, '/'));
    }
  }
  if (embedSources.length > 0) {
    analysis.embedStreamSample = embedSources[0];
    analysis.embedStreamSources = embedSources;
  }
  if (streamUrls.length > 0) {
    analysis.streamSample = streamUrls[0];
    analysis.streamResolvers = streamUrls.map(url => {
      try {
        const u = new URL(url);
        return { host: u.hostname, pattern: url.replace(/\d+/g, '{id}'), sample: url };
      } catch (e) { return null; }
    }).filter(r => r);
  }

  // [FIX] detect obfuscated JS / deferred-JSON player pages so the generator can say so
  // honestly instead of silently emitting a find_m3u8()/find_mp4() call that will never find
  // anything. Confirmed real-world cases this covers: P.A.C.K.E.R.-packed players (MixDrop and
  // others), and Inertia.js-style pages where the actual stream data is a deferred prop loaded
  // by a second request, not present in the initial HTML at all (MegaMax).
  analysis.obfuscationDetected = [];
  const packerSig = 'eval(function(p,a,c,k,e,d)';
  const inertiaSig = '"component":';
  for (const body of xhrBodies) {
    if (!body.body) continue;
    if (body.body.includes(packerSig) && !analysis.obfuscationDetected.includes('packer')) {
      analysis.obfuscationDetected.push('packer');
    }
    if (body.body.includes(inertiaSig) && !analysis.obfuscationDetected.includes('inertia')) {
      analysis.obfuscationDetected.push('inertia');
    }
  }

  // Extract pagination
  // [FIX] confirmed directly against a real site (Fivetv, a WordPress build):
  // this only ever recognized QUERY-STRING pagination ("?page=2"). WordPress's
  // own standard pager -- by far the most common shape on sites this
  // generator targets -- uses a PATH segment instead ("/page/2/"), which this
  // loop silently produced zero matches for, on networkLog alone. Path-based
  // pagination is now recognized too, from the same networkLog scan.
  for (const entry of networkLog) {
    if (!entry.url) continue;
    if (entry.url.includes('page=')) {
      analysis.paginationPatterns.push(entry.url.replace(/page=\d+/, 'page={page}'));
    } else if (/\/page\/\d+\/?/.test(entry.url)) {
      analysis.paginationPatterns.push(entry.url.replace(/\/page\/\d+\/?/, '/page/{page}/'));
    }
  }

  // [NEW] a second, independent pagination source that needs no click-trail
  // (`actions`) and no live network capture at all -- it reads the "next
  // page" link's own real markup directly out of captured/imported page
  // HTML. Confirmed real need: a category/listing page's pager nav is
  // already present, in full, on that single page (every page number plus
  // the "next" link), so there was never a reason this required watching
  // the user actually click to page 2 -- the only reason it did was that
  // nothing had looked at the HTML itself before. Covers the two markup
  // shapes actually confirmed across real sites this session: a standard
  // <link rel="next"> head tag, and the common WordPress-and-lookalike
  // pager anchor (class containing "page-numbers"/"pagination"/"pager",
  // text containing "next"/"التالي"/an arrow glyph, or marked
  // rel="next"/aria-label="Next"). Deliberately does NOT try to diff two
  // snapshot pages against each other to infer a pattern -- confirmed
  // unnecessary once the real pager markup is read directly, and diffing
  // would be a much larger, more fragile piece of logic for no real gain.
  const nextLinkPatterns = [
    /<link[^>]+rel=["']next["'][^>]+href=["']([^"']+)["']/i,
    /<a[^>]+rel=["']next["'][^>]+href=["']([^"']+)["']/i,
    /<a[^>]+href=["']([^"']+)["'][^>]*\srel=["']next["']/i,
    /<a[^>]+href=["']([^"']+)["'][^>]+aria-label=["'][^"']*next[^"']*["']/i,
    // class="...page-numbers..."/"...pagination..."/"...pager..." anchor,
    // whose own link text or aria-label marks it as the "next" one rather
    // than a plain numbered page link -- checked below via a second pass
    // over the matched anchor's own text, not inferred from the regex alone.
  ];
  const nextWordPattern = /next|التالي|»|›|&raquo;/i;
  const pagerAnchorPattern = /<a[^>]+class=["'][^"']*(?:page-numbers|pagination|pager)[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]{0,40}?)<\/a>/gi;

  for (const body of xhrBodies) {
    if (!body.body || body.body.length < 200) continue;

    let found = null;
    for (const re of nextLinkPatterns) {
      const m = body.body.match(re);
      if (m) { found = m[1]; break; }
    }
    if (!found) {
      let m;
      pagerAnchorPattern.lastIndex = 0;
      while ((m = pagerAnchorPattern.exec(body.body)) !== null) {
        if (nextWordPattern.test(m[2])) { found = m[1]; break; }
      }
    }
    if (!found) continue;

    try {
      const resolved = body.url ? new URL(found, body.url).href : found;
      let pattern = resolved;
      if (/\/page\/\d+\/?/.test(pattern)) pattern = pattern.replace(/\/page\/\d+\/?/, '/page/{page}/');
      else if (/page=\d+/.test(pattern)) pattern = pattern.replace(/page=\d+/, 'page={page}');
      if (!analysis.paginationPatterns.includes(pattern)) {
        analysis.paginationPatterns.push(pattern);
      }
      if (!analysis.nextPageSample) {
        analysis.nextPageSample = { from: body.url || '', nextUrl: resolved };
      }
    } catch (e) { /* unresolvable relative URL with no body.url to anchor it -- skip */ }
  }

  // [NEW] detect download-link pages, so the generated extractor gets a starting
  // get_downloads()/download-extraction method instead of nothing at all. Real sites
  // (shaheed4u, egydead, mywecima) commonly group download links under quality headers
  // (e.g. "سيرفرات تحميل 1080") -- previously this had to be hand-built from scratch every
  // time (confirmed: the shaheed4u SH1 patch built _extract_downloads_from_page() by hand,
  // since the generator gave it nothing to start from).
  // [NEW] "downloads.php?vid=<hash>" is a real, confirmed download-gateway
  // path on both mycima.py and cimawbas_cwb.py (explicitly documented in
  // both extractors' own docstrings, and directly captured this session)
  // -- previously missing from this list entirely, so hitting one during
  // a capture looked like an ordinary page view instead of the
  // meaningful, real pattern it actually is on these sites.
  // [NEW] a second, independent source of series evidence for HTML-based
  // sites, where the JSON-field check above never applies at all: a real
  // captured click leading to a /season/ or /episode/-shaped URL is
  // direct, confirmed evidence too, not a guess.
  const SERIES_URL_PATTERNS = ['/season/', '/episode/', 'season=', 'episode='];
  for (const action of actions) {
    if (action.href && SERIES_URL_PATTERNS.some(p => action.href.toLowerCase().includes(p))) {
      analysis.hasSeriesSignal = true;
      break;
    }
  }

  const DOWNLOAD_URL_PATTERNS = ['/download/', '/dl/', '/get/', '/media-issue/download/', 'downloads.php'];
  analysis.downloadLinksCount = 0;
  // [NEW] confirmed directly, against two real, already-working extractors
  // in this codebase: this only ever counted how many download-pattern
  // links were seen, never WHERE they actually lead relative to the page
  // they were found on. That distinction is real and matters: egydead.py's
  // download servers are embedded directly in the same page it already
  // fetched (no separate request at all), while akwams.org's live on a
  // genuinely separate page that get_page() never visits -- which is
  // exactly why akwams never showed those servers at all. Each click
  // action records both the page it happened on (action.url) and where it
  // leads (action.href), so this can now tell the two cases apart from
  // real evidence instead of assuming either one.
  for (const action of actions) {
    if (action.href && DOWNLOAD_URL_PATTERNS.some(p => action.href.includes(p))) {
      analysis.downloadLinksCount++;
      if (!analysis.downloadPageSample && action.url) {
        try {
          const fromPage = new URL(action.url);
          const toPage = new URL(action.href);
          const samePage = fromPage.hostname === toPage.hostname && fromPage.pathname === toPage.pathname;
          if (!samePage) {
            analysis.downloadPageSample = { fromUrl: action.url, downloadUrl: action.href };
          }
        } catch (e) { /* not a parseable absolute URL -- skip */ }
      }
    }
  }
  if (contentPipeline.downloadLinks && contentPipeline.downloadLinks.length > 0) {
    analysis.downloadLinksCount += contentPipeline.downloadLinks.length;
    analysis.downloadLinksSample = contentPipeline.downloadLinks[0];
  }

  // [NEW] detect base64-encoded payloads that decode to real URLs. Confirmed real pattern:
  // captcha/ad-gated download gateways (e.g. gamingfree.online-style redirectors) send a
  // base64 blob that decodes to the actual file-host URL (send.now, vikingfile, etc.) rather
  // than linking to it directly. atob() is used, not Buffer -- this analysis runs in the
  // same browser/service-worker context as the rest of this codebase, where Buffer does not
  // exist at all (the same class of platform-availability mistake already found and fixed
  // elsewhere this session).
  analysis.base64UrlPayloads = [];
  const base64Pattern = /[A-Za-z0-9+/]{20,}={0,2}/g;
  outer:
  for (const body of xhrBodies) {
    if (!body.body) continue;
    const candidates = body.body.match(base64Pattern) || [];
    for (const candidate of candidates.slice(0, 20)) {
      try {
        const decoded = atob(candidate);
        if (/^https?:\/\//.test(decoded)) {
          analysis.base64UrlPayloads.push({ encodedSample: candidate.slice(0, 60), decodedSample: decoded.slice(0, 100) });
          if (analysis.base64UrlPayloads.length >= 3) break outer;
        }
      } catch (e) {}
    }
  }

  // [NEW] detect whether any stream-resolution request actually went through a redirect --
  // this is exactly the data class of bug that broke resolve_doodstream in the real plugin
  // (it used the ORIGINAL url's domain for a pass_md5 call instead of the domain the page
  // had actually redirected to). The capture side already records this (network-capture.js's
  // onBeforeRedirect), but nothing surfaced it to whoever writes the resolver next -- flagging
  // it here so the generated extract_stream() can point this out explicitly when relevant.
  const streamHostPattern = /\.(m3u8|mp4)|doodstream|streamruby|mixdrop|voe\.[a-z]+|streamwish|vidhide|uqload/i;
  analysis.hasRedirectingResolvers = false;
  analysis.redirectSample = null;
  for (const entry of networkLog) {
    if (entry.redirectChain && entry.redirectChain.length > 1 && entry.url && streamHostPattern.test(entry.url)) {
      analysis.hasRedirectingResolvers = true;
      analysis.redirectSample = { from: entry.redirectChain[0], to: entry.finalUrl || entry.redirectChain[entry.redirectChain.length - 1] };
      break;
    }
  }

  // [NEW] detect multiple distinct mirror hosts among stream resolvers -- real sites often
  // expose several qualities, each with several mirror hosts (confirmed real shape: 3
  // qualities x 7-9 mirrors each, from the MegaMax/Inertia.js work). Surfacing this lets the
  // generated extract_stream()/servers structure distinguish "quality" from "mirror" as two
  // separate axes instead of treating every server as a single, undifferentiated entry.
  const distinctMirrorHosts = new Set((analysis.streamResolvers || []).map(r => r.host).filter(Boolean));
  analysis.hasMultipleMirrorHosts = distinctMirrorHosts.size > 1;
  analysis.mirrorHostSample = [...distinctMirrorHosts].slice(0, 8);

  // [NEW] confirmed directly: this generator runs inside a browser
  // extension and has no access to the plugin's own hosts.py file on the
  // Enigma2 device at all -- it can never actually check whether a
  // detected host is already supported there. Hardcoding a list of known
  // hosts into the generator was considered and rejected: that list would
  // already be stale, since several real hosts were added to hosts.py
  // during this very session. The honest fix is a concrete, one-line
  // command the developer can run themselves to check in one step,
  // rather than implying a check this code structurally cannot perform.
  // [FIX] confirmed directly, via an actual multi-source test: the
  // original version used journeyStreamSample || embedStreamSample --
  // the || meant only ONE of the two ever got considered, even when both
  // were real and genuinely different (confirmed: a test with one host
  // from each source produced only the journey one, silently dropping
  // the embed one entirely). All real sample sources are combined below
  // instead, along with mirrorHostSample, into one deduped list, so the
  // grep suggestion checks every real detected host, not just whichever
  // single one happened to win.
  const allDetectedHosts = [];
  function addHostFromUrl(sampleUrl) {
    if (!sampleUrl) return;
    try {
      const h = new URL(sampleUrl).hostname;
      if (h && !allDetectedHosts.includes(h)) allDetectedHosts.push(h);
    } catch (e) { /* not a parseable absolute URL -- skip */ }
  }
  addHostFromUrl(analysis.journeyStreamSample);
  addHostFromUrl(analysis.embedStreamSample);
  if (allDetectedHosts.length > 0) {
    analysis.detectedStreamHost = allDetectedHosts[0];
  }
  for (const h of (analysis.mirrorHostSample || [])) {
    if (h && !allDetectedHosts.includes(h)) allDetectedHosts.push(h);
  }
  if (allDetectedHosts.length > 0) {
    analysis.allDetectedHosts = allDetectedHosts;
  }

  // [NEW] the real, multi-source, confidence-ranked selector discovery
  // ported above, replacing the simpler jsonFields/realClickSelectors
  // heuristics this session built blind, without knowing this richer
  // engine already existed.
  analysis.discoveredSelectors = discoverSelectorsFromCapturedData(
    networkLog, xhrBodies, contentPipeline, actions, frameDocuments
  );

  // [NEW] additive route-type classification, ported from
  // spa-route-mapper.js -- see that function's own comment for why this
  // one specifically, and not its two siblings.
  const discoveredRoutes = mapSPARoutesFromCapturedData(actions);
  if (discoveredRoutes.length > 0) {
    analysis.discoveredRoutes = discoveredRoutes;
    analysis.detailRouteSample = discoveredRoutes.find(r => r.routeType === 'detail') || null;
    // [FIX] confirmed directly: analysis.detailPatterns is declared in
    // the initial analysis object above but nothing anywhere in this
    // entire file ever pushed to it -- the "Detail URL pattern: ..."
    // line in get_page()'s generated docstring has never once fired in
    // any test this session, dead code with no output to have noticed.
    // Rather than port yet another, overlapping numeric-ID-in-path
    // detector from route-discoverer.js, this derives the pattern
    // directly from detailRouteSample above (same already-tested data,
    // from the already-ported spa-route-mapper.js), by replacing the
    // confirmed real numeric id with a {id} placeholder.
    if (analysis.detailRouteSample && analysis.detailRouteSample.routeId) {
      const dr = analysis.detailRouteSample;
      analysis.detailPatterns = [dr.path.replace(dr.routeId, '{id}')];
    }
  }

  // [NEW] additive, per-host referer/pattern grouping, ported from
  // api-discoverer.js -- see discoverStreamResolversFromCapturedData's
  // own comment for why this one specifically, and not its siblings.
  const streamResolverHosts = discoverStreamResolversFromCapturedData(networkLog, xhrBodies, scriptBodies);
  if (streamResolverHosts.length > 0) {
    analysis.perHostStreamInfo = streamResolverHosts;
  }

  // [NEW] see discoverStaticConstantsFromScriptBodies()'s own comment -- the other half of
  // actually using scriptBodies in this analysis, surfacing hardcoded keys/endpoints found
  // in a site's own captured app bundle rather than requiring a manual JS dump every time.
  const scriptFindings = discoverStaticConstantsFromScriptBodies(scriptBodies);
  if (scriptFindings.length > 0) {
    analysis.scriptBundleFindings = scriptFindings;
  }

  // [NEW] additive, genuinely different shape of information from this
  // generator's existing category detection -- see
  // discoverAPIEndpointsFromCapturedData's own comment for the real
  // evidence this isn't a duplicate.
  const discoveredAPIEndpoints = discoverAPIEndpointsFromCapturedData(networkLog);
  if (discoveredAPIEndpoints.length > 0) {
    analysis.discoveredAPIEndpoints = discoveredAPIEndpoints;
  }

  // ── [NEW v4.5] ──────────────────────────────────────────────────────────
  // (3) a trailer is never the film: drop trailer URLs/hosts from every stream signal
  const trailerUrls = [];
  const keepNonTrailer = (u) => { if (isTrailerUrl(u)) { if (!trailerUrls.includes(u)) trailerUrls.push(u); return false; } return true; };
  if (analysis.journeyStreamUrls) {
    analysis.journeyStreamUrls = analysis.journeyStreamUrls.filter(keepNonTrailer);
    analysis.journeyStreamSample = analysis.journeyStreamUrls[0] || null;
  }
  analysis.streamResolvers = (analysis.streamResolvers || []).filter(r => keepNonTrailer(r.sample));
  analysis.streamSample = analysis.streamResolvers.length ? analysis.streamResolvers[0].sample : null;
  if (analysis.allDetectedHosts) analysis.allDetectedHosts = analysis.allDetectedHosts.filter(h => !isTrailerUrl('https://' + h + '/'));
  if (analysis.mirrorHostSample) analysis.mirrorHostSample = analysis.mirrorHostSample.filter(h => !isTrailerUrl('https://' + h + '/'));
  analysis.hasMultipleMirrorHosts = (analysis.mirrorHostSample || []).length > 1;
  if (analysis.perHostStreamInfo) analysis.perHostStreamInfo = analysis.perHostStreamInfo.filter(h => !isTrailerUrl('https://' + h.host + '/'));
  analysis.trailerUrls = trailerUrls.slice(0, 5);
  // (1) Next.js page data, (4) TMDB-numbered site
  analysis.nextjs = detectNextJs(networkLog, xhrBodies, frameDocuments);
  analysis.tmdbSite = detectTmdbSite(networkLog, actions, analysis.nextjs);
  // (2) the request that produced the playlist (+ its setup call and decoder)
  analysis.streamOrigin = traceStreamOrigin(networkLog, xhrBodies, scriptBodies);
  // (5) the real search: the request that followed typing in the search box
  analysis.realSearch = findRealSearch(actions, networkLog);
  if (analysis.realSearch) {
    analysis.searchEndpoint = analysis.realSearch.template;
    analysis.searchPattern = analysis.realSearch.method;
  } else if (analysis.searchEndpoint) {
    // only a URL that happened to contain "search"/"find" -- not proof of a title search
    analysis.searchGuessed = true;
    if (/subtitle|caption|opensubtitles|track|analytics/i.test(analysis.searchEndpoint)) analysis.searchEndpoint = null;
  }
  // (6) server names in the player <-> the API paths they call
  analysis.serverMap = mapServerLabels(networkLog, frameDocuments, xhrBodies);
  analysis.serverTemplate = buildServerTemplate(analysis.streamOrigin, analysis.serverMap);

  // [NEW] whole-site route tree overview -- see
  // discoverAllRoutesFromCapturedData's own comment for scope/intent.
  const allRoutes = discoverAllRoutesFromCapturedData(networkLog, actions);
  if (allRoutes.summary.totalPages + allRoutes.summary.totalAPI +
      allRoutes.summary.totalDynamic + allRoutes.summary.totalStatic > 0) {
    analysis.siteRouteOverview = allRoutes;
  }

  return analysis;
}

// ═══ GENERATE FULL PLUGIN EXTRACTOR ═══

function generateFullPluginExtractor(siteName, analysis) {
  // [FIX] siteName is developer-typed, not scraped from a site -- much lower risk than the
  // captured/analysis data this file is otherwise careful to escape, but it's still
  // interpolated directly into real double-quoted Python string literals all through this
  // function's log(...) calls below, so a name containing a literal " or \ would still break
  // the generated file the same way. self._site_name and EXTRACTOR_METADATA["name"] use
  // toPythonStringLiteral() directly since those are whole, standalone literals; this
  // escaped-but-unquoted form is for every log("${siteName}: ...".format(...)) call, where
  // siteName sits mid-string alongside static text that already owns the surrounding quotes.
  const siteNameDQ = String(siteName)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  const safeName = siteName.toLowerCase().replace(/[^a-z0-9]/g, '_');
  // [FIX] confirmed directly: the old className logic only capitalized the
  // first letter of the raw siteName and never sanitized the rest, so any
  // site name containing a dot -- i.e. every real domain name, since they
  // all have a TLD -- produced an invalid Python class name. Confirmed on
  // a real generated file for "egydead.ca": "class Egydead.caExtractor"
  // is a syntax error and the file doesn't even parse. The module
  // filename below already correctly sanitizes the same siteName via
  // safeName; this builds the class name from that same sanitized value
  // instead of the raw one, splitting on "_" and capitalizing each part
  // (PascalCase), matching the convention already used by every other
  // extractor in this codebase (AkwamsExtractor, CimaWbasCwbExtractor).
  const className = safeName.split('_').filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('') + 'Extractor';

  let code = `# -*- coding: utf-8 -*-\n`;
  code += `"""\n`;
  code += `${siteName} Extractor for NovaPlay Media Center\n`;
  code += `Auto-generated by Stream Recorder Pro v${(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) ? chrome.runtime.getManifest().version : '?'}\n`;
  code += `Generated: ${new Date().toISOString()}\n`;
  code += `\n`;
  code += `IMPORTANT: This extractor is a generated STARTING POINT, not a finished,\n`;
  code += `guaranteed-working file. This generator runs in a browser extension with\n`;
  code += `no real Python interpreter available, so it cannot verify this file's\n`;
  code += `correctness itself -- before relying on it, run:\n`;
  code += `    python3 -m py_compile ${safeName}_extractor.py\n`;
  code += `and fix anything it reports. Several TODO markers below also need real\n`;
  code += `site-specific confirmation (container class names, selectors) that this\n`;
  code += `generator cannot determine on its own -- see each one for what to check.\n`;
  code += `\n`;
  // [NEW] a whole-site overview of every distinct, real API endpoint
  // shape this site was confirmed to actually use -- ported from
  // api-discoverer.js. URLs/params are already URL-decoded text by this
  // point, which could in principle contain a stray \"\"\" sequence, so
  // neutralized the same defensive way as the schema dataclass embedding
  // above, rather than assume URLs are always safe to embed raw.
  if (analysis.discoveredAPIEndpoints && analysis.discoveredAPIEndpoints.length > 0) {
    code += `DETECTED: real API endpoint shapes confirmed for this site:\n`;
    for (const ep of analysis.discoveredAPIEndpoints.slice(0, 10)) {
      const safePattern = String(ep.pattern).replace(/"""/g, "'''");
      code += `    ${ep.method} ${safePattern}\n`;
      const paramKeys = Object.keys(ep.sampleParams || {});
      if (paramKeys.length > 0) {
        const safeParams = JSON.stringify(ep.sampleParams).replace(/"""/g, "'''");
        code += `        params: ${safeParams}\n`;
      }
    }
    code += `\n`;
  }
  // [NEW] hardcoded keys/endpoints/urls found by actually reading the site's own captured
  // app bundle (background/script-capture.js + discoverStaticConstantsFromScriptBodies()
  // above) -- this is exactly the kind of thing that previously needed a one-off manual JS
  // dump to find (see moviesapi.to's x-player-key, found this same way by hand). A
  // "possible key" is a conservative guess (a long hex-looking constant), not a confirmed
  // header name -- it still needs a human to check where/how the site actually sends it.
  if (analysis.scriptBundleFindings && analysis.scriptBundleFindings.length > 0) {
    code += `DETECTED: possible static constants/endpoints found in this site's own\n`;
    code += `captured JS bundle(s) -- UNCONFIRMED, verify against the real site before use:\n`;
    for (const f of analysis.scriptBundleFindings.slice(0, 10)) {
      const safeScriptUrl = safeDocstringText(f.scriptUrl);
      code += `    ${safeScriptUrl}\n`;
      for (const k of f.possibleKeys.slice(0, 5)) {
        code += `        possible key: ${safeDocstringText(k.name)} = "${safeDocstringText(k.value)}"\n`;
      }
      for (const ep of f.apiEndpoints.slice(0, 5)) {
        code += `        possible endpoint: ${safeDocstringText(ep)}\n`;
      }
      for (const u of f.notableUrls.slice(0, 3)) {
        code += `        url: ${safeDocstringText(u)}\n`;
      }
    }
    code += `\n`;
  }
  // [NEW] whole-site route tree overview, ported from route-discoverer.js
  // -- same defensive neutralization of any stray \"\"\" as the API
  // endpoints block just above, for the same reason.
  if (analysis.siteRouteOverview) {
    const ro = analysis.siteRouteOverview;
    code += `DETECTED: whole-site route overview (${ro.summary.totalPages} page(s),\n`;
    code += `${ro.summary.totalAPI} API endpoint(s), ${ro.summary.totalDynamic} dynamic route(s),\n`;
    code += `${ro.summary.totalStatic} static asset(s) seen):\n`;
    const treeText = formatRouteTreeForDisplay(ro.routeTree, 0).replace(/"""/g, "'''");
    const treeLines = treeText.split('\n').filter(l => l.trim());
    for (const line of treeLines.slice(0, 25)) {
      code += `    ${line}\n`;
    }
    code += `\n`;
  }
  // ── [NEW v4.5] findings that change how this site must be extracted ──
  if (analysis.nextjs) {
    const nx = analysis.nextjs;
    code += `DETECTED: Next.js site -- page data is JSON, not HTML. Read it from:\n`;
    code += `    <script id="__NEXT_DATA__"> in the page (props.pageProps), or\n`;
    code += `    /_next/data/<buildId>/<page>.json   (buildId now: ${safeDocstringText(nx.buildId || '?')} -- it changes\n`;
    code += `    with every site update, so read it from the home page each time; see _next_build_id())\n`;
    if (nx.sections.length) {
      code += `    home page lists (pageProps):\n`;
      for (const sec of nx.sections.slice(0, 12)) {
        const where = sec.sub ? `${sec.key}[name=${sec.sub.name}].${sec.sub.listKey}` : sec.key;
        code += `        ${safeDocstringText(where)}  (${sec.count} items: ${safeDocstringText(sec.itemKeys.slice(0, 8).join(', '))})\n`;
      }
    }
    if (nx.dataRoutes && nx.dataRoutes.length) {
      code += `    data routes seen: ${safeDocstringText(nx.dataRoutes.slice(0, 8).join('  '))}\n`;
    }
    code += `\n`;
  }
  if (analysis.tmdbSite) {
    const tm = analysis.tmdbSite;
    code += `DETECTED: TMDB-numbered site -- titles are addressed by their TMDB id\n`;
    code += `    movie: ${safeDocstringText(tm.moviePattern || '?')}   tv: ${safeDocstringText(tm.tvPattern || '?')}\n`;
    for (const ev of tm.evidence) code += `    - ${safeDocstringText(ev)}\n`;
    code += `    Build it like NovaPlay's sflix_pro.py / movy.py: lists, search and details from\n`;
    code += `    TMDB (item URLs like "<site>_movie_<id>", "<site>_episode_<id>_<s>_<e>"), servers\n`;
    code += `    built from the TMDB id -- no HTML scraping needed.\n\n`;
  }
  if (analysis.streamOrigin && analysis.streamOrigin.origin) {
    const so = analysis.streamOrigin;
    code += `DETECTED: where the playlist came from (traced through the recording):\n`;
    code += `    playlist: ${safeDocstringText(so.playlistUrl.slice(0, 150))}\n`;
    if (so.setup) {
      code += `    1. setup call: ${so.setup.method} ${safeDocstringText(so.setup.url.slice(0, 150))}\n`;
      code += `       reply: ${safeDocstringText(so.setup.bodySample)}\n`;
      if (so.setup.reusedValue) code += `       (its value is sent again in the next call)\n`;
    }
    code += `    ${so.setup ? '2' : '1'}. stream API: ${so.origin.method || 'GET'} ${safeDocstringText(so.origin.url.slice(0, 220))}\n`;
    if (so.origin.plain) {
      code += `       its reply contains the playlist URL in plain text.\n`;
    } else if (so.origin.encrypted) {
      code += `       its reply is ENCRYPTED (${safeDocstringText(so.origin.bodySample.slice(0, 50))}...) -- port the\n`;
      code += `       site's decoder; the script(s) that build this call are quoted in extract_stream().\n`;
    }
    code += `\n`;
  }
  if (analysis.serverMap) {
    const sm = analysis.serverMap;
    code += `DETECTED: player server names map to API paths:\n`;
    code += `    ${safeDocstringText(sm.pattern)}\n`;
    code += `    requested in the recording: ${safeDocstringText(sm.requested.join(', '))}\n`;
    code += `    names shown in the player: ${safeDocstringText(sm.labels.join(', '))}\n\n`;
  }
  if (analysis.realSearch) {
    code += `DETECTED: search -- typing "${safeDocstringText(analysis.realSearch.typed)}" in the site's search box sent:\n`;
    code += `    ${analysis.realSearch.method} ${safeDocstringText(analysis.realSearch.template)}\n\n`;
  } else {
    code += `NOT FOUND: the site's search request. Record again and type a title in the\n`;
    code += `site's search box (Stream Recorder Pro 4.5+ records what is typed there).\n\n`;
  }
  if (analysis.trailerUrls && analysis.trailerUrls.length) {
    code += `IGNORED as trailers (never the film): ${safeDocstringText(analysis.trailerUrls.slice(0, 2).map(u => u.slice(0, 80)).join('  '))}\n\n`;
  }
  code += `Once verified, place this file in NovaPlay's extractors/ folder and register\n`;
  code += `it in extractors/registry.py (import + a _SITE_REGISTRY entry + the\n`;
  code += `_SEARCH_SITE_ORDER / _HOME_SITE_ORDER tuples):\n`;
  code += `    from .${safeName} import ${className}\n`;
  code += `"""\n\n`;

  code += `import re\n`;
  code += `import json\n`;
  code += `import time\n`;
  if (analysis.base64UrlPayloads && analysis.base64UrlPayloads.length > 0) {
    code += `import base64\n`;
  }
  code += `from urllib.parse import urljoin, urlparse\n\n`;
  // [FIX] this plugin's real codebase is pure-regex throughout -- zero uses of BeautifulSoup
  // anywhere in it, confirmed across every real extractor file. Generating BS4-first code was
  // inconsistent with the actual runtime (bs4 may not even be installed on these boxes) and
  // with every other extractor's style. HAS_BS4 is now always False, so the regex branch
  // (which already existed as the "fallback") is what actually runs -- matching real convention
  // without needing to touch the larger extraction blocks below.
  code += `HAS_BS4 = False  # this codebase is pure-regex; see extractors/*.py for the convention\n\n`;
  code += `from .base import BaseExtractor, fetch, fetch_json, find_m3u8, find_mp4, log\n`;
  code += `from .base import _correct_stream_url\n`;
  code += `from urllib.parse import quote\n`;
  code += `BeautifulSoup = None  # bs4 is not installed on NovaPlay boxes; the regex branches run\n\n\n`;

  code += `class ${className}(BaseExtractor):\n`;
  code += `    """\n`;
  code += `    ${siteName} extractor for NovaPlay Media Center.\n`;
  code += `    Auto-generated from captured network traffic.\n`;
  code += `    """\n\n`;

  code += `    def __init__(self):\n`;
  code += `        super().__init__()\n`;
  // [FIX] analysis.baseUrl is a real, captured protocol+hostname -- lower risk than a full
  // URL/title (hostnames are DNS-constrained), but embedded the same unescaped way as the
  // category fields below; made consistent with the same safe helper.
  const mainUrlValue = analysis.baseUrl || ('https://' + siteName.toLowerCase() + '.com/');
  code += `        self.main_url = ${toPythonStringLiteral(mainUrlValue)}\n`;
  code += `        self.base_url = self.main_url\n`;
  code += `        self._resolved_base = self.main_url\n`;
  code += `        self._site_name = ${toPythonStringLiteral(siteName)}\n`;
  code += `        self._site_label = self._site_name\n`;
  code += `        self._cache = {}  # Simple cache for performance\n\n`;

  // [NEW v4.5] Next.js helpers: the build id changes on every site update
  if (analysis.nextjs) {
    code += `    def _next_data_props(self, html):\n`;
    code += `        """props.pageProps from a page's <script id="__NEXT_DATA__">."""\n`;
    code += `        m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html or "", re.S)\n`;
    code += `        if not m:\n`;
    code += `            return {}, ""\n`;
    code += `        try:\n`;
    code += `            nd = json.loads(m.group(1))\n`;
    code += `        except ValueError:\n`;
    code += `            return {}, ""\n`;
    code += `        return (nd.get("props") or {}).get("pageProps") or {}, nd.get("buildId") or ""\n\n`;
    code += `    def _home_props(self):\n`;
    code += `        if "home" not in self._cache:\n`;
    code += `            html, _final = fetch(self.main_url + "/", referer=self.main_url + "/")\n`;
    code += `            self._cache["home"] = self._next_data_props(html)\n`;
    code += `        return self._cache["home"][0]\n\n`;
    code += `    def _next_build_id(self):\n`;
    code += `        self._home_props()\n`;
    code += `        return self._cache["home"][1]\n\n`;
    code += `    def _next_data(self, page_path):\n`;
    code += `        """/_next/data/<buildId>/<page_path>.json, e.g. "en/movie/550" (pageProps)."""\n`;
    code += `        bid = self._next_build_id()\n`;
    code += `        if not bid:\n`;
    code += `            return {}\n`;
    code += `        data = fetch_json("{}/_next/data/{}/{}.json".format(self.main_url, bid, page_path.strip("/")),\n`;
    code += `                          referer=self.main_url + "/") or {}\n`;
    code += `        return data.get("pageProps") or {}\n\n`;
    code += `    @staticmethod\n`;
    code += `    def _plain_image(url):\n`;
    code += `        """image proxies like wsrv.nl serve webp, which the box can't show:\n`;
    code += `        use the original image they wrap"""\n`;
    code += `        m = re.search(r"[?&]url=([^&]+)", url or "")\n`;
    code += `        if m and "wsrv.nl" in url:\n`;
    code += `            from urllib.parse import unquote\n`;
    code += `            return unquote(m.group(1))\n`;
    code += `        return url\n\n`;
    code += `    def _section_items(self, key, name=None, list_key=None):\n`;
    code += `        val = self._home_props().get(key) or []\n`;
    code += `        if name is not None:\n`;
    code += `            for sec in val:\n`;
    code += `                if isinstance(sec, dict) and (sec.get("name") == name or sec.get("title") == name):\n`;
    code += `                    return sec.get(list_key) or []\n`;
    code += `            return []\n`;
    code += `        return val if isinstance(val, list) else []\n\n`;
  }


  // [NEW v4.5] TMDB-numbered site: lists, search and detail pages from TMDB,
  // one server entry per player server name (built from the traced API call)
  const tm = analysis.tmdbSite;
  const st = analysis.serverTemplate;
  const pfx = safeName + '_';
  if (tm) {
    code += `    # ── TMDB mode (generated: this site addresses titles by TMDB id) ──\n`;
    code += `    TMDB_PREFIX = ${toPythonStringLiteral(pfx)}\n`;
    code += `    _TMDB_PUBLIC_KEY = "31eb6ae13f030d2e334cdd978cfc72b7"  # NovaPlay's SFlix key; the tmdb_api_key setting wins\n\n`;
    code += `    def _tmdb(self, path, params=None):\n`;
    code += `        key = self._TMDB_PUBLIC_KEY\n`;
    code += `        try:\n`;
    code += `            from plugin_state import _get_config\n`;
    code += `            key = (_get_config("tmdb_api_key", "") or "").strip() or key\n`;
    code += `        except Exception:\n`;
    code += `            pass\n`;
    code += `        q = {"api_key": key, "language": "en-US"}\n`;
    code += `        q.update(params or {})\n`;
    code += `        from urllib.parse import urlencode\n`;
    code += `        return fetch_json("https://api.themoviedb.org/3{}?{}".format(path, urlencode(q))) or {}\n\n`;
    code += `    @staticmethod\n`;
    code += `    def _tmdb_poster(p):\n`;
    code += `        return "https://image.tmdb.org/t/p/w342" + p if p else ""\n\n`;
    code += `    def _tmdb_item(self, r, kind=None):\n`;
    code += `        kind = kind or ("tv" if r.get("media_type") == "tv" or r.get("first_air_date") else "movie")\n`;
    code += `        return {"title": r.get("title") or r.get("name") or "",\n`;
    code += `                "poster": self._tmdb_poster(r.get("poster_path")),\n`;
    code += `                "url": "{}{}_{}".format(self.TMDB_PREFIX, kind, r.get("id")),\n`;
    code += `                "type": "series" if kind == "tv" else "movie",\n`;
    code += `                "year": (r.get("release_date") or r.get("first_air_date") or "")[:4],\n`;
    code += `                "rating": "{:.1f}".format(float(r.get("vote_average") or 0)) if r.get("vote_average") else ""}\n\n`;
    code += `    def _tmdb_url_from_path(self, link):\n`;
    code += `        """the site's own /movie/<id> or /tv/<id> link -> this extractor's item url"""\n`;
    code += `        m = re.search(r"/(movies?|tv|series|shows?)/(\\d+)", link or "")\n`;
    code += `        if not m:\n`;
    code += `            return urljoin(self.main_url, link or "")\n`;
    code += `        return "{}{}_{}".format(self.TMDB_PREFIX, "movie" if m.group(1).startswith("movie") else "tv", m.group(2))\n\n`;
    code += `    _TMDB_LISTS = [\n`;
    code += `        ("Trending Movies", "/trending/movie/week", "movie"),\n`;
    code += `        ("Popular Movies", "/movie/popular", "movie"),\n`;
    code += `        ("Top Rated Movies", "/movie/top_rated", "movie"),\n`;
    code += `        ("Trending Series", "/trending/tv/week", "tv"),\n`;
    code += `        ("Popular Series", "/tv/popular", "tv"),\n`;
    code += `    ]\n\n`;
    code += `    def _tmdb_list(self, url, page):\n`;
    code += `        m = re.search(r"_page_(\\d+)$", url)\n`;
    code += `        if m:  # NovaPlay opens "next page" rows by their url, so the page rides in it\n`;
    code += `            page, url = int(m.group(1)), url[:m.start()]\n`;
    code += `        idx = int(url.rsplit("_", 1)[1])\n`;
    code += `        _title, path, kind = self._TMDB_LISTS[idx]\n`;
    code += `        data = self._tmdb(path, {"page": page})\n`;
    code += `        items = [self._tmdb_item(r, kind) for r in data.get("results") or []]\n`;
    code += `        if page < int(data.get("total_pages") or 1):\n`;
    code += `            items.append({"title": "➡️ Page {} (Next)".format(page + 1), "url": "{}_page_{}".format(url, page + 1), "type": "category"})\n`;
    code += `        return items\n\n`;
    // servers
    code += `    def _servers_for(self, tmdb_id, title, year, imdb_id="", season=None, episode=None):\n`;
    if (st) {
      code += `        """One entry per server the site's player lists (SERVERS), each calling\n`;
      code += `        the site's own stream API the way the recording showed."""\n`;
      code += `        from urllib.parse import urlencode\n`;
      code += st.titleEncodings > 1
        ? `        t = quote(title or "", safe="")  # the site sends the title encoded twice\n`
        : `        t = title or ""\n`;
      code += `        values = {"{tmdb_id}": str(tmdb_id), "{imdb_id}": imdb_id or "", "{year}": str(year or ""),\n`;
      code += `                  "{title}": t, "{media_type}": "tv" if season else "movie",\n`;
      code += `                  "{season}": str(season or 1), "{episode}": str(episode or 1)}\n`;
      code += `        q = urlencode([(k, values.get(v, v)) for k, v in self.SERVER_PARAMS])\n`;
      code += `        return [{"name": "{} {}".format(${toPythonStringLiteral(siteName)}, label),\n`;
      code += `                 "url": self.SERVER_URL.replace("{server}", path) + "?" + q, "quality": "HD"}\n`;
      code += `                for label, path in self.SERVERS]\n\n`;
    } else {
      code += `        # TODO: no server API was traced in the recording -- the TMDB embed servers\n`;
      code += `        # NovaPlay already resolves are a safe start (same list as sflix_pro.py)\n`;
      code += `        if season:\n`;
      code += `            return [{"name": "VidSrc-Embed", "url": "https://vidsrc-embed.ru/embed/tv/{}/{}/{}".format(tmdb_id, season, episode), "quality": "HD"},\n`;
      code += `                    {"name": "VidFast", "url": "https://vidfast.vc/tv/{}/{}/{}".format(tmdb_id, season, episode), "quality": "HD"}]\n`;
      code += `        return [{"name": "VidSrc-Embed", "url": "https://vidsrc-embed.ru/embed/movie/{}".format(tmdb_id), "quality": "HD"},\n`;
      code += `                {"name": "EmbedMaster", "url": "https://embedmaster.link/movie/{}".format(tmdb_id), "quality": "HD"},\n`;
      code += `                {"name": "VidFast", "url": "https://vidfast.vc/movie/{}?autoPlay=true".format(tmdb_id), "quality": "HD"}]\n\n`;
    }
    // detail page
    code += `    def _tmdb_page(self, url):\n`;
    code += `        rest = url[len(self.TMDB_PREFIX):]\n`;
    code += `        kind, _, ident = rest.partition("_")\n`;
    code += `        if kind == "movie":\n`;
    code += `            d = self._tmdb("/movie/{}".format(ident))\n`;
    code += `            title, year = d.get("title") or "", (d.get("release_date") or "")[:4]\n`;
    code += `            return {"title": title, "plot": d.get("overview") or "", "poster": self._tmdb_poster(d.get("poster_path")),\n`;
    code += `                    "year": year, "rating": "{:.1f}".format(float(d.get("vote_average") or 0)) if d.get("vote_average") else "",\n`;
    code += `                    "genres": ", ".join(g.get("name", "") for g in d.get("genres") or []),\n`;
    code += `                    "type": "movie", "items": [],\n`;
    code += `                    "servers": self._servers_for(ident, title, year, d.get("imdb_id") or "")}\n`;
    code += `        if kind == "tv":\n`;
    code += `            d = self._tmdb("/tv/{}".format(ident))\n`;
    code += `            seasons = [{"title": s.get("name") or "Season {}".format(s.get("season_number")),\n`;
    code += `                        "url": "{}season_{}_{}".format(self.TMDB_PREFIX, ident, s.get("season_number")), "type": "season"}\n`;
    code += `                       for s in d.get("seasons") or [] if s.get("season_number")]\n`;
    code += `            return {"title": d.get("name") or "", "plot": d.get("overview") or "", "poster": self._tmdb_poster(d.get("poster_path")),\n`;
    code += `                    "year": (d.get("first_air_date") or "")[:4], "type": "series", "servers": [], "items": seasons,\n`;
    code += `                    "genres": ", ".join(g.get("name", "") for g in d.get("genres") or [])}\n`;
    code += `        if kind == "season":\n`;
    code += `            tid, sn = ident.split("_")\n`;
    code += `            d = self._tmdb("/tv/{}/season/{}".format(tid, sn))\n`;
    code += `            eps = [{"title": "S{:02d}E{:02d}: {}".format(int(sn), e.get("episode_number"), e.get("name") or ""),\n`;
    code += `                    "url": "{}episode_{}_{}_{}".format(self.TMDB_PREFIX, tid, sn, e.get("episode_number")), "type": "episode"}\n`;
    code += `                   for e in d.get("episodes") or []]\n`;
    code += `            return {"title": d.get("name") or "", "plot": d.get("overview") or "", "poster": self._tmdb_poster(d.get("poster_path")),\n`;
    code += `                    "type": "season", "servers": [], "items": eps}\n`;
    code += `        if kind == "episode":\n`;
    code += `            tid, sn, en = ident.split("_")\n`;
    code += `            show = self._tmdb("/tv/{}".format(tid), {"append_to_response": "external_ids"})\n`;
    code += `            e = self._tmdb("/tv/{}/season/{}/episode/{}".format(tid, sn, en))\n`;
    code += `            return {"title": "S{:02d}E{:02d}: {}".format(int(sn), int(en), e.get("name") or ""),\n`;
    code += `                    "plot": e.get("overview") or "", "poster": self._tmdb_poster(e.get("still_path")),\n`;
    code += `                    "type": "episode", "items": [],\n`;
    code += `                    "servers": self._servers_for(tid, show.get("name") or "", (show.get("first_air_date") or "")[:4],\n`;
    code += `                                                 (show.get("external_ids") or {}).get("imdb_id") or "", sn, en)}\n`;
    code += `        return None\n\n`;
  }

  // ═══ get_categories ═══
  code += `    def get_categories(self, mtype="movie"):\n`;
  code += `        """\n`;
  code += `        Get categories from ${siteName}.\n`;
  if (analysis.categories.length > 0) {
    code += `        Captured ${analysis.categories.length} categories.\n`;
  }
  code += `        """\n`;
  code += `        try:\n`;
  code += `            categories = []\n`;
  if (analysis.tmdbSite) {
    code += `            # TMDB lists (this site addresses titles by TMDB id)\n`;
    code += `            for i, (title, _path, _kind) in enumerate(self._TMDB_LISTS):\n`;
    code += `                categories.append({"title": title, "url": "{}list_{}".format(self.TMDB_PREFIX, i), "type": "category"})\n`;
  }
  if (analysis.nextjs && analysis.nextjs.sections.length) {
    code += `            # home page lists, read from __NEXT_DATA__ (see the DETECTED note at the top)\n`;
    for (const sec of analysis.nextjs.sections.slice(0, 15)) {
      const id = sec.sub ? `next:${sec.key}:${sec.sub.name}:${sec.sub.listKey}` : `next:${sec.key}`;
      const title = sec.sub ? (sec.sub.name || sec.key) : sec.key;
      code += `            categories.append({"title": ${toPythonStringLiteral(title)}, "url": ${toPythonStringLiteral(id)}, "type": "category"})\n`;
    }
  }
  if (analysis.categories.length > 0) {
    for (const cat of analysis.categories.slice(0, 10)) {
      code += `            categories.append({\n`;
      // [FIX] cat.title had a partial, incomplete escape (double-quotes only -- a captured
      // title ending in a backslash would still break the string literal); cat.url had NO
      // escaping at all. Confirmed directly: a captured URL containing its own quote
      // character broke this exact categories.append({...}) call with a SyntaxError, taking
      // down the whole generated file. Both now use the same safe, already-proven helper.
      code += `                "title": ${toPythonStringLiteral(cat.title)},\n`;
      code += `                "url": ${toPythonStringLiteral(cat.url)},\n`;
      code += `                "type": mtype\n`;
      code += `            })\n`;
    }
  } else {
    code += `            # TODO: Add categories manually\n`;
    code += `            # Example: categories.append({"title": "Movies", "url": "/category/movies/"})\n`;
  }
  code += `            log("${siteNameDQ}: Found {} categories".format(len(categories)))\n`;
  code += `            return categories\n`;
  code += `        except Exception as e:\n`;
  code += `            log("${siteNameDQ}: Error getting categories: {}".format(e))\n`;
  code += `            return []\n`;
  code += `\n`;

  // ═══ get_category_items ═══
  code += `    def get_category_items(self, url, page=1):\n`;
  if (analysis.tmdbSite) {
    code += `        if url.startswith(self.TMDB_PREFIX + "list_"):\n`;
    code += `            return self._tmdb_list(url, page)\n`;
  }
  if (analysis.nextjs && analysis.nextjs.sections.length) {
    code += `        if url.startswith("next:"):\n`;
    code += `            parts = url.split(":")\n`;
    code += `            rows = self._section_items(parts[1], *(parts[2:4] if len(parts) >= 4 else (None, None)))\n`;
    code += `            items = []\n`;
    code += `            for r in rows:\n`;
    code += `                if not isinstance(r, dict):\n`;
    code += `                    continue\n`;
    code += `                link = r.get("slug") or r.get("url") or ""\n`;
    code += `                items.append({"title": r.get("title") or r.get("name") or "",\n`;
    code += analysis.tmdbSite
      ? `                              "url": self._tmdb_url_from_path(link),\n`
      : `                              "url": urljoin(self.main_url, link) if link else "",\n`;
    code += `                              "poster": self._plain_image(r.get("poster") or r.get("image") or ""),\n`;
    code += `                              "year": str(r.get("release_date") or r.get("year") or "")[:4],\n`;
    code += `                              "type": "series" if str(r.get("mediaType") or r.get("type")) in ("tv", "series") else "movie"})\n`;
    code += `            return items\n`;
  }
  code += `        """\n`;
  code += `        Get items from a category page.\n`;
  if (analysis.paginationPatterns.length > 0) {
    code += `        Pagination pattern: ${safeDocstringText(analysis.paginationPatterns[0])}\n`;
  }
  // [NEW] confirmed directly: this analysis step already correctly
  // detects real JSON field names (jsonFields) and real embed-style
  // stream sources (embedStreamSample) when the captured data supports
  // it -- but that detected information was previously discarded
  // entirely, never reaching the generated file at all. Surfacing it
  // here, concretely, turns "figure this out from scratch" into "here
  // are the real field names, write the few lines that use them" --
  // deliberately NOT auto-generating a full JSON-parsing implementation,
  // since getting that subtly wrong for an unseen site's real shape
  // would be worse than an honest, correctly-labeled starting point.
  if (analysis.jsonFields) {
    const jf = analysis.jsonFields;
    code += `\n`;
    code += `        DETECTED: this site's listing data is JSON, not HTML (confirmed\n`;
    code += `        from a real captured sample). Real field names found in that\n`;
    code += `        sample:\n`;
    if (jf.titleField) code += `            title:  item["${jf.titleField}"]\n`;
    if (jf.posterField) code += `            poster: item["${jf.posterField}"]\n`;
    if (jf.plotField) code += `            plot:   item["${jf.plotField}"]\n`;
    if (jf.idField) code += `            id:     item["${jf.idField}"]\n`;
    if (jf.ratingField) code += `            rating: item["${jf.ratingField}"]\n`;
    code += `        Fetch the URL as JSON (not HTML) and build each card from these\n`;
    code += `        fields instead of the HTML-scraping code below, which will not\n`;
    code += `        find anything on a JSON response.\n`;
    // [NEW] a real, runnable dataclass + parser, generated from this same
    // confirmed sample -- ported from schema-generator.js, already wired
    // into its own separate popup button but never connected here.
    // Optional, typed reference -- the plain dict-key access above is
    // already enough to work with; this is a strict upgrade for anyone
    // who wants it, not a requirement.
    if (analysis.generatedSchema) {
      code += `        \n`;
      code += `        OPTIONAL: a real, generated dataclass + parser for this exact\n`;
      code += `        sample (not required -- the field names above are already enough):\n`;
      code += `        \n`;
      // [FIX] confirmed directly, via a real test with a realistic
      // sample: the generated parser code's own docstring contains a
      // literal \"\"\" -- embedding that inside THIS file's own outer
      // \"\"\"...\"\"\" docstring block prematurely terminated it, breaking
      // the entire generated file (confirmed: a real py_compile failure,
      // not just a style issue). The leading # comment marker doesn't
      // help, since Python only treats # as a comment OUTSIDE a string
      // literal -- once already inside one, it's just another character.
      // Neutralized by swapping any embedded \"\"\" for '''  -- same
      // meaning in real Python, no collision with the outer delimiter.
      const schemaLines = analysis.generatedSchema.dataclass.replace(/"""/g, "'''").split('\n');
      for (const line of schemaLines) {
        code += `        # ${line}\n`;
      }
      code += `        \n`;
      const parserLines = analysis.generatedSchema.parserCode.replace(/"""/g, "'''").split('\n');
      for (const line of parserLines) {
        code += `        # ${line}\n`;
      }
    }
  }
  // [NEW] replaces the earlier, simpler realClickSelectors list with
  // discoveredSelectors -- ported from selector-discovery.js, a far more
  // complete engine already in this codebase that was never connected to
  // this generator at all. Confidence-ranked across multiple real
  // sources (captured HTML samples, JSON samples, contentPipeline,
  // actual clicks), covering containers/titles/posters/ratings/years/
  // genres/links, not just a flat list of raw selectors.
  const ds = analysis.discoveredSelectors;
  if (ds) {
    const hasAny = ds.itemContainers.length || ds.titles.length || ds.posters.length ||
                   ds.ratings.length || ds.years.length || ds.genres.length || ds.links.length;
    if (hasAny) {
      code += `\n`;
      code += `        DETECTED: real selector candidates, ranked by confidence across\n`;
      code += `        multiple real sources (captured HTML, JSON samples, actual clicks)\n`;
      code += `        -- not a guess:\n`;
      function listTop(label, arr) {
        if (!arr || arr.length === 0) return;
        code += `            ${label}:\n`;
        for (const s of arr.slice(0, 3)) {
          code += `                ${s.selector}  (${s.confidence}% confidence, ${s.matches} match(es))\n`;
        }
      }
      listTop('item container', ds.itemContainers);
      listTop('title', ds.titles);
      listTop('poster', ds.posters);
      listTop('rating', ds.ratings);
      listTop('year', ds.years);
      listTop('genre', ds.genres);
      listTop('link', ds.links);
      if (ds.bestSelector) {
        code += `        Best overall container guess (from real URL-path frequency):\n`;
        code += `            ${ds.bestSelector.selector}  (${ds.bestSelector.confidence}% confidence,\n`;
        code += `            ${ds.bestSelector.matches}/${ds.bestSelector.total} items matched)\n`;
      }
      code += `        Check the highest-confidence one against the real page before\n`;
      code += `        using it -- these are strong candidates, not a guarantee.\n`;
    }
  }
  code += `        """\n`;
  code += `        try:\n`;
  if (analysis.paginationPatterns.length > 0) {
    const pattern = analysis.paginationPatterns[0];
    if (pattern.includes('page={page}')) {
      code += `            if 'page=' not in url:\n`;
      code += `                url = url + '?page=' + str(page)\n`;
      code += `            else:\n`;
      code += `                url = re.sub(r'page=\\d+', 'page=' + str(page), url)\n`;
    }
  }
  code += `            \n`;
  code += `            # Check cache\n`;
  code += `            cache_key = f"category_{url}"\n`;
  code += `            if cache_key in self._cache:\n`;
  code += `                log("${siteNameDQ}: Using cached category items")\n`;
  code += `                return self._cache[cache_key]\n`;
  code += `            \n`;
  code += `            html, final_url = fetch(url, referer=self.main_url, max_retries=2)\n`;
  code += `            if not html:\n`;
  code += `                return []\n`;
  code += `            \n`;
  code += `            items = []\n`;
  code += `            \n`;
  code += `            if HAS_BS4:\n`;
  code += `                soup = BeautifulSoup(html, 'html.parser')\n`;
  code += `                \n`;
  code += `                # Find containers - using selectors from captured data\n`;
  code += `                container_selectors = [\n`;
  code += `                    '.browse-movie-wrap',\n`;
  code += `                    '.movie-item',\n`;
  code += `                    '.film-item',\n`;
  code += `                    '.card',\n`;
  code += `                    '.torrent-card',\n`;
  code += `                    '.movie-card',\n`;
  code += `                ]\n`;
  code += `                \n`;
  code += `                containers = []\n`;
  code += `                for selector in container_selectors:\n`;
  code += `                    found = soup.select(selector)\n`;
  code += `                    if found:\n`;
  code += `                        containers = found\n`;
  code += `                        log("${siteNameDQ}: Found {} items using selector '{}'".format(len(found), selector))\n`;
  code += `                        break\n`;
  code += `                \n`;
  code += `                if not containers:\n`;
  code += `                    containers = soup.find_all(['div', 'article', 'li', 'tr'])\n`;
  code += `                    containers = [c for c in containers if c.find('a') and (c.find('img') or c.find('h'))]\n`;
  code += `                \n`;
  code += `                for container in containers:\n`;
  code += `                    try:\n`;
  code += `                        title = None\n`;
  code += `                        title_selectors = ['.title', '.movie-title', '.browse-movie-title', 'h1', 'h2', 'h3', 'h4']\n`;
  code += `                        for sel in title_selectors:\n`;
  code += `                            el = container.select_one(sel)\n`;
  code += `                            if el:\n`;
  code += `                                title = el.text.strip()\n`;
  code += `                                break\n`;
  code += `                        if not title:\n`;
  code += `                            continue\n`;
  code += `                        \n`;
  code += `                        link_el = container.find('a', href=True)\n`;
  code += `                        link = link_el.get('href') if link_el else None\n`;
  code += `                        if link and not link.startswith('http'):\n`;
  code += `                            link = urljoin(self.main_url, link)\n`;
  code += `                        \n`;
  code += `                        poster = None\n`;
  code += `                        img = container.find('img')\n`;
  code += `                        if img and img.get('src'):\n`;
  code += `                            poster = img.get('src')\n`;
  code += `                            if poster and not poster.startswith('http'):\n`;
  code += `                                poster = urljoin(self.main_url, poster)\n`;
  code += `                        \n`;
  code += `                        year = None\n`;
  code += `                        year_match = re.search(r'\\b(19|20)\\d{2}\\b', container.text)\n`;
  code += `                        if year_match:\n`;
  code += `                            year = year_match.group(0)\n`;
  code += `                        \n`;
  code += `                        rating = None\n`;
  code += `                        rating_match = re.search(r'(\\d+\\.\\d+)', container.text)\n`;
  code += `                        if rating_match:\n`;
  code += `                            rating = rating_match.group(1)\n`;
  code += `                        \n`;
  code += `                        items.append({\n`;
  code += `                            "title": title,\n`;
  code += `                            "url": link,\n`;
  code += `                            "poster": poster,\n`;
  code += `                            "year": year,\n`;
  code += `                            "rating": rating,\n`;
  code += `                            "type": "movie"\n`;
  code += `                        })\n`;
  code += `                    except Exception as e:\n`;
  code += `                        log("${siteNameDQ}: Error parsing item: {}".format(e))\n`;
  code += `                        continue\n`;
  code += `            else:\n`;
  code += `                pattern = r'<[^>]*class="[^"]*(?:movie|film|browse)[^"]*"[^>]*>.*?<a[^>]*href="([^"]+)"[^>]*>.*?<img[^>]*src="([^"]+)"[^>]*>.*?<[^>]*>([^<]+)</'\n`;
  code += `                matches = re.findall(pattern, html, re.S | re.I)\n`;
  code += `                for match in matches:\n`;
  code += `                    link = urljoin(self.main_url, match[0]) if match[0] else None\n`;
  code += `                    poster = urljoin(self.main_url, match[1]) if match[1] else None\n`;
  code += `                    title = match[2].strip() if len(match) > 2 else None\n`;
  code += `                    if title and link:\n`;
  code += `                        items.append({\n`;
  code += `                            "title": title,\n`;
  code += `                            "url": link,\n`;
  code += `                            "poster": poster,\n`;
  code += `                            "type": "movie"\n`;
  code += `                        })\n`;
  code += `            \n`;
  code += `            self._cache[cache_key] = items\n`;
  code += `            log("${siteNameDQ}: Found {} items on page {}".format(len(items), page))\n`;
  code += `            return items\n`;
  code += `        except Exception as e:\n`;
  code += `            log("${siteNameDQ}: Error getting category items: {}".format(e))\n`;
  code += `            return []\n`;
  code += `\n`;

  // ═══ search ═══
  code += `    def search(self, query, page=1):\n`;
  if (analysis.tmdbSite) {
    code += `        found = [self._tmdb_item(r) for r in (self._tmdb("/search/multi", {"query": query, "page": page}).get("results") or [])\n`;
    code += `                 if r.get("media_type") in ("movie", "tv")]\n`;
    code += `        if found:\n`;
    code += `            return found\n`;
  }
  code += `        """\n`;
  code += `        Search for content on ${siteName}.\n`;
  if (analysis.searchEndpoint) {
    code += `        Endpoint: ${safeDocstringText(analysis.searchEndpoint)}\n`;
  }
  code += `        """\n`;
  code += `        try:\n`;
  if (analysis.searchEndpoint) {
    // [FIX] analysis.searchEndpoint is a real, captured URL, embedded unescaped the same way
    // as the category fields fixed above.
    const ep = analysis.searchEndpoint;
    const abs = /^https?:/i.test(ep);
    if (analysis.realSearch) {
      code += `            # the request the site itself sent after typing in its search box\n`;
      code += `            search_url = ${toPythonStringLiteral(ep)}.replace("{query}", quote(query))\n`;
      code += `            response, final_url = fetch(search_url, referer=self.main_url + "/", max_retries=2)\n`;
    } else {
      code += `            # TODO: GUESSED -- this URL only contained the word "search"; confirm it really\n`;
      code += `            # searches titles (record again and type in the site's search box)\n`;
      code += abs ? `            search_url = ${toPythonStringLiteral(ep)}\n`
                  : `            search_url = urljoin(self.main_url, ${toPythonStringLiteral(ep)})\n`;
    }
    if (analysis.realSearch) {
      // done above
    } else if (analysis.searchPattern === 'POST') {
      code += `            data = {"query": query, "page": page}\n`;
      code += `            response, final_url = fetch(search_url, referer=self.main_url, post_data=data, max_retries=2)\n`;
    } else {
      code += `            search_url = search_url + ('&' if '?' in search_url else '?') + 'q=' + quote(query) + '&page=' + str(page)\n`;
      code += `            response, final_url = fetch(search_url, referer=self.main_url, max_retries=2)\n`;
    }
  } else {
    code += `            # TODO: Implement search\n`;
    code += `            response = None\n`;
  }
  code += `            \n`;
  code += `            if not response:\n`;
  code += `                return []\n`;
  code += `            \n`;
  code += `            items = []\n`;
  code += `            # TODO: Parse search results\n`;
  code += `            log("${siteNameDQ}: Found {} search results for '{}'".format(len(items), query))\n`;
  code += `            return items\n`;
  code += `        except Exception as e:\n`;
  code += `            log("${siteNameDQ}: Search error: {}".format(e))\n`;
  code += `            return []\n`;
  code += `\n`;

  // ═══ get_page ═══
  if (analysis.serverMap) {
    const sm = analysis.serverMap;
    code += `    # [v4.5] the player's servers, in the order it lists them (from the recording)\n`;
    code += `    SERVERS = ${JSON.stringify(sm.labels.map((l, i) => [l, sm.paths[i]]))}\n`;
    code += `    SERVER_URL = ${toPythonStringLiteral(analysis.serverTemplate ? analysis.serverTemplate.base : sm.pattern.split('?')[0])}  # {server} = the path name\n`;
    if (analysis.serverTemplate) {
      code += `    # query of the traced call; {..} are filled per title in _servers_for()\n`;
      code += `    SERVER_PARAMS = ${JSON.stringify(analysis.serverTemplate.params)}\n`;
      if (analysis.serverTemplate.setupUrl) {
        code += `    # setup call made first; its "${analysis.serverTemplate.setupKey || 'value'}" goes into "${analysis.serverTemplate.setupParam}"\n`;
        code += `    SETUP_URL = ${toPythonStringLiteral(analysis.serverTemplate.setupUrl)}\n`;
        code += `    SETUP_KEY = ${toPythonStringLiteral(analysis.serverTemplate.setupKey || '')}\n`;
        code += `    SETUP_PARAM = ${toPythonStringLiteral(analysis.serverTemplate.setupParam || '')}\n`;
      }
    }
    code += `\n`;
  }
  code += `    def get_page(self, url, m_type=None):\n`;
  if (analysis.tmdbSite) {
    code += `        if url.startswith(self.TMDB_PREFIX):\n`;
    code += `            return self._tmdb_page(url)\n`;
  }
  code += `        """\n`;
  code += `        Get detail page data.\n`;
  if (analysis.detailPatterns.length > 0) {
    code += `        Detail URL pattern: ${safeDocstringText(analysis.detailPatterns[0])}\n`;
  }
  // [NEW] additive confirmation from a different, independent source --
  // a real click that actually navigated to a URL shaped like
  // /something/<numeric-id> (ported from spa-route-mapper.js), not just
  // a URL-string pattern match. Agreement between this and
  // detailPatterns above is a stronger signal than either alone.
  if (analysis.detailRouteSample) {
    const dr = analysis.detailRouteSample;
    code += `        \n`;
    code += `        DETECTED: a real click actually navigated to a URL shaped like\n`;
    code += `        a detail page (confirmed, not just a pattern guess):\n`;
    code += `            ${safeDocstringText(dr.fullUrl)}\n`;
    code += `        (path segment "${safeDocstringText(dr.routeKey)}", id "${safeDocstringText(dr.routeId)}")\n`;
  }
  // [NEW] confirmed directly: request headers were never examined
  // anywhere in this file, even though real sites built by hand this
  // session (akwams.org, egydead.ca) both genuinely needed a specific
  // Referer to work at all -- without this, a generated extractor could
  // silently use the wrong one (self.main_url below is a reasonable
  // default guess, not a confirmed value) with no indication anything
  // was wrong until a real request failed at runtime.
  if (analysis.refererSample) {
    code += `        \n`;
    code += `        DETECTED: this site's own real requests carried this Referer:\n`;
    code += `            ${safeDocstringText(analysis.refererSample)}\n`;
    code += `        If fetch() below fails, try passing this explicitly instead of\n`;
    code += `        self.main_url -- they are not always the same value.\n`;
  }
  code += `        """\n`;
  code += `        try:\n`;
  code += `            cache_key = f"detail_{url}"\n`;
  code += `            if cache_key in self._cache:\n`;
  code += `                log("${siteNameDQ}: Using cached detail page")\n`;
  code += `                return self._cache[cache_key]\n`;
  code += `            \n`;
  code += `            html, final_url = fetch(url, referer=self.main_url, max_retries=2)\n`;
  code += `            if not html:\n`;
  code += `                return {}\n`;
  code += `            \n`;
  code += `            data = {\n`;
  code += `                "title": "",\n`;
  code += `                "year": "",\n`;
  code += `                "rating": "",\n`;
  code += `                "plot": "",\n`;
  code += `                "poster": "",\n`;
  code += `                "servers": [],\n`;
  code += `                "items": [],\n`;
  code += `                "downloads": [],\n`;
  code += `                "type": "movie",\n`;
  code += `            }\n`;
  code += `            \n`;
  code += `            if HAS_BS4:\n`;
  code += `                soup = BeautifulSoup(html, 'html.parser')\n`;
  code += `                \n`;
  code += `                title_selectors = ['h1', '.title', '.movie-title', '.film-title']\n`;
  code += `                for sel in title_selectors:\n`;
  code += `                    el = soup.select_one(sel)\n`;
  code += `                    if el:\n`;
  code += `                        data["title"] = el.text.strip()\n`;
  code += `                        break\n`;
  code += `                \n`;
  code += `                poster_selectors = ['img.poster', '.movie-poster img', '.poster img']\n`;
  code += `                for sel in poster_selectors:\n`;
  code += `                    el = soup.select_one(sel)\n`;
  code += `                    if el and el.get('src'):\n`;
  code += `                        poster = el.get('src')\n`;
  code += `                        if poster and not poster.startswith('http'):\n`;
  code += `                            poster = urljoin(self.main_url, poster)\n`;
  code += `                        data["poster"] = poster\n`;
  code += `                        break\n`;
  code += `                \n`;
  code += `                year_match = re.search(r'\\b(19|20)\\d{2}\\b', soup.text)\n`;
  code += `                if year_match:\n`;
  code += `                    data["year"] = year_match.group(0)\n`;
  code += `                \n`;
  code += `                rating_match = re.search(r'(\\d+\\.\\d+)', soup.text)\n`;
  code += `                if rating_match:\n`;
  code += `                    data["rating"] = rating_match.group(1)\n`;
  code += `                \n`;
  code += `                plot_selectors = ['.plot', '.description', '.synopsis', '.storyline']\n`;
  code += `                for sel in plot_selectors:\n`;
  code += `                    el = soup.select_one(sel)\n`;
  code += `                    if el:\n`;
  code += `                        data["plot"] = el.text.strip()\n`;
  code += `                        break\n`;
  code += `                \n`;
  code += `                server_selectors = ['a[href*="streamruby"]', 'a[href*="dood"]', 'a[href*=".m3u8"]']\n`;
  code += `                for sel in server_selectors:\n`;
  code += `                    for el in soup.select(sel):\n`;
  code += `                        server_url = el.get('href')\n`;
  code += `                        if server_url and server_url.startswith('http'):\n`;
  code += `                            quality = "HD"\n`;
  code += `                            if "1080" in server_url or "fhd" in server_url.lower():\n`;
  code += `                                quality = "1080p"\n`;
  code += `                            elif "720" in server_url or "hd" in server_url.lower():\n`;
  code += `                                quality = "720p"\n`;
  code += `                            elif "480" in server_url:\n`;
  code += `                                quality = "480p"\n`;
  code += `                            \n`;
  code += `                            data["servers"].append({\n`;
  code += `                                "name": el.text.strip() or "Server",\n`;
  code += `                                "url": server_url,\n`;
  code += `                                "quality": quality\n`;
  code += `                            })\n`;
  code += `            else:\n`;
  code += `                title_match = re.search(r'<h1[^>]*>([^<]+)</h1>', html, re.I)\n`;
  code += `                if title_match:\n`;
  code += `                    data["title"] = title_match.group(1).strip()\n`;
  code += `                \n`;
  code += `                poster_match = re.search(r'<img[^>]*class="[^"]*poster[^"]*"[^>]*src="([^"]+)"', html, re.I)\n`;
  code += `                if poster_match:\n`;
  code += `                    data["poster"] = poster_match.group(1)\n`;
  code += `                \n`;
  code += `                year_match = re.search(r'\\b(19|20)\\d{2}\\b', html)\n`;
  code += `                if year_match:\n`;
  code += `                    data["year"] = year_match.group(0)\n`;
  code += `                \n`;
  code += `                rating_match = re.search(r'(\\d+\\.\\d+)', html)\n`;
  code += `                if rating_match:\n`;
  code += `                    data["rating"] = rating_match.group(1)\n`;
  code += `                \n`;
  code += `                plot_match = re.search(r'<div[^>]*class="[^"]*(?:plot|description)[^"]*"[^>]*>([^<]+)', html, re.I)\n`;
  code += `                if plot_match:\n`;
  code += `                    data["plot"] = plot_match.group(1).strip()\n`;
  code += `                \n`;
  code += `                server_matches = re.findall(r'<a[^>]*href="([^"]*(?:streamruby|dood|\\.m3u8)[^"]*)"[^>]*>', html, re.I)\n`;
  code += `                for server_url in server_matches:\n`;
  code += `                    if server_url.startswith('http'):\n`;
  code += `                        quality = "HD"\n`;
  code += `                        if "1080" in server_url:\n`;
  code += `                            quality = "1080p"\n`;
  code += `                        elif "720" in server_url:\n`;
  code += `                            quality = "720p"\n`;
  code += `                        data["servers"].append({\n`;
  code += `                            "name": "Server",\n`;
  code += `                            "url": server_url,\n`;
  code += `                            "quality": quality\n`;
  code += `                        })\n`;
  code += `            \n`;
  if (analysis.downloadPageSample) {
    const sample = analysis.downloadPageSample;
    code += `            # DETECTED: this site's download links point to a genuinely\n`;
    code += `            # separate page, not the one already fetched above -- confirmed\n`;
    code += `            # directly from a real captured click:\n`;
    code += `            #   from page: ${sample.fromUrl}\n`;
    code += `            #   to page:   ${sample.downloadUrl}\n`;
    code += `            # TODO: adjust this pattern to match how this site's real link to\n`;
    code += `            # its download page is marked up (confirmed shape varies by site --\n`;
    code += `            # check a real detail-page sample for the actual href/text/class).\n`;
    code += `            download_page_m = re.search(r'href="([^"]*(?:download|dl)[^"]*)"', html, re.I)\n`;
    code += `            if download_page_m:\n`;
    code += `                dl_url = download_page_m.group(1)\n`;
    code += `                if not dl_url.startswith("http"):\n`;
    code += `                    dl_url = urljoin(self.main_url, dl_url)\n`;
    code += `                dl_html, _ = fetch(dl_url, referer=url)\n`;
    code += `                data["downloads"] = self._extract_downloads_from_page(dl_html or "")\n`;
    code += `            else:\n`;
    code += `                data["downloads"] = []\n`;
  } else {
    code += `            # No real evidence this site uses a separate download page --\n`;
    code += `            # extracting directly from the page already fetched above, matching\n`;
    code += `            # the same-page pattern confirmed on other real sites of this kind.\n`;
    code += `            data["downloads"] = self._extract_downloads_from_page(html)\n`;
  }
  code += `            \n`;
  code += `            self._cache[cache_key] = data\n`;
  code += `            log("${siteNameDQ}: Extracted page: {} ({} servers)".format(\n`;
  code += `                data.get("title", "Unknown"),\n`;
  code += `                len(data.get("servers", []))\n`;
  code += `            ))\n`;
  code += `            return data\n`;
  code += `        except Exception as e:\n`;
  code += `            log("${siteNameDQ}: Error getting page: {}".format(e))\n`;
  code += `            return {}\n`;
  code += `\n`;

  // ═══ _extract_downloads_from_page ═══
  // [NEW] a starting, adaptable download-link extractor -- previously this had no
  // equivalent at all in the generated extractor, so every site needing it (shaheed4u,
  // egydead, mywecima) had to have one hand-built from scratch. Real download pages group
  // links under quality headers (e.g. "سيرفرات تحميل 1080", "Download 1080p") followed by a
  // list of <a> links to different mirrors -- this looks for quality markers specifically
  // inside HEADING tags (h1-h6), not anywhere in the text, since quality-looking numbers can
  // also appear inside the download URLs themselves (e.g. ".../dl/abc1080a") and a naive
  // split on the number anywhere would fragment the page into pieces too small to ever
  // contain a complete link -- confirmed directly with a real-shaped test page before this
  // shipped: the naive version silently found 0 of 4 real links.
  code += `    def _extract_downloads_from_page(self, html):\n`;
  code += `        """\n`;
  code += `        Extract quality-grouped download links from a detail page.\n`;
  if (analysis.downloadLinksCount > 0) {
    code += `        Captured ${analysis.downloadLinksCount} download-link indicator(s) during this session.\n`;
  } else {
    code += `        No download links were captured this session -- adjust the selectors below\n`;
    code += `        once you have captured a real download page for this site.\n`;
  }
  code += `        TODO: adjust the heading tag / link class names below to match this site's\n`;
  code += `        real markup (inspect a captured detail-page HTML sample to confirm).\n`;
  code += `        """\n`;
  code += `        downloads = []\n`;
  code += `        try:\n`;
  code += `            section_pattern = re.compile(\n`;
  code += `                r'<h[1-6][^>]*>[^<]*?(1080p?|720p?|480p?|360p?|4K|2160p?)[^<]*?</h[1-6]>(.*?)'\n`;
  code += `                r'(?=<h[1-6][^>]*>[^<]*?(?:1080p?|720p?|480p?|360p?|4K|2160p?)[^<]*?</h[1-6]>|$)',\n`;
  code += `                re.I | re.S\n`;
  code += `            )\n`;
  code += `            for match in section_pattern.finditer(html):\n`;
  code += `                quality = match.group(1)\n`;
  code += `                block = match.group(2)\n`;
  code += `                link_matches = re.findall(\n`;
  code += `                    r'<a[^>]*class="[^"]*(?:btn-down|download)[^"]*"[^>]*href="([^"]+)"[^>]*>([^<]*)</a>',\n`;
  code += `                    block, re.I\n`;
  code += `                )\n`;
  code += `                for url, name in link_matches:\n`;
  code += `                    downloads.append({\n`;
  code += `                        "quality": quality,\n`;
  code += `                        "url": url if url.startswith("http") else urljoin(self.main_url, url),\n`;
  code += `                        "name": name.strip() or "Download"\n`;
  code += `                    })\n`;
  code += `        except Exception as e:\n`;
  code += `            log("${siteNameDQ}: Error extracting downloads: {}".format(e))\n`;
  code += `        return downloads\n`;
  code += `\n`;

  // ═══ Series / season / episode handling ═══
  // [NEW] previously had no equivalent at all in this generator, even
  // though both real sites built by hand this session needed it. Only
  // emitted when real evidence (a JSON sample's own is_series-shaped
  // field, or a real captured click to a /season/ or /episode/ URL)
  // confirms this site actually has series content -- unlike downloads,
  // which can apply to any site, generating this unconditionally would
  // be dead, irrelevant code for a movie-only site.
  //
  // _season_number / _episode_number / _arabic_season_ordinals below are
  // ported directly, nearly verbatim, from egydead.py -- a real, already-
  // working extractor in this same codebase -- rather than written fresh,
  // since that logic (URL-pattern match, then title-text match including
  // Arabic ordinal words, then a last-resort digit extraction, with a
  // reversal fallback when nothing numeric is found at all) is genuinely
  // site-independent and already proven, not something worth re-deriving
  // per site. _parse_episode_list's container-class lookup is NOT
  // reusable the same way -- confirmed directly, by comparing real sites
  // this session: egydead.py's own real episode list uses a container
  // class literally named "EpsList", which has no reason to match any
  // other site's real markup -- so that part stays an honestly-labeled
  // TODO, same treatment as the download-page template above.
  if (analysis.hasSeriesSignal) {
    code += `    def _arabic_season_ordinals(self):\n`;
    code += `        return {\n`;
    code += `            "الاول": 1, "الأول": 1, "الثاني": 2, "الثالث": 3, "الرابع": 4,\n`;
    code += `            "الخامس": 5, "السادس": 6, "السابع": 7, "الثامن": 8, "التاسع": 9,\n`;
    code += `            "العاشر": 10,\n`;
    code += `        }\n`;
    code += `\n`;
    code += `    def _season_number(self, item):\n`;
    code += `        url = (item.get("url", "") or "").lower()\n`;
    code += `        m = re.search(r'[-_]s(\\d{1,3})(?:[-/]|$)', url)\n`;
    code += `        if m:\n`;
    code += `            return int(m.group(1))\n`;
    code += `        m2 = re.search(r'season[-_](\\d{1,3})', url)\n`;
    code += `        if m2:\n`;
    code += `            return int(m2.group(1))\n`;
    code += `        title = item.get("title", "") or ""\n`;
    code += `        m3 = re.search(r'(?:موسم|season|\\bs\\.?)\\s*(\\d{1,3})', title, re.I)\n`;
    code += `        if m3:\n`;
    code += `            return int(m3.group(1))\n`;
    code += `        for word, num in self._arabic_season_ordinals().items():\n`;
    code += `            if word in title:\n`;
    code += `                return num\n`;
    code += `        nums = re.findall(r'\\d+', title)\n`;
    code += `        if nums:\n`;
    code += `            candidates = [n for n in nums if not (len(n) == 4 and 1900 <= int(n) <= 2099)]\n`;
    code += `            return int(candidates[-1] if candidates else nums[-1])\n`;
    code += `        return 999999\n`;
    code += `\n`;
    code += `    def _episode_number(self, item):\n`;
    code += `        url = item.get("url", "") or ""\n`;
    code += `        m = re.search(r'-e(\\d{1,4})(?:[-/]|$)', url, re.I)\n`;
    code += `        if m:\n`;
    code += `            return int(m.group(1))\n`;
    code += `        title = item.get("title", "") or ""\n`;
    code += `        m = re.search(r'(?:حلقة|حلقه|episode|\\bep\\.?)\\s*(\\d{1,4})', title, re.I)\n`;
    code += `        if m:\n`;
    code += `            return int(m.group(1))\n`;
    code += `        nums = re.findall(r'\\d+', title)\n`;
    code += `        if nums:\n`;
    code += `            candidates = [n for n in nums if not (len(n) == 4 and 1900 <= int(n) <= 2099)]\n`;
    code += `            return int(candidates[-1] if candidates else nums[-1])\n`;
    code += `        return 999999\n`;
    code += `\n`;
    code += `    def _parse_episode_list(self, html):\n`;
    code += `        """\n`;
    code += `        TODO: this container class name is a placeholder, not a confirmed\n`;
    code += `        value for this site -- egydead.py's own real episode list uses a\n`;
    code += `        container literally named "EpsList", which has no reason to match\n`;
    code += `        this site's real markup. Inspect a real captured series/season page\n`;
    code += `        to find the actual container class before relying on this.\n`;
    code += `        """\n`;
    code += `        items = []\n`;
    code += `        seen = set()\n`;
    code += `        eps_match = re.search(\n`;
    code += `            r'<div[^>]*class="[^"]*EpsList[^"]*"[^>]*>(.*?)</div>',\n`;
    code += `            html, re.S | re.I\n`;
    code += `        )\n`;
    code += `        if not eps_match:\n`;
    code += `            return items\n`;
    code += `        eps_html = eps_match.group(1)\n`;
    code += `        for ep in re.finditer(\n`;
    code += `            r'<li\\b[^>]*>\\s*<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>\\s*</li>',\n`;
    code += `            eps_html, re.S | re.I\n`;
    code += `        ):\n`;
    code += `            url = ep.group(1)\n`;
    code += `            if not url.startswith("http"):\n`;
    code += `                url = urljoin(self.main_url, url)\n`;
    code += `            if url in seen:\n`;
    code += `                continue\n`;
    code += `            seen.add(url)\n`;
    code += `            title = re.sub(r'<[^>]+>', '', ep.group(2)).strip()\n`;
    code += `            items.append({"title": title, "url": url, "type": "episode", "_action": "details"})\n`;
    code += `        items.sort(key=self._episode_number)\n`;
    code += `        return items\n`;
    code += `\n`;
  }

  // ═══ _decode_base64_url_payload ═══
  // [NEW] only emitted when this session actually captured a base64-encoded payload that
  // decodes to a real URL (a confirmed, real pattern on captcha/ad-gated download gateways --
  // e.g. gamingfree.online-style redirectors sending a base64 blob that decodes to the real
  // file-host URL, send.now/vikingfile, rather than linking to it directly). Not emitted for
  // every site -- most don't use this pattern, and an unused helper is just noise.
  if (analysis.base64UrlPayloads && analysis.base64UrlPayloads.length > 0) {
    code += `    def _decode_base64_url_payload(self, text):\n`;
    code += `        """\n`;
    code += `        Decode a base64-encoded string that may itself be (or contain) a real URL.\n`;
    code += `        Confirmed present in this site's captured traffic -- a real payload from this\n`;
    code += `        session decoded to: ${safeDocstringText(analysis.base64UrlPayloads[0].decodedSample)}\n`;
    code += `        """\n`;
    code += `        try:\n`;
    code += `            padded = text + '=' * (-len(text) % 4)\n`;
    code += `            return base64.b64decode(padded).decode('utf-8', errors='ignore')\n`;
    code += `        except Exception:\n`;
    code += `            return None\n`;
    code += `\n`;
  }

  // ═══ extract_stream ═══
  // [FIX] the old version hardcoded three per-host resolvers into EVERY generated extractor,
  // regardless of the actual captured site: _resolve_streamruby, _resolve_doodstream (which
  // reproduced the exact domain-redirect bug this real codebase already found and fixed --
  // it used the ORIGINAL url's domain for the pass_md5 call instead of the domain the page
  // actually redirected to), and _resolve_customapparelshop (a fabricated name matching no
  // real host anywhere in this codebase). The real, correct, already-working versions of
  // these resolvers live once, shared, in extractors/hosts.py -- reimplementing simplified
  // (and buggy) copies per-site is exactly how that bug would have silently come back.
  // This now points at the real shared resolvers instead of re-inventing them.
  code += `    def extract_stream(self, url):\n`;
  if (analysis.tmdbSite && analysis.serverTemplate) {
    const stt = analysis.serverTemplate;
    let host = '';
    try { host = new URL(stt.base.replace('{server}', 'x')).hostname; } catch (e) {}
    code += `        if ${toPythonStringLiteral(host)} in url:\n`;
    code += `            return self._extract_own_server(url)\n`;
  }
  code += `        """\n`;
  code += `        Extract stream URL from a server URL.\n`;
  if (analysis.streamResolvers.length > 0) {
    code += `        Detected ${analysis.streamResolvers.length} stream resolvers.\n`;
  }
  if (analysis.obfuscationDetected && analysis.obfuscationDetected.length > 0) {
    code += `        \n`;
    code += `        WARNING: obfuscated/deferred content detected during capture (${analysis.obfuscationDetected.join(', ')}).\n`;
    code += `        find_m3u8()/find_mp4() will very likely find nothing on their own here -- this\n`;
    code += `        needs the same manual investigation approach as MixDrop's packed JS or MegaMax's\n`;
    code += `        deferred Inertia prop: capture the real page, decode/unpack it by hand, THEN write\n`;
    code += `        the extraction regex against what it actually decodes to. Do not trust this\n`;
    code += `        skeleton's fallback to already work for this site.\n`;
  }
  if (analysis.hasRedirectingResolvers && analysis.redirectSample) {
    code += `        \n`;
    code += `        WARNING: a captured request to a stream host actually redirected to a DIFFERENT\n`;
    code += `        domain before resolving (captured: ${safeDocstringText(analysis.redirectSample.from)} -> ${safeDocstringText(analysis.redirectSample.to)}).\n`;
    code += `        Build any resolver call (e.g. a pass_md5-style request) against the domain the\n`;
    code += `        page actually redirected TO, not the original URL's domain -- using the wrong one\n`;
    code += `        here is exactly the bug already found and fixed once in this plugin's real\n`;
    code += `        resolve_doodstream. Check entry.redirectChain / entry.finalUrl in the captured\n`;
    code += `        network log for this host before assuming the original domain is correct.\n`;
  }
  if (analysis.hasMultipleMirrorHosts) {
    code += `        \n`;
    code += `        This site exposes multiple mirror hosts per title (captured: ${safeDocstringText(analysis.mirrorHostSample.join(', '))}).\n`;
    code += `        Real sites of this shape often have several QUALITIES, each with several MIRROR\n`;
    code += `        hosts -- treat quality and mirror/host as two separate axes rather than one flat\n`;
    code += `        list: each server dict below should carry both a "quality" AND a "host" (or\n`;
    code += `        "name") field so the caller can tell mirrors of the same quality apart, and pick\n`;
    code += `        a preferred mirror if one host is more reliable than another for this site.\n`;
  }
  // [NEW] confirmed directly: a 'stream_urls_found' userJourney event
  // means this extension's OWN live capture already identified a real
  // stream URL during recording -- a stronger, more direct signal than
  // the text-scan embedStreamSample detection below, since it reflects a
  // URL the capture pipeline itself already trusted. Shown first, ahead
  // of the weaker signal, when available.
  if (analysis.journeyStreamSample) {
    code += `        \n`;
    code += `        DETECTED: this extension's own recording already identified a\n`;
    code += `        real stream URL live, during capture (strongest available signal):\n`;
    code += `            ${safeDocstringText(analysis.journeyStreamSample)}\n`;
    code += `        Start from this one before anything else below.\n`;
  }
  // [NEW] confirmed directly: when a server's real "stream" is actually
  // an embed-page URL in JSON data (e.g. "src":"https://host.com/embed-
  // <id>.html","type":"embed") rather than a bare .m3u8/.mp4 link, the
  // check two lines below this docstring never matches it at all -- but
  // this plugin's own shared hosts.py -> extract_stream() dispatch
  // already resolves many such embed hosts automatically with ZERO
  // site-specific code needed (confirmed live, directly, on a real
  // embed host this session). Surfacing the real captured sample here
  // means that's the very first thing tried, instead of assuming a
  // custom resolver has to be written from scratch.
  if (analysis.embedStreamSample) {
    code += `        \n`;
    code += `        DETECTED: a real embed-style stream source was captured:\n`;
    code += `            ${safeDocstringText(analysis.embedStreamSample)}\n`;
    code += `        Try passing a URL like this straight to the shared dispatch first --\n`;
    code += `        many embed hosts (e.g. voe.sx, egybestvid.com) already resolve\n`;
    code += `        correctly with NO site-specific code at all:\n`;
    code += `            from .hosts import extract_stream as base_extract_stream\n`;
    code += `            stream, quality, ref, variants = base_extract_stream(embed_url)\n`;
    code += `        Only write custom resolver logic below if that does not work for\n`;
    code += `        this specific host.\n`;
  }
  code += `        """\n`;
  code += `        try:\n`;
  if (analysis.streamOrigin && analysis.streamOrigin.origin) {
    const so = analysis.streamOrigin;
    const cmt = (t) => String(t).split('\n').map(l => `            # ${l}`).join('\n') + '\n';
    code += cmt('STREAM ORIGIN (traced from the recording -- start here):');
    if (so.setup) code += cmt(`1. ${so.setup.method} ${so.setup.url.slice(0, 160)}\n   -> ${so.setup.bodySample}`);
    code += cmt(`${so.setup ? '2' : '1'}. ${so.origin.method || 'GET'} ${so.origin.url.slice(0, 260)}`);
    code += cmt(so.origin.plain ? '   -> the reply contains the playlist URL' :
                so.origin.encrypted ? `   -> ENCRYPTED reply (${so.origin.bodySample.slice(0, 40)}...)` : '   -> reply (see xhrBodies)');
    code += cmt(`   -> playlist: ${so.playlistUrl.slice(0, 160)}`);
    for (const h of (so.decoderHints || [])) {
      code += cmt(`\nDecoder candidate in ${h.script} (around "${h.keyword}"):`);
      const flat = h.snippet.replace(/\s+/g, ' ');
      for (let i = 0; i < flat.length; i += 110) code += cmt('    ' + flat.slice(i, i + 110));
    }
    code += `            #\n`;
  }
  code += `            log("${siteNameDQ}: Extracting stream from: {}".format(url[:100]))\n`;
  code += `            \n`;
  code += `            if '.m3u8' in url or '.mp4' in url:\n`;
  code += `                return _correct_stream_url(url), "HD", url, []\n`;
  code += `            \n`;
  if (analysis.allDetectedHosts && analysis.allDetectedHosts.length > 0) {
    const hosts = analysis.allDetectedHosts;
    code += `            # DETECTED: real stream host(s) captured for this site:\n`;
    for (const h of hosts) {
      code += `            #     ${h}\n`;
    }
    code += `            # This file cannot check hosts.py itself (it runs in the browser\n`;
    code += `            # extension, not on your Enigma2 device) -- run this one command to\n`;
    code += `            # find out directly whether any are already supported there:\n`;
    if (hosts.length > 1) {
      code += `            #     grep -nE "${hosts.join('|')}" extractors/hosts.py\n`;
    } else {
      code += `            #     grep -n "${hosts[0]}" extractors/hosts.py\n`;
    }
    code += `            # A match means a resolver already exists -- use it via the shared\n`;
    code += `            # dispatch above instead of writing a new one.\n`;
  }
  // [NEW] additive, more precise than the generic refererSample above:
  // the REAL referer confirmed for each SPECIFIC host, not one assumed
  // to apply site-wide -- confirmed directly, more than once tonight,
  // that different hosts on the same site can need different referers
  // from each other.
  if (analysis.perHostStreamInfo && analysis.perHostStreamInfo.length > 0) {
    code += `            # \n`;
    code += `            # DETECTED: the real referer(s) confirmed for each specific host\n`;
    code += `            # (more precise than one referer assumed for the whole site):\n`;
    for (const h of analysis.perHostStreamInfo) {
      if (h.referers.length > 0) {
        code += `            #     ${h.host}: ${h.referers[0]}\n`;
      }
    }
  }
  code += `            # TODO: this plugin already has correct, shared, tested resolvers for common\n`;
  code += `            # hosts in extractors/hosts.py (resolve_streamruby, resolve_doodstream, resolve_mixdrop,\n`;
  code += `            # resolve_voe, and more) -- reuse those instead of writing new ones. base.py does not\n`;
  code += `            # always re-export them, so look them up the same safe way this codebase's other\n`;
  code += `            # extractors do:\n`;
  code += `            #\n`;
  code += `            #     import importlib\n`;
  code += `            #     def _safe_import(name):\n`;
  code += `            #         for mod in ('.hosts', '.htmlmedia', '.base'):\n`;
  code += `            #             found = getattr(importlib.import_module(mod, package=__package__), name, None)\n`;
  code += `            #             if found is not None:\n`;
  code += `            #                 return found\n`;
  code += `            #         return None\n`;
  code += `            #     resolve_streamruby = _safe_import('resolve_streamruby')\n`;
  code += `            #\n`;
  code += `            # then dispatch on url's hostname to whichever of those actually apply to THIS site\n`;
  code += `            # (check the captured network log to see which hosts this site's servers really use --\n`;
  code += `            # do not assume streamruby/doodstream/etc. without checking).\n`;
  code += `            \n`;
  code += `            html, final_url = fetch(url, referer=self.main_url, max_retries=2)\n`;
  code += `            if html:\n`;
  code += `                stream = find_m3u8(html) or find_mp4(html)\n`;
  code += `                if stream:\n`;
  code += `                    quality = "HD"\n`;
  code += `                    if "1080" in stream or "fhd" in stream.lower():\n`;
  code += `                        quality = "1080p"\n`;
  code += `                    elif "720" in stream or "hd" in stream.lower():\n`;
  code += `                        quality = "720p"\n`;
  code += `                    elif "480" in stream:\n`;
  code += `                        quality = "480p"\n`;
  code += `                    return _correct_stream_url(stream), quality, url, []\n`;
  code += `            \n`;
  code += `            return None, "", url, []\n`;
  code += `        except Exception as e:\n`;
  code += `            log("${siteNameDQ}: Extract stream error: {}".format(e))\n`;
  code += `            return None, "", url, []\n`;
  code += `\n`;

  if (analysis.tmdbSite && analysis.serverTemplate) {
    const stt = analysis.serverTemplate;
    code += `    def _extract_own_server(self, url):\n`;
    code += `        """The site's own server API (SERVERS) -- the steps traced in the recording."""\n`;
    code += `        from urllib.parse import parse_qs, urlparse as _up\n`;
    code += `        hdr = {"Origin": self.main_url.rstrip("/"), "Referer": self.main_url.rstrip("/") + "/"}\n`;
    if (stt.setupUrl) {
      code += `        tmdb_id = ""\n`;
      code += `        for k, v in parse_qs(_up(url).query).items():\n`;
      code += `            if "tmdb" in k.lower():\n`;
      code += `                tmdb_id = v[0]\n`;
      code += `        setup = fetch_json(self.SETUP_URL.replace("{tmdb_id}", tmdb_id), extra_headers=hdr) or {}\n`;
      code += `        value = setup.get(self.SETUP_KEY) if isinstance(setup, dict) else None\n`;
      code += `        if not value:\n`;
      code += `            log("${siteNameDQ}: setup call gave no {}".format(self.SETUP_KEY))\n`;
      code += `            return None, "", url, []\n`;
      code += `        url = url + "&" + self.SETUP_PARAM + "=" + quote(str(value), safe="")\n`;
    }
    code += `        text, _final = fetch(url, referer=self.main_url.rstrip("/") + "/", extra_headers=hdr)\n`;
    code += `        text = (text or "").strip()\n`;
    if (stt.encrypted) {
      code += `        if text and not text.startswith(("{", "[")):\n`;
      code += `            # TODO: the reply is ENCRYPTED -- port the decoder quoted in extract_stream()\n`;
      code += `            # (see NovaPlay's extractors/movy_api.py decrypt() for a finished example)\n`;
      code += `            log("${siteNameDQ}: encrypted reply, decoder not ported yet")\n`;
      code += `            return None, "", url, []\n`;
    }
    code += `        stream = find_m3u8(text) or find_mp4(text)\n`;
    code += `        if stream:\n`;
    code += `            stream = stream.replace("\\\\/", "/")\n`;
    code += `            return _correct_stream_url(stream) + "|Referer=" + hdr["Referer"] + "&Origin=" + hdr["Origin"], "HD", url, []\n`;
    code += `        return None, "", url, []\n\n`;
  }

  // ═══ Metadata ═══
  code += `\n# ─── Export Metadata ────────────────────────────────────────────────────────\n`;
  code += `EXTRACTOR_METADATA = {\n`;
  code += `    "name": ${toPythonStringLiteral(siteName)},\n`;
  code += `    "class": "${className}",\n`;
  code += `    "version": "4.0.0",\n`;
  code += `    "generated": "${new Date().toISOString()}",\n`;
  code += `    "type": "site_extractor",\n`;
  code += `    "analysis": {\n`;
  code += `        "categories": ${analysis.categories.length},\n`;
  code += `        "api_endpoints": ${analysis.apiEndpoints.length},\n`;
  code += `        "stream_resolvers": ${analysis.streamResolvers.length},\n`;
  // [FIX] a JS boolean interpolated into a template string produces lowercase "false"/"true"
  // (JS's own toString() for booleans), but Python needs capitalized False/True -- bare
  // lowercase false/true are NOT Python keywords, just undefined names, so this was
  // syntactically valid and invisible to ast.parse()-only validation; it only surfaced when
  // the generated file was actually imported and executed, which is exactly why that step
  // matters. Pre-existing in the file before tonight's four additions; found while actually
  // running the newly-generated methods, not just parsing them.
  code += `        "pagination": ${analysis.paginationPatterns.length > 0 ? 'True' : 'False'},\n`;
  code += `        "search": ${analysis.searchEndpoint ? 'True' : 'False'},\n`;
  code += `    }\n`;
  code += `}\n`;

  return code;
}

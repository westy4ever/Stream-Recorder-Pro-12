// regex-generator.js - Auto-Generate Regular Expressions

import { state } from './state.js';

// [FIX] a pattern measured from just 1-2 samples reported the exact same "100% confidence"
// as one measured from 50 real matches, which is misleading -- a single lucky match is not
// as reliable as a pattern seen across dozens of items. This doesn't hide low-sample
// patterns (a new/small site may genuinely only have a couple of items captured, and the
// pattern can still be useful), just flags them so the number isn't read as more solid than
// it is.
const MIN_RELIABLE_SAMPLE_SIZE = 3;

function annotateLowSample(description, total) {
  return total < MIN_RELIABLE_SAMPLE_SIZE
    ? description + ' [low sample size: ' + total + ']'
    : description;
}

export function generateRegexPatterns() {
  const s = state;
  const contentPipeline = s.contentPipeline || {};
  const xhrBodies = s.xhrBodies || [];

  const patterns = {
    titles: [],
    years: [],
    qualities: [],
    ratings: [],
    genres: [],
    urls: [],
    ids: [],
    bestPatterns: {}
  };

  // Analyze titles from content pipeline
  if (contentPipeline.movieList && contentPipeline.movieList.length > 0) {
    // [FIX] the same movie can appear more than once in movieList if it was captured across
    // multiple network requests/page loads during one recording session -- without
    // deduplicating first, a single real title/year/rating/quality value repeated several
    // times inflated its pattern's confidence score relative to a rarer but equally real
    // value, even though the underlying number of DISTINCT items seen never changed.
    const titles = [...new Set(contentPipeline.movieList.map(m => m.title).filter(Boolean))];
    patterns.titles = generateTitlePatterns(titles);

    const years = [...new Set(contentPipeline.movieList.map(m => m.year).filter(Boolean))];
    patterns.years = generateYearPatterns(years);

    const ratings = [...new Set(contentPipeline.movieList.map(m => m.rating).filter(Boolean))];
    patterns.ratings = generateRatingPatterns(ratings);

    const qualities = [...new Set(contentPipeline.movieList.map(m => m.quality).filter(Boolean))];
    patterns.qualities = generateQualityPatterns(qualities);
  }

  // Analyze URLs from network logs
  const streamUrlsRaw = [];
  for (const body of xhrBodies) {
    if (body.body) {
      const urls = body.body.match(/https?:\/\/[^\s"']+/g) || [];
      streamUrlsRaw.push(...urls);
    }
  }
  const streamUrls = [...new Set(streamUrlsRaw)];
  patterns.urls = generateURLPatterns(streamUrls);

  // Analyze IDs from URLs
  const idsRaw = [];
  for (const entry of s.networkLog || []) {
    // [FIX] entry.url was read unguarded -- any networkLog entry missing a url field (or with
    // a non-string url) threw here and crashed the entire generateRegexPatterns() call, not
    // just this one loop. Every other data source in this file (xhrBodies, contentPipeline)
    // already tolerates missing/empty fields; this loop did not.
    if (!entry || typeof entry.url !== 'string') continue;
    const idMatch = entry.url.match(/\/([a-fA-F0-9]{32,})\//);
    if (idMatch) idsRaw.push(idMatch[1]);
  }
  const ids = [...new Set(idsRaw)];
  patterns.ids = generateIDPatterns(ids);

  // Find best patterns
  patterns.bestPatterns = {
    title: findBestPattern(patterns.titles),
    year: findBestPattern(patterns.years),
    quality: findBestPattern(patterns.qualities),
    rating: findBestPattern(patterns.ratings),
    id: findBestPattern(patterns.ids),
    url: findBestPattern(patterns.urls)
  };

  return patterns;
}

function generateTitlePatterns(titles) {
  const patterns = [];

  // [FIX] the old arabicPattern had an OPTIONAL Arabic-word prefix and a [^\d]+ capture group
  // that requires no Arabic script at all -- confirmed directly it matched plain English
  // titles too (e.g. "The Matrix (1999)"), so the reported confidence for this pattern was
  // never actually measuring "is this an Arabic title", just "does this have a year in it",
  // which the separate englishPattern below already covers. Real titles from these sites are
  // commonly mixed-script ("فيلم Fall 2 Deadpoint 2026 مترجم" -- Arabic wrapper words around
  // an English movie name), so requiring Arabic script to appear immediately after the prefix
  // is too narrow too (tested and confirmed against a real captured title). Checking for Arabic
  // script ANYWHERE in the title, as a separate condition from the extraction pattern itself,
  // correctly classifies both pure-Arabic and mixed-script real titles while still excluding
  // pure-English ones -- verified against real captured titles from this session.
  const hasArabicScript = (t) => /[\u0600-\u06FF]/.test(t);
  const arabicPattern = /(?:فيلم|مسلسل|سلسلة)?\s*([^\d]+)\s*\(?(\d{4})\)?/;
  const matches = titles.filter(t => hasArabicScript(t) && t.match(arabicPattern));
  if (matches.length > 0) {
    patterns.push({
      // [FIX] this exported pattern string used to require "فيلم" as a mandatory literal
      // prefix, while the arabicPattern actually used to MEASURE the confidence above treats
      // it as optional -- the confidence number and the regex you'd actually copy into an
      // extractor were describing two different patterns. A title starting with "مسلسل" or
      // "سلسلة" instead of "فيلم" would count toward the reported confidence but silently fail
      // to match this exported string. Kept in sync with arabicPattern above.
      pattern: '(?:فيلم|مسلسل|سلسلة)?\\s*([^\\d]+)\\s*\\(?(\\d{4})\\)?',
      description: annotateLowSample('Arabic title with year', titles.length),
      matches: matches.length,
      total: titles.length,
      confidence: Math.round((matches.length / titles.length) * 100),
      sample: matches[0]
    });
  }

  // English titles with year
  const englishPattern = /(.+?)\s*\((\d{4})\)/;
  const englishMatches = titles.filter(t => t.match(englishPattern));
  if (englishMatches.length > 0) {
    patterns.push({
      pattern: '(.+?)\\s*\\((\\d{4})\\)',
      description: annotateLowSample('English title with year', titles.length),
      matches: englishMatches.length,
      total: titles.length,
      confidence: Math.round((englishMatches.length / titles.length) * 100),
      sample: englishMatches[0]
    });
  }

  // Simple title (any text)
  const simpleMatches = titles.filter(t => t.length > 2);
  if (simpleMatches.length > 0) {
    patterns.push({
      pattern: '(.+)',
      description: annotateLowSample('Simple title (any text)', titles.length),
      matches: simpleMatches.length,
      total: titles.length,
      confidence: Math.round((simpleMatches.length / titles.length) * 100),
      sample: simpleMatches[0],
      // [FIX] a catch-all extracts no real structure -- matching 100% of titles doesn't make
      // it useful for an extractor. findBestPattern() below deprioritizes anything flagged
      // isFallback in favor of a real, structured pattern whenever one exists, and only
      // falls back to this when nothing more useful matched anything at all.
      isFallback: true
    });
  }

  return patterns;
}

function generateYearPatterns(years) {
  const patterns = [];

  // Standard 4-digit year
  const yearMatches = years.filter(y => /^\d{4}$/.test(y));
  if (yearMatches.length > 0) {
    patterns.push({
      // [FIX] the filter above requires the ENTIRE string to be exactly 4 digits (anchored
      // with ^...$), but the exported pattern was unanchored -- it would also partially match
      // a longer string like "20260101", which the actual filter used to measure confidence
      // would have rejected. Anchored to match what was actually measured.
      pattern: '^(\\d{4})$',
      description: annotateLowSample('Standard 4-digit year', years.length),
      matches: yearMatches.length,
      total: years.length,
      confidence: Math.round((yearMatches.length / years.length) * 100),
      sample: yearMatches[0]
    });
  }

  // Year in parentheses
  const parenMatches = years.filter(y => /\((\d{4})\)/.test(y));
  if (parenMatches.length > 0) {
    patterns.push({
      pattern: '\\((\\d{4})\\)',
      description: annotateLowSample('Year in parentheses', years.length),
      matches: parenMatches.length,
      total: years.length,
      confidence: Math.round((parenMatches.length / years.length) * 100),
      sample: parenMatches[0]
    });
  }

  return patterns;
}

function generateQualityPatterns(qualities) {
  const patterns = [];

  const qualityMap = {
    '1080p': ['1080p?', 'FHD', 'FullHD'],
    '720p': ['720p?', 'HD'],
    '480p': ['480p?', 'SD'],
    '360p': ['360p?'],
    '2160p': ['2160p?', '4K', 'UHD']
  };

  for (const [quality, regexes] of Object.entries(qualityMap)) {
    const matches = qualities.filter(q => {
      const lower = q.toLowerCase();
      return regexes.some(r => lower.match(new RegExp(r, 'i')));
    });

    if (matches.length > 0) {
      patterns.push({
        pattern: regexes.join('|'),
        description: annotateLowSample(quality + ' quality', qualities.length),
        matches: matches.length,
        total: qualities.length,
        confidence: Math.round((matches.length / qualities.length) * 100),
        sample: matches[0],
        quality: quality
      });
    }
  }

  return patterns;
}

function generateRatingPatterns(ratings) {
  const patterns = [];

  // Decimal rating (e.g., 7.5)
  const decimalMatches = ratings.filter(r => /^\d+\.\d+$/.test(r));
  if (decimalMatches.length > 0) {
    patterns.push({
      pattern: '(\\d+\\.\\d+)',
      description: annotateLowSample('Decimal rating (e.g., 7.5)', ratings.length),
      matches: decimalMatches.length,
      total: ratings.length,
      confidence: Math.round((decimalMatches.length / ratings.length) * 100),
      sample: decimalMatches[0]
    });
  }

  // Integer rating (e.g., 8)
  const intMatches = ratings.filter(r => /^\d+$/.test(r));
  if (intMatches.length > 0) {
    patterns.push({
      pattern: '(\\d+)',
      description: annotateLowSample('Integer rating (e.g., 8)', ratings.length),
      matches: intMatches.length,
      total: ratings.length,
      confidence: Math.round((intMatches.length / ratings.length) * 100),
      sample: intMatches[0]
    });
  }

  return patterns;
}

function generateURLPatterns(urls) {
  const patterns = [];

  // M3U8 URLs
  const m3u8Urls = urls.filter(u => u.includes('.m3u8'));
  if (m3u8Urls.length > 0) {
    patterns.push({
      pattern: 'https?://[^\\s"\'<>]+\\.m3u8[^\\s"\'<>]*',
      description: annotateLowSample('HLS playlist URL (.m3u8)', urls.length),
      matches: m3u8Urls.length,
      total: urls.length,
      confidence: Math.round((m3u8Urls.length / urls.length) * 100),
      sample: m3u8Urls[0]
    });
  }

  // MP4 URLs
  const mp4Urls = urls.filter(u => u.includes('.mp4'));
  if (mp4Urls.length > 0) {
    patterns.push({
      pattern: 'https?://[^\\s"\'<>]+\\.mp4[^\\s"\'<>]*',
      description: annotateLowSample('MP4 video URL (.mp4)', urls.length),
      matches: mp4Urls.length,
      total: urls.length,
      confidence: Math.round((mp4Urls.length / urls.length) * 100),
      sample: mp4Urls[0]
    });
  }

  // Stream API URLs
  const streamApiUrls = urls.filter(u => u.includes('/api/') || u.includes('/stream/'));
  if (streamApiUrls.length > 0) {
    patterns.push({
      pattern: 'https?://[^\\s"\'<>]+/api/[^\\s"\'<>]*',
      description: annotateLowSample('API stream endpoint', urls.length),
      matches: streamApiUrls.length,
      total: urls.length,
      confidence: Math.round((streamApiUrls.length / urls.length) * 100),
      sample: streamApiUrls[0]
    });
  }

  return patterns;
}

function generateIDPatterns(ids) {
  const patterns = [];

  if (ids.length === 0) return patterns;

  // MD5 hash
  const md5Matches = ids.filter(id => /^[a-f0-9]{32}$/.test(id));
  if (md5Matches.length > 0) {
    patterns.push({
      pattern: '[a-f0-9]{32}',
      description: annotateLowSample('MD5 hash (32 chars)', ids.length),
      matches: md5Matches.length,
      total: ids.length,
      confidence: Math.round((md5Matches.length / ids.length) * 100),
      sample: md5Matches[0]
    });
  }

  // SHA1 hash
  const sha1Matches = ids.filter(id => /^[a-f0-9]{40}$/.test(id));
  if (sha1Matches.length > 0) {
    patterns.push({
      pattern: '[a-f0-9]{40}',
      description: annotateLowSample('SHA1 hash (40 chars)', ids.length),
      matches: sha1Matches.length,
      total: ids.length,
      confidence: Math.round((sha1Matches.length / ids.length) * 100),
      sample: sha1Matches[0]
    });
  }

  // Alphanumeric ID
  const alphaMatches = ids.filter(id => /^[A-Za-z0-9]{8,}$/.test(id));
  if (alphaMatches.length > 0) {
    patterns.push({
      pattern: '[A-Za-z0-9]{8,}',
      description: annotateLowSample('Alphanumeric ID (8+ chars)', ids.length),
      matches: alphaMatches.length,
      total: ids.length,
      confidence: Math.round((alphaMatches.length / ids.length) * 100),
      sample: alphaMatches[0]
    });
  }

  return patterns;
}

function findBestPattern(patterns) {
  if (!patterns || patterns.length === 0) return null;
  // [FIX] a deliberate catch-all pattern (currently only the title generator's "(.+)") can
  // report the numerically highest confidence -- it matches everything by design -- while
  // extracting no real structure. Preferring real, structured patterns over a flagged
  // fallback even when the fallback's raw confidence is higher; only falls back to it when
  // nothing structured is available at all, so a category with no other match still gets
  // something back instead of null.
  const structured = patterns.filter(p => !p.isFallback);
  const candidates = structured.length > 0 ? structured : patterns;
  return candidates.reduce((best, current) => {
    return (current.confidence || 0) > (best.confidence || 0) ? current : best;
  });
}

export function generateRegexReport() {
  const patterns = generateRegexPatterns();

  let report = '=== AUTO-GENERATED REGULAR EXPRESSIONS ===\n\n';

  report += '📝 TITLE PATTERNS:\n';
  for (const p of patterns.titles) {
    report += '  ' + p.pattern + '\n';
    report += '    ' + p.description + ' (' + p.confidence + '% confidence, ' + p.matches + '/' + p.total + ' matches)\n';
    report += '    Sample: "' + p.sample + '"\n';
  }

  report += '\n📅 YEAR PATTERNS:\n';
  for (const p of patterns.years) {
    report += '  ' + p.pattern + '\n';
    report += '    ' + p.description + ' (' + p.confidence + '% confidence, ' + p.matches + '/' + p.total + ' matches)\n';
    report += '    Sample: "' + p.sample + '"\n';
  }

  report += '\n🎯 QUALITY PATTERNS:\n';
  for (const p of patterns.qualities) {
    report += '  ' + p.pattern + '\n';
    report += '    ' + p.description + ' (' + p.confidence + '% confidence, ' + p.matches + '/' + p.total + ' matches)\n';
    report += '    Sample: "' + p.sample + '"\n';
  }

  report += '\n⭐ RATING PATTERNS:\n';
  for (const p of patterns.ratings) {
    report += '  ' + p.pattern + '\n';
    report += '    ' + p.description + ' (' + p.confidence + '% confidence, ' + p.matches + '/' + p.total + ' matches)\n';
    report += '    Sample: "' + p.sample + '"\n';
  }

  report += '\n🔗 URL PATTERNS:\n';
  for (const p of patterns.urls) {
    report += '  ' + p.pattern + '\n';
    report += '    ' + p.description + ' (' + p.confidence + '% confidence, ' + p.matches + '/' + p.total + ' matches)\n';
    report += '    Sample: "' + p.sample + '"\n';
  }

  if (patterns.ids.length > 0) {
    report += '\n🆔 ID PATTERNS:\n';
    for (const p of patterns.ids) {
      report += '  ' + p.pattern + '\n';
      report += '    ' + p.description + ' (' + p.confidence + '% confidence, ' + p.matches + '/' + p.total + ' matches)\n';
      report += '    Sample: "' + p.sample + '"\n';
    }
  }

  report += '\n🏆 BEST PATTERNS:\n';
  for (const [type, pattern] of Object.entries(patterns.bestPatterns)) {
    if (pattern) {
      report += '  ' + type + ': ' + pattern.pattern + '\n';
      report += '    Confidence: ' + pattern.confidence + '%\n';
      report += '    Description: ' + pattern.description + '\n';
    }
  }

  return report;
}

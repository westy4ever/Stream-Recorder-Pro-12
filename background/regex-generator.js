// regex-generator.js - Auto-Generate Regular Expressions
import { state } from './state.js';

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
    const titles = contentPipeline.movieList.map(m => m.title).filter(Boolean);
    patterns.titles = generateTitlePatterns(titles);
    
    const years = contentPipeline.movieList.map(m => m.year).filter(Boolean);
    patterns.years = generateYearPatterns(years);
    
    const ratings = contentPipeline.movieList.map(m => m.rating).filter(Boolean);
    patterns.ratings = generateRatingPatterns(ratings);
    
    const qualities = contentPipeline.movieList.map(m => m.quality).filter(Boolean);
    patterns.qualities = generateQualityPatterns(qualities);
  }

  // Analyze URLs from network logs
  const streamUrls = [];
  for (const body of xhrBodies) {
    if (body.body) {
      const urls = body.body.match(/https?:\/\/[^\s"']+/g) || [];
      streamUrls.push(...urls);
    }
  }
  patterns.urls = generateURLPatterns(streamUrls);

  // Analyze IDs from URLs
  const ids = [];
  for (const entry of s.networkLog || []) {
    const idMatch = entry.url.match(/\/([a-fA-F0-9]{32,})\//);
    if (idMatch) ids.push(idMatch[1]);
  }
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
  
  // Arabic titles with year - FIXED: escaped backslashes properly
  const arabicPattern = /(?:فيلم|مسلسل|سلسلة)?\s*([^\d]+)\s*\(?(\d{4})\)?/;
  const matches = titles.filter(t => t.match(arabicPattern));
  if (matches.length > 0) {
    patterns.push({
      pattern: 'فيلم\\s+(.+?)\\s*\\(?(\\d{4})\\)?',
      description: 'Arabic title with year',
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
      description: 'English title with year',
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
      description: 'Simple title (any text)',
      matches: simpleMatches.length,
      total: titles.length,
      confidence: Math.round((simpleMatches.length / titles.length) * 100),
      sample: simpleMatches[0]
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
      pattern: '(\\d{4})',
      description: 'Standard 4-digit year',
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
      description: 'Year in parentheses',
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
        pattern: regexes.map(r => r).join('|'),
        description: quality + ' quality',
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
      description: 'Decimal rating (e.g., 7.5)',
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
      description: 'Integer rating (e.g., 8)',
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
      description: 'HLS playlist URL (.m3u8)',
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
      description: 'MP4 video URL (.mp4)',
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
      description: 'API stream endpoint',
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
      description: 'MD5 hash (32 chars)',
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
      description: 'SHA1 hash (40 chars)',
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
      description: 'Alphanumeric ID (8+ chars)',
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
  return patterns.reduce((best, current) => {
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
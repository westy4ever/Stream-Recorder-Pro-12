// selector-discovery.js - Selector Discovery & Testing
import { state } from './state.js';

export function discoverSelectors() {
  const s = state;
  const contentPipeline = s.contentPipeline || {};
  const xhrBodies = s.xhrBodies || [];
  const networkLog = s.networkLog || [];
  const actions = s.actions || [];

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
    // ═══ NEW: Store samples for debugging ═══
    samples: {
      htmlSample: null,
      movieSample: null,
      urlSample: null
    }
  };

  // ═══ NEW: Look for HTML content in network logs ═══
  for (const entry of networkLog) {
    if (entry.url && entry.url.includes('/category/') || entry.url.includes('/movie/') || entry.url.includes('/watch/')) {
      // This is likely a page load
      const body = xhrBodies.find(b => b.url === entry.url);
      if (body && body.body && body.body.length > 1000) {
        const htmlSelectors = extractSelectorsFromHTML(body.body);
        selectors.itemContainers.push(...htmlSelectors.itemContainers);
        selectors.titles.push(...htmlSelectors.titles);
        selectors.posters.push(...htmlSelectors.posters);
        selectors.ratings.push(...htmlSelectors.ratings);
        selectors.years.push(...htmlSelectors.years);
        selectors.genres.push(...htmlSelectors.genres);
        selectors.links.push(...htmlSelectors.links);
        
        // Store sample for debugging
        if (!selectors.samples.htmlSample) {
          selectors.samples.htmlSample = body.body.substring(0, 1000);
          selectors.samples.urlSample = entry.url;
        }
      }
    }
  }

  // ═══ NEW: Look for patterns in xhrBodies (JSON responses) ═══
  for (const body of xhrBodies) {
    if (body.body && body.body.length > 100) {
      // Try to parse as JSON
      try {
        const data = JSON.parse(body.body);
        if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object') {
          // This might be a list of items
          selectors.samples.movieSample = JSON.stringify(data[0], null, 2);
          // Extract field names as potential selectors
          for (const key of Object.keys(data[0])) {
            if (key === 'title' || key === 'name') {
              selectors.titles.push({
                selector: `[data-${key}]`,
                confidence: 70,
                source: 'json',
                matches: data.length
              });
            }
            if (key === 'poster' || key === 'image' || key === 'cover') {
              selectors.posters.push({
                selector: `[data-${key}]`,
                confidence: 70,
                source: 'json',
                matches: data.length
              });
            }
            if (key === 'rating' || key === 'score' || key === 'vote') {
              selectors.ratings.push({
                selector: `[data-${key}]`,
                confidence: 70,
                source: 'json',
                matches: data.length
              });
            }
            if (key === 'year' || key === 'release_date') {
              selectors.years.push({
                selector: `[data-${key}]`,
                confidence: 70,
                source: 'json',
                matches: data.length
              });
            }
          }
        }
      } catch (e) {
        // Not JSON, check if it's HTML
        if (body.body.includes('<div') && body.body.includes('<a')) {
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

  // ═══ NEW: Look at content pipeline ═══
  if (contentPipeline.movieList && contentPipeline.movieList.length > 0) {
    const samples = contentPipeline.movieList;
    
    const titlePatterns = analyzeField(samples, 'title');
    if (titlePatterns) {
      selectors.titles.push(...titlePatterns);
    }
    
    const posterPatterns = analyzeField(samples, 'poster');
    if (posterPatterns) {
      selectors.posters.push(...posterPatterns);
    }
    
    const ratingPatterns = analyzeField(samples, 'rating');
    if (ratingPatterns) {
      selectors.ratings.push(...ratingPatterns);
    }
    
    const yearPatterns = analyzeField(samples, 'year');
    if (yearPatterns) {
      selectors.years.push(...yearPatterns);
    }
    
    const genrePatterns = analyzeField(samples, 'genre');
    if (genrePatterns) {
      selectors.genres.push(...genrePatterns);
    }
    
    selectors.bestSelector = findBestContainerSelector(samples);
    selectors.samples.movieSample = JSON.stringify(samples[0], null, 2);
  }

  // ═══ NEW: Look at actions for navigation patterns ═══
  for (const action of actions) {
    if (action.href && action.href.includes('/category/')) {
      selectors.links.push({
        selector: `a[href*="/category/"]`,
        confidence: 80,
        source: 'action',
        matches: 1
      });
    }
    if (action.href && action.href.includes('/movie/')) {
      selectors.links.push({
        selector: `a[href*="/movie/"]`,
        confidence: 80,
        source: 'action',
        matches: 1
      });
    }
  }

  // Deduplicate and rank selectors
  selectors.itemContainers = rankSelectors(selectors.itemContainers);
  selectors.titles = rankSelectors(selectors.titles);
  selectors.posters = rankSelectors(selectors.posters);
  selectors.ratings = rankSelectors(selectors.ratings);
  selectors.years = rankSelectors(selectors.years);
  selectors.genres = rankSelectors(selectors.genres);
  selectors.links = rankSelectors(selectors.links);

  return selectors;
}

function analyzeField(samples, field) {
  const patterns = [];
  const values = samples.filter(s => s[field]).map(s => s[field]);
  
  if (values.length === 0) return null;
  
  if (field === 'poster' && values.every(v => v.startsWith('http'))) {
    patterns.push({
      type: 'url',
      selector: 'img[src*="' + extractDomain(values[0]) + '"]',
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
  
  // Find container patterns
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
  
  // Find title patterns
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
  
  // Find poster patterns
  const posterMatches = html.match(/<img[^>]*class=["']([^"']*?(?:poster|thumb|img|cover)[^"']*?)["']/gi) || [];
  for (const match of posterMatches) {
    const className = match.replace(/class=["']/, '').replace(/["']/, '');
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
  
  // Find rating patterns
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
  
  // Find year patterns
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
  
  // Find genre patterns
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
  
  // Find link patterns
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

function rankSelectors(selectors) {
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

function extractDomain(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return '';
  }
}

export function generateSelectorReport() {
  const selectors = discoverSelectors();
  
  let report = '=== SELECTOR DISCOVERY & TESTING ===\n\n';
  
  report += `📊 Data Summary:\n`;
  report += `  HTML Samples: ${selectors.samples.htmlSample ? '✅' : '❌'}\n`;
  report += `  Movie Samples: ${selectors.samples.movieSample ? '✅' : '❌'}\n`;
  report += `  URL Sample: ${selectors.samples.urlSample || 'None'}\n\n`;
  
  if (selectors.itemContainers.length === 0) {
    report += '⚠️ No selectors found. Try:\n';
    report += '  1. Browse more pages (categories, movies, detail pages)\n';
    report += '  2. Make sure auto-snapshot is enabled\n';
    report += '  3. Record for longer before stopping\n\n';
  }
  
  report += '🎬 ITEM CONTAINERS:\n';
  for (const s of selectors.itemContainers.slice(0, 5)) {
    report += `  ${s.selector} (${s.confidence}% confidence)\n`;
  }
  
  report += '\n📝 TITLES:\n';
  for (const s of selectors.titles.slice(0, 5)) {
    report += `  ${s.selector} (${s.confidence}% confidence)\n`;
  }
  
  report += '\n📷 POSTERS:\n';
  for (const s of selectors.posters.slice(0, 5)) {
    report += `  ${s.selector} (${s.confidence}% confidence)\n`;
  }
  
  report += '\n⭐ RATINGS:\n';
  for (const s of selectors.ratings.slice(0, 5)) {
    report += `  ${s.selector} (${s.confidence}% confidence)\n`;
  }
  
  report += '\n📅 YEARS:\n';
  for (const s of selectors.years.slice(0, 5)) {
    report += `  ${s.selector} (${s.confidence}% confidence)\n`;
  }
  
  report += '\n🔗 LINKS:\n';
  for (const s of selectors.links.slice(0, 5)) {
    report += `  ${s.selector} (${s.confidence}% confidence)\n`;
  }
  
  if (selectors.bestSelector) {
    report += '\n🏆 BEST CONTAINER SELECTOR:\n';
    report += `  ${selectors.bestSelector.selector}\n`;
    report += `  Confidence: ${selectors.bestSelector.confidence}%\n`;
    report += `  Matches: ${selectors.bestSelector.matches}/${selectors.bestSelector.total}\n`;
  }
  
  // Show sample HTML for debugging
  if (selectors.samples.htmlSample) {
    report += '\n📄 HTML SAMPLE (first 500 chars):\n';
    report += selectors.samples.htmlSample.substring(0, 500) + '...\n';
  }
  
  if (selectors.samples.movieSample) {
    report += '\n🎬 MOVIE SAMPLE:\n';
    report += selectors.samples.movieSample.substring(0, 500) + '...\n';
  }
  
  return report;
}
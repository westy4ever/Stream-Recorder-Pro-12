// site-detection.js - Enhanced Site detection & extraction functions
import { state, scheduleSave } from './state.js';
import { ARABIC_MOVIE_SITES, SAVEFILES_DOMAINS, SUSPECTED_BACKEND_DOMAINS, DOWNLOAD_PATTERNS, TORRENT_BODY_PATTERNS } from './config.js';

// Streaming sites
export const STREAMING_SITES = [
  'tv10.egydead.live', 'egydead.live', 'tv.egydead.live',
  'wecima.click', 'wecima.cx', 'wecima.me', 'wecima.bid', 'wecima.site',
  'mycima.cx', 'mycima.me', 'mycima.xyz',
  'topcinema.fan', 'topcinemaa.top',
  'faselhd.rip', 'faselhdx.bid',
  'shaheed4u.solar', 'shahid4u.solar',
  'akwam.com.co', 'akwam.one',
  'arabseed.cam', 'arabseeds.cam'
];

// ═══ NEW: Ad and spam domains to filter out ═══
export const AD_DOMAINS = [
  'hai8g.com',
  'aubergevalcarroll.com',
  'adservice.google.com',
  'googleads.g.doubleclick.net',
  'googlesyndication.com',
  'doubleclick.net',
  'adzerk.net',
  'taboola.com',
  'outbrain.com',
  'criteo.com',
  'casalemedia.com',
  'rubiconproject.com',
  'openx.net',
  'pubmatic.com',
  'indexexchange.com',
  'contextweb.com',
  'sovrn.com',
  'adnxs.com',
  'bidswitch.net',
  'adform.net',
  'adroll.com',
  'adsrvr.org',
  'advertising.com',
  'fastclick.net',
  'yieldmanager.com',
  'adtech.com',
  'adserver.com',
  'advertise.com',
  'sponsor.com',
  'popunder.com',
  'popup.com',
  'redirect.com',
  'tracking.com',
  'analytics.com',
  'statcounter.com',
  'googletagmanager.com',
  'google-analytics.com',
  'doubleclick.net',
  'facebook.com/tr',
  'amazon-adsystem.com',
  'adsrvr.org',
  'scorecardresearch.com',
  'moatads.com',
  'addthis.com',
  'sharethis.com'
];

// ═══ NEW: Content domains that should trigger snapshots ═══
export const CONTENT_DOMAINS = [
  'tv10.egydead.live', 'egydead.live', 'tv.egydead.live',
  'wecima.click', 'wecima.cx', 'wecima.me', 'wecima.bid', 'wecima.site',
  'mycima.cx', 'mycima.me', 'mycima.xyz',
  'topcinema.fan', 'topcinemaa.top',
  'faselhd.rip', 'faselhdx.bid',
  'shaheed4u.solar', 'shahid4u.solar',
  'akwam.com.co', 'akwam.one',
  'arabseed.cam', 'arabseeds.cam',
  'yts.lu', 'yify.sc', 'yts.mx',
  'savefiles.com'
];

export function isYTSSite(urlStr) {
  try {
    const hostname = new URL(urlStr).hostname;
    return /yts\.lu|yify\.sc|yts\.mx/.test(hostname);
  } catch (e) {
    return false;
  }
}

export function isArabicMovieSite(urlStr) {
  try {
    const hostname = new URL(urlStr).hostname;
    return ARABIC_MOVIE_SITES.some(site => hostname.includes(site));
  } catch {
    return false;
  }
}

export function isSaveFilesSite(urlStr) {
  try {
    const hostname = new URL(urlStr).hostname;
    return SAVEFILES_DOMAINS.some(site => hostname.includes(site));
  } catch {
    return false;
  }
}

export function isSuspectedBackend(urlStr) {
  try {
    const hostname = new URL(urlStr).hostname;
    return SUSPECTED_BACKEND_DOMAINS.some(d => hostname.includes(d));
  } catch {
    return false;
  }
}

export function isDownloadUrl(url) {
  if (!url) return false;
  return DOWNLOAD_PATTERNS.some(pattern => pattern.test(url));
}

export function isTorrentResponse(body) {
  if (!body || typeof body !== 'string') return false;
  let hits = 0;
  for (const p of TORRENT_BODY_PATTERNS) {
    if (p.test(body)) hits++;
    if (hits >= 2) return true;
  }
  return false;
}

export function buildMagnetLink(infoHash, title, trackers = []) {
  let magnet = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}`;
  const defaultTrackers = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://tracker.coppersurfer.tk:6969/announce',
    'udp://tracker.leechers-paradise.org:6969/announce',
    'udp://tracker.openbittorrent.com:6969/announce'
  ];
  for (const tracker of [...defaultTrackers, ...trackers]) {
    magnet += `&tr=${encodeURIComponent(tracker)}`;
  }
  return magnet;
}

export function isStreamingSite(urlStr) {
  try {
    const hostname = new URL(urlStr).hostname;
    return STREAMING_SITES.some(site => hostname.includes(site));
  } catch {
    return false;
  }
}

export const API_PATTERNS = [
  /\/api\//i,
  /\/ajax\//i,
  /\/wp-json\//i,
  /\/graphql/i,
  /\/v\d+\//i,
  /\.json/i,
  /\/rest\//i,
  /\/service\//i,
  /\/stream\//i,
  /\/play\//i,
  /\/source\//i,
  /\/embed\//i,
  /\/hls\//i,
  /\/manifest\//i,
  /\/master\.m3u8/i,
  /\/playlist\.m3u8/i
];

export function isAPIRequest(urlStr) {
  return API_PATTERNS.some(pattern => pattern.test(urlStr));
}

export function detectSiteType(urlStr) {
  try {
    const hostname = new URL(urlStr).hostname;
    
    if (isYTSSite(urlStr)) return 'yts';
    if (isArabicMovieSite(urlStr)) return 'arabic_movie';
    if (isSaveFilesSite(urlStr)) return 'savefiles';
    if (isStreamingSite(urlStr)) return 'streaming';
    
    if (hostname.includes('yts') || hostname.includes('yify')) return 'yts';
    if (hostname.includes('wecima') || hostname.includes('mycima')) return 'arabic_movie';
    if (hostname.includes('savefiles')) return 'savefiles';
    if (hostname.includes('stream') || hostname.includes('cdn') || hostname.includes('hls')) return 'streaming';
    
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

// ═══ NEW: Check if domain is an ad domain ═══
export function isAdDomain(urlStr) {
  if (!urlStr) return false;
  try {
    const hostname = new URL(urlStr).hostname;
    return AD_DOMAINS.some(domain => hostname.includes(domain));
  } catch {
    return false;
  }
}

// ═══ NEW: Check if domain is a content domain ═══
export function isContentDomain(urlStr) {
  if (!urlStr) return false;
  try {
    const hostname = new URL(urlStr).hostname;
    return CONTENT_DOMAINS.some(domain => hostname.includes(domain));
  } catch {
    return false;
  }
}

// ═══ NEW: Check if URL is a popup or redirect ═══
export function isPopupOrRedirect(urlStr) {
  if (!urlStr) return false;
  const lower = urlStr.toLowerCase();
  // Check for popup patterns
  if (lower.includes('popup') || lower.includes('popunder') || lower.includes('redirect')) {
    return true;
  }
  // Check for ad parameters
  if (lower.includes('zoneid=') || lower.includes('var=') || lower.includes('syncedCookie=')) {
    return true;
  }
  // Check for ad-related path patterns
  if (lower.includes('/afu.php') || lower.includes('/ad/') || lower.includes('/ads/')) {
    return true;
  }
  // Check for tracking parameters
  if (lower.includes('utm_') || lower.includes('ref=') || lower.includes('source=')) {
    return true;
  }
  return false;
}

// ═══ NEW: Check if URL is a media/stream URL ═══
export function isMediaUrl(urlStr) {
  if (!urlStr) return false;
  const lower = urlStr.toLowerCase();
  return lower.includes('.m3u8') || lower.includes('.mp4') || lower.includes('.ts') || 
         lower.includes('hls') || lower.includes('playlist') || lower.includes('stream');
}

// ═══ YTS DATA EXTRACTION ═══
export async function extractYTSTorrents(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const results = [];
        const selectors = [
          '.browse-movie-wrap', '.card', '.torrent-card', '.torrent-grid',
          '.modal-overlay', '.modal', '.magnet-btn', '.play-torrent',
          '.movie-item', '.movie-list-item', '.film-item', '[data-movie-id]',
          '.movie-poster', '.film-list-item', '.movie-card', '.film-list'
        ];

        let movieElements = [];
        for (const selector of selectors) {
          const elements = document.querySelectorAll(selector);
          if (elements.length > 0) {
            movieElements = elements;
            break;
          }
        }

        if (movieElements.length === 0) {
          const containers = document.querySelectorAll('.movie-list, .film-grid, .movie-grid, .content-wrapper, .browse-movies, #movies-container, .torrent-grid');
          for (const container of containers) {
            const items = container.querySelectorAll('a[href*="/movie/"], a[href*="/watch/"], a[href*="magnet:"], a[href*=".torrent"], .torrent-card, .download-item');
            if (items.length > 0) {
              movieElements = items;
              break;
            }
          }
        }

        movieElements.forEach(item => {
          let title = '';
          const titleSelectors = ['.browse-movie-title', '.card-title', '.modal-title', '.torrent-name', '.title', '.movie-title', 'h3', 'h4', '.name', '[data-title]', '.film-title'];
          for (const sel of titleSelectors) {
            const el = item.querySelector(sel);
            if (el) {
              title = el.textContent.trim();
              break;
            }
          }
          if (!title && item.tagName === 'A' && item.href) {
            const match = item.href.match(/\/movie\/([^\/]+)/) || item.textContent.trim();
            title = typeof match === 'string' ? match : (match[1] ? decodeURIComponent(match[1].replace(/-/g, ' ')) : '');
          }

          let year = '';
          const yearSelectors = ['.browse-movie-year', '.year-badge', '.year', '.movie-year', '[data-year]', '.date', '.release-year'];
          for (const sel of yearSelectors) {
            const el = item.querySelector(sel);
            if (el) {
              const text = el.textContent.trim();
              if (text.match(/\d{4}/)) {
                year = text.match(/\d{4}/)[0];
                break;
              }
            }
          }

          let quality = '';
          const qualitySelectors = ['.torrent-quality', '.quality', '.resolution', '.format', '.badge', '[data-quality]', '.video-quality'];
          for (const sel of qualitySelectors) {
            const el = item.querySelector(sel);
            if (el) {
              quality = el.textContent.trim();
              break;
            }
          }

          let poster = '';
          const posterSelectors = ['img', '.poster img', '.movie-poster img', '[data-poster]'];
          for (const sel of posterSelectors) {
            const el = item.querySelector(sel);
            if (el && el.src) {
              poster = el.src;
              break;
            }
          }

          const links = [];
          const linkSelectors = ['a[href*="magnet:"]', 'a[href*=".torrent"]', '.magnet-btn', '.play-torrent', '.download-link', '.torrent-link', '.magnet-link'];
          for (const sel of linkSelectors) {
            const els = item.querySelectorAll(sel);
            els.forEach(el => {
              links.push({
                url: el.href,
                text: el.textContent.trim() || (el.href.includes('magnet:') ? 'Magnet' : 'Torrent'),
                quality: el.dataset.quality || quality
              });
            });
          }

          if (links.length > 0) {
            results.push({
              title: title || 'Unknown Title',
              year: year || '',
              quality: quality || '',
              links: links,
              url: window.location.href,
              poster: poster,
              element: item.tagName
            });
          }
        });

        return results;
      }
    });

    if (results && results[0] && results[0].result) {
      const data = results[0].result;
      const s = state;
      if (s.recording) {
        s.actions.push({
          timestamp: Date.now(),
          type: 'yts_data_extracted',
          data: data,
          url: `tab_${tabId}`
        });
        scheduleSave();
      }
      return data;
    }
    return null;
  } catch (e) {
    console.error('YTS extraction error:', e);
    return null;
  }
}

// ═══ ARABIC MOVIE DATA EXTRACTION ═══
export async function extractArabicMovieData(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const movies = [];
        const links = document.querySelectorAll('a[href*="/watch/"]');
        
        for (const link of links) {
          const text = link.textContent || '';
          const href = link.href || '';
          
          if (text.includes('الصفحة الرئيسية') || text.includes('أفلام')) continue;
          
          const patterns = {
            rating: /(\d+\.\d+)/,
            quality: /(WEB-DL|HDCAM|BluRay|WEBRip|DVD|TS)/i,
            genre: /(دراما|أكشن|كوميدي|رعب|إثارة|مغامرة|جريمة|رومانسي|خيال علمي|غموض|تشويق|عائلي|أنميشن|فانتازيا|حروب|رياضة|ترفيهي|غربي|موسيقي|ديني|تاريخي|قصير)/i,
            year: /\b(19|20)\d{2}\b/,
            title: /فيلم\s+(.+?)\s+(?:مترجم|اون لاين|جديد|202\d|201\d|199\d|200\d)/
          };
          
          const rating = text.match(patterns.rating)?.[1] || '';
          const quality = text.match(patterns.quality)?.[1] || '';
          const genre = text.match(patterns.genre)?.[1] || '';
          const year = text.match(patterns.year)?.[0] || '';
          
          let title = '';
          const titleMatch = text.match(patterns.title);
          if (titleMatch) {
            title = titleMatch[1].trim();
          } else {
            const parts = text.split('فيلم');
            if (parts.length > 1) {
              const part = parts[1].trim();
              const yearIndex = part.search(/\b(19|20)\d{2}\b/);
              title = yearIndex > 0 ? part.substring(0, yearIndex).trim() : part;
            }
          }
          
          title = title.replace(/مترجم$/, '').replace(/اون لاين$/, '').replace(/جديد$/, '').trim();
          
          if (title && href) {
            movies.push({
              title,
              year,
              rating,
              quality,
              genre,
              url: href,
              type: 'arabic_movie'
            });
          }
        }
        
        return movies;
      }
    });

    if (results && results[0] && results[0].result) {
      const data = results[0].result;
      const s = state;
      if (s.recording && data.length > 0) {
        s.actions.push({
          timestamp: Date.now(),
          type: 'arabic_movies_extracted',
          data: data,
          url: `tab_${tabId}`
        });
        s.contentPipeline.movieList = data;
        s.contentPipeline.source = 'wecima';
        s.contentPipeline.sequence.push({
          timestamp: Date.now(),
          type: 'movies_extracted',
          data: data
        });
        scheduleSave();
      }
      return data;
    }
    return null;
  } catch (e) {
    console.error('Arabic movie extraction error:', e);
    return null;
  }
}

// ═══ SAVEFILES EXTRACTION ═══
export async function extractSaveFilesData(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const data = {
          downloadUrl: null,
          metadata: {},
          filename: null,
          filesize: null,
          expiry: null
        };

        const downloadBtn = document.querySelector('.btn-primary.download-btn, a[href*="/v/"]');
        if (downloadBtn) {
          data.downloadUrl = downloadBtn.href || '';
          const filenameMatch = data.downloadUrl.match(/\/([^\/]+?)(\?|$)/);
          if (filenameMatch) data.filename = filenameMatch[1];
        }

        const rows = document.querySelectorAll('table tr');
        rows.forEach(row => {
          const cells = row.querySelectorAll('td');
          if (cells.length === 2) {
            const label = cells[0].textContent.trim();
            const value = cells[1].textContent.trim();
            if (label.includes('Filesize')) data.filesize = value;
            if (label.includes('Exact size')) data.metadata.exactSize = value;
            if (label.includes('Your IP')) data.metadata.yourIP = value;
          }
        });

        const expiryMatch = document.body.innerText.match(/available for your IP next (\d+) hours/);
        if (expiryMatch) data.expiry = parseInt(expiryMatch[1]);

        return data;
      }
    });

    if (results && results[0] && results[0].result) {
      const data = results[0].result;
      const s = state;
      if (s.recording && data.downloadUrl) {
        s.actions.push({
          timestamp: Date.now(),
          type: 'savefiles_download',
          data: data,
          url: `tab_${tabId}`
        });
        s.contentPipeline.downloadLinks.push(data);
        s.contentPipeline.metadata = data.metadata;
        s.contentPipeline.sequence.push({
          timestamp: Date.now(),
          type: 'savefiles_extracted',
          data: data
        });
        scheduleSave();
      }
      return data;
    }
    return null;
  } catch (e) {
    console.error('SaveFiles extraction error:', e);
    return null;
  }
}

// ═══ BATCH YTS EXTRACTION ═══
export async function extractAllYTSPages(tabId, maxPages = 10) {
  const allMovies = [];
  
  for (let page = 1; page <= maxPages; page++) {
    const data = await extractYTSTorrents(tabId);
    if (data && data.length > 0) {
      allMovies.push(...data);
    } else {
      break;
    }
    
    const nextBtn = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const btn = document.querySelector('.next, .pagination .next, .page-next');
        if (btn && !btn.disabled) {
          btn.click();
          return true;
        }
        return false;
      }
    });
    
    if (!nextBtn || !nextBtn[0] || !nextBtn[0].result) break;
    await new Promise(r => setTimeout(r, 1500));
  }
  
  return allMovies;
}
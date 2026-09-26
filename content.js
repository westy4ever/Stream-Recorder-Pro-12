// content.js – Captures clicks, form submits, navigation, and Cloudflare challenges
// Enhanced with Arabic movie sites, SaveFiles.com, SPA detection
// Plus: Visual recording indicator, WebSocket support, and more
// UPDATED: v4.0.0 - Enhanced SPA detection, selector discovery, route mapping

console.log("Stream Recorder Pro content script v4.0.0 loaded on", window.location.href);

// ═══ RELAY FOR PAGE-HOOK.JS ═══
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== "stream-recorder-page-hook") return;
  chrome.runtime.sendMessage({ type: "xhrResponseBody", ...data.payload }).catch(() => {});
});

function relayRecordingState(isRecording, maxBodySize) {
  window.postMessage({
    source: "stream-recorder-control",
    recording: !!isRecording,
    maxBodySize: maxBodySize || null
  }, "*");
}

chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === "recordingStateChanged") {
    relayRecordingState(message.recording, message.maxBodySize);
    if (message.recording) {
      showRecordingIndicator();
    } else {
      hideRecordingIndicator();
    }
  }
});

chrome.runtime.sendMessage({ type: "getRecordingStatus" }, (response) => {
  if (chrome.runtime.lastError) return;
  if (response) {
    relayRecordingState(response.recording, response.maxBodySize);
    if (response.recording) {
      showRecordingIndicator();
    }
  }
});

chrome.runtime.sendMessage({ type: "pageLoaded", url: window.location.href }).catch(() => {});

// ═══ RECORDING INDICATOR ═══
let indicatorElement = null;

// [FIX] the indicator used to be pointer-events:none -- completely static, no way to move it
// out of the way if it happened to sit over something on the page you were trying to click
// (a Watch button, a download link near that corner), and no way to shrink it either. Now
// draggable (click-and-drag the badge itself) and has a small minimize toggle (the "–" button)
// that shrinks it to a small dot while keeping the visual "recording is active" reminder.
// Position is remembered for the rest of this page load via sessionStorage, so navigating
// within the same tab keeps it where you put it instead of resetting to the corner each time.
const INDICATOR_POS_KEY = '__srIndicatorPos';
const INDICATOR_MIN_KEY = '__srIndicatorMinimized';

function showRecordingIndicator() {
  if (indicatorElement) return;

  let savedPos = null;
  let savedMinimized = false;
  try {
    const raw = sessionStorage.getItem(INDICATOR_POS_KEY);
    if (raw) savedPos = JSON.parse(raw);
    savedMinimized = sessionStorage.getItem(INDICATOR_MIN_KEY) === '1';
  } catch (e) { /* sessionStorage unavailable (e.g. sandboxed frame) -- fall back to default */ }

  indicatorElement = document.createElement('div');
  indicatorElement.id = 'stream-recorder-indicator';
  indicatorElement.style.cssText = `
    position: fixed; z-index: 999999;
    background: #ff0000; color: white; border-radius: 4px;
    font-size: 12px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
    opacity: 0.85; pointer-events: auto;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    border: 1px solid rgba(255,255,255,0.2);
    font-weight: bold; cursor: move; user-select: none;
    display: flex; align-items: center; gap: 6px; padding: 6px 8px;
  `;

  if (savedPos && typeof savedPos.top === 'number' && typeof savedPos.left === 'number') {
    indicatorElement.style.top = savedPos.top + 'px';
    indicatorElement.style.left = savedPos.left + 'px';
  } else {
    indicatorElement.style.bottom = '10px';
    indicatorElement.style.right = '10px';
  }

  const label = document.createElement('span');
  label.id = 'stream-recorder-indicator-label';

  const minimizeBtn = document.createElement('span');
  minimizeBtn.id = 'stream-recorder-indicator-toggle';
  minimizeBtn.title = 'Minimize / restore';
  minimizeBtn.style.cssText = `
    cursor: pointer; pointer-events: auto; padding: 0 3px;
    border-left: 1px solid rgba(255,255,255,0.35); font-weight: normal;
  `;

  function applyMinimizedState(minimized) {
    if (minimized) {
      label.textContent = '🔴';
      minimizeBtn.textContent = '+';
      indicatorElement.style.padding = '4px 6px';
    } else {
      label.textContent = '🔴 REC';
      minimizeBtn.textContent = '–';
      indicatorElement.style.padding = '6px 8px';
    }
    try { sessionStorage.setItem(INDICATOR_MIN_KEY, minimized ? '1' : '0'); } catch (e) {}
  }

  applyMinimizedState(savedMinimized);

  minimizeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    applyMinimizedState(minimizeBtn.textContent === '–');
  });

  indicatorElement.appendChild(label);
  indicatorElement.appendChild(minimizeBtn);
  document.body.appendChild(indicatorElement);

  // ─── Drag to move ───
  let dragging = false;
  let dragOffsetX = 0, dragOffsetY = 0;
  let moved = false;

  indicatorElement.addEventListener('mousedown', (e) => {
    if (e.target === minimizeBtn) return; // don't start a drag from the minimize button
    dragging = true;
    moved = false;
    const rect = indicatorElement.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    moved = true;
    // switch from bottom/right to top/left positioning once a drag starts, so it can be
    // placed anywhere rather than staying anchored to a corner
    indicatorElement.style.bottom = '';
    indicatorElement.style.right = '';
    const maxLeft = window.innerWidth - indicatorElement.offsetWidth;
    const maxTop = window.innerHeight - indicatorElement.offsetHeight;
    const left = Math.min(Math.max(0, e.clientX - dragOffsetX), Math.max(0, maxLeft));
    const top = Math.min(Math.max(0, e.clientY - dragOffsetY), Math.max(0, maxTop));
    indicatorElement.style.left = left + 'px';
    indicatorElement.style.top = top + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    if (moved) {
      try {
        const rect = indicatorElement.getBoundingClientRect();
        sessionStorage.setItem(INDICATOR_POS_KEY, JSON.stringify({ top: rect.top, left: rect.left }));
      } catch (e) {}
    }
  });
}

function hideRecordingIndicator() {
  if (indicatorElement) {
    indicatorElement.remove();
    indicatorElement = null;
  }
}

// ═══ SITE DETECTION ═══
function isArabicMovieSite() {
  const hostname = window.location.hostname;
  return /wecima|mycima/.test(hostname);
}

function isSaveFilesSite() {
  const hostname = window.location.hostname;
  return /savefiles/.test(hostname);
}

function isYTSSite() {
  const hostname = window.location.hostname;
  return /yts\.lu|yify\.sc|yts\.mx/.test(hostname);
}

// ═══ ENHANCED: Detect streaming sites ═══
function isStreamingSite() {
  const hostname = window.location.hostname;
  // [FIX] "shahid" (single i) never matched real mirror spellings like sshahiid4u.net
  // (double i) -- confirmed directly, this domain was silently classified as 'unknown'
  // site type, skipping every special-case detection path. shahi+d matches both
  // shahid and shahiid.
  return /egydead|tv10\.egydead|topcinema|faselhd|shahi+d|shaheed|akwam|arabseed/.test(hostname);
}

// ═══ ENHANCED: Detect site type ═══
function detectSiteType() {
  if (isYTSSite()) return 'yts';
  if (isArabicMovieSite()) return 'arabic_movie';
  if (isSaveFilesSite()) return 'savefiles';
  if (isStreamingSite()) return 'streaming';
  return 'unknown';
}

// ═══ ARABIC MOVIE SELECTORS ═══
const ARABIC_SELECTORS = [
  '.movie-item', '.film-item', '.card', '.browse-movie-wrap',
  '.film-list-item', '.movie-card', '.movie-list-item',
  'a[href*="/watch/"]',
];

// ═══ ENHANCED: Universal selectors for all site types ═══
const UNIVERSAL_SELECTORS = {
  yts: [
    '.browse-movie-wrap', '.card', '.movie-item', '.film-item',
    '.browse-movie-title', '.browse-movie-year', '.torrent-card',
    '.magnet-btn', '.modal-overlay', '.modal'
  ],
  arabic_movie: [
    '.movie-item', '.film-item', '.card', '.browse-movie-wrap',
    '.film-list-item', '.movie-card', '.movie-list-item',
    'a[href*="/watch/"]'
  ],
  savefiles: [
    '.btn-primary.download-btn', 'a[href*="/v/"]', 'table tr'
  ],
  streaming: [
    '.movieItem', '.movie-item', '.film-item', '.card', '.poster', '.title',
    '.browse-movie-wrap', '.torrent-card', '.download-link'
  ]
};

// ═══ SPA DETECTION ═══
let isSPA = false;
let lastSPAUrl = window.location.href;
let spaContentDetected = false;
let isRecordingActive = false;
let pageLoadCount = 0;

const YTS_SELECTORS = [
  '.browse-movie-wrap', '.card', '.browse-movie-title', '.browse-movie-bottom',
  '.browse-movie-year', '.card-title', '.card-body',
  '.torrent-card', '.torrent-quality', '.torrent-name', '.torrent-stat',
  '.torrent-source', '.magnet-btn', '.play-torrent', '.copy-hash',
  '.modal-overlay', '.modal', '.modal-title', '.modal-body',
  '.torrent-filters', '.torrent-grid', '.source-pills', '.source-pill',
  '.grid', '.poster', '.sidebar', '.sidebar-item',
  '.mode-pill', '.mode-btn', '.filter-select', '.search-bar',
  '.pagination', '.page-btn', '.section-head',
  '.movie-item', '.movie-list-item', '.film-item', '[data-movie-id]',
  '.movie-poster', '.film-list-item', '.movie-card', '.film-list',
  '.movie-grid', '.movie-list', '.film-grid', '.browse-movies',
  '#movies-container', '.content-wrapper', '.film-detail', '.movie-detail'
];

const MAX_PATH_DEPTH = 4;

function getSelector(element) {
  if (!element || !(element instanceof Element)) return null;
  if (element.id) return `#${CSS.escape(element.id)}`;
  if (element.className && typeof element.className === 'string') {
    const classes = element.className.trim().split(/\s+/).filter(Boolean);
    const stableClass = classes.find(c => !/^(js-|is-|has-|active|selected|hover|focus)/.test(c));
    if (stableClass) return `${element.tagName.toLowerCase()}.${CSS.escape(stableClass)}`;
  }
  const path = [];
  let current = element;
  let depth = 0;
  while (current && current !== document.body && depth < MAX_PATH_DEPTH) {
    if (current.id) {
      path.unshift(`#${CSS.escape(current.id)}`);
      break;
    }
    let index = 1;
    let sibling = current.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === current.tagName) index++;
      sibling = sibling.previousElementSibling;
    }
    path.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${index})`);
    current = current.parentElement;
    depth++;
  }
  return path.join(' > ');
}

function detectSPASite() {
  const hostname = window.location.hostname;
  if (/yts\.lu|yify\.sc|yts\.mx/.test(hostname)) return true;
  if (/wecima|mycima/.test(hostname)) return true;
  if (/egydead|tv10\.egydead/.test(hostname)) return true;
  const spaIndicators = [
    document.querySelector('#app, #root, #__next'),
    document.querySelector('[data-reactroot]'),
    document.querySelector('[data-v-app]'),
    document.querySelector('.content-wrapper, #movies-container, .movies-list'),
    document.querySelector('.browse-movie-wrap, .torrent-card, .modal-overlay')
  ];
  return spaIndicators.some(el => el !== null);
}

function getPageState() {
  try {
    const siteType = detectSiteType();
    const state = {
      title: document.title,
      path: window.location.pathname,
      search: window.location.search,
      url: window.location.href,
      siteType: siteType,
      scrollY: window.scrollY,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      pageLoad: pageLoadCount
    };

    if (isArabicMovieSite()) {
      state.siteType = 'arabic_movie';
      const movieItems = document.querySelectorAll('a[href*="/watch/"]');
      if (movieItems.length > 0) {
        state.pageType = 'movie_list';
        state.movieCount = movieItems.length;
      }
      if (window.location.pathname.includes('/watch/')) {
        state.pageType = 'movie_detail';
        const titleEl = document.querySelector('h1, .title, .movie-title, .film-title');
        if (titleEl) state.movieTitle = titleEl.textContent.trim();
      }
    } else if (isSaveFilesSite()) {
      state.siteType = 'savefiles';
      state.pageType = 'download_page';
      const fileInfo = document.querySelector('td:contains("Filesize")');
      if (fileInfo && fileInfo.nextElementSibling) {
        state.filesize = fileInfo.nextElementSibling.textContent.trim();
      }
    } else if (isYTSSite()) {
      state.siteType = 'yts';
      let movieCount = 0;
      const browseSelectors = ['.browse-movie-wrap', '.card', '.movie-item', '.film-item'];
      for (const selector of browseSelectors) {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
          movieCount = elements.length;
          break;
        }
      }
      if (movieCount > 0) {
        state.movieCount = movieCount;
        state.pageType = 'movie_list';
      }
      const modal = document.querySelector('.modal-overlay.active');
      if (modal) {
        state.pageType = 'torrent_modal';
        const title = document.querySelector('.modal-title, .browse-movie-title, h1, .title, .movie-title, .film-title');
        if (title) state.movieTitle = title.textContent.trim();
        const torrentCards = document.querySelectorAll('.torrent-card');
        if (torrentCards.length) state.torrentCount = torrentCards.length;
      }
    } else if (isStreamingSite()) {
      state.siteType = 'streaming';
      // [FIX] '.movieItem' is EgyDead's real class; the old list never matched it.
      const movieItems = document.querySelectorAll('.movieItem, .movie-item, .film-item, .card');
      if (movieItems.length > 0) {
        state.pageType = 'movie_list';
        state.movieCount = movieItems.length;
      }
      const detailItems = document.querySelectorAll('.title, .BottomTitle, h1, .movie-title');
      if (detailItems.length > 0 && window.location.pathname.includes('/movie/')) {
        state.pageType = 'movie_detail';
        state.movieTitle = detailItems[0]?.textContent?.trim() || '';
      }
    }

    return state;
  } catch (e) {
    return { url: window.location.href, siteType: 'unknown' };
  }
}

// ═══ ARABIC MOVIE EXTRACTION ═══
function extractArabicMovies() {
  if (!isArabicMovieSite()) return [];

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

// ═══ SAVEFILES EXTRACTION ═══
function extractSaveFiles() {
  if (!isSaveFilesSite()) return null;

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

// ═══ ENHANCED: Extract streaming site content ═══
function extractStreamingContent() {
  if (!isStreamingSite()) return null;

  const items = [];
  // [FIX] '.movieItem' (no hyphen) is EgyDead's real container class, confirmed against many
  // real captured pages this session -- the old list only had '.movie-item' (with a hyphen),
  // which never matches, so this whole function silently returned [] for every EgyDead page.
  const selectors = ['.movieItem', '.movie-item', '.film-item', '.card', '.poster', '.title', '.browse-movie-wrap'];

  for (const selector of selectors) {
    const elements = document.querySelectorAll(selector);
    for (const el of elements) {
      // [FIX] '.BottomTitle' and '.cat_name' are EgyDead's real title/category classes.
      const title = el.querySelector('.title, .BottomTitle, h3, .movie-title, .film-title')?.textContent?.trim() || '';
      const poster = el.querySelector('img')?.src || '';
      const link = el.querySelector('a[href*="/movie/"], a[href*="/watch/"], a')?.href || '';
      const category = el.querySelector('.cat_name')?.textContent?.trim() || '';

      if (title || poster || link) {
        const item = { title, poster, url: link, type: 'streaming_item' };
        if (category) item.category = category;
        items.push(item);
      }
    }
    if (items.length > 0) break;
  }

  return items;
}

// ═══ WEB SOCKET HOOK ═══
function injectWebSocketHook() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('websocket-hook.js');
  script.onload = function() {
    this.remove();
  };
  script.onerror = function() {
    console.warn('[Stream Recorder] Failed to load WebSocket hook:', this.src);
    this.remove();
  };
  document.documentElement.appendChild(script);
}
injectWebSocketHook();

// ═══ SPA OBSERVER ═══
let spaObserver = null;

function initSPADetection() {
  isSPA = detectSPASite();
  if (!isSPA) {
    console.log("[SPA] Not a SPA, skipping enhanced navigation tracking");
    return;
  }

  console.log("[SPA] SPA detected, enabling enhanced navigation tracking");

  spaObserver = new MutationObserver((mutations) => {
    if (!isRecordingActive) return;

    let significantChange = false;
    let newContent = false;
    const siteType = detectSiteType();
    const selectors = siteType === 'arabic_movie' ? ARABIC_SELECTORS :
                      siteType === 'yts' ? YTS_SELECTORS :
                      UNIVERSAL_SELECTORS[siteType] || UNIVERSAL_SELECTORS.streaming;

    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        const addedNodes = Array.from(mutation.addedNodes);
        for (const node of addedNodes) {
          if (node.nodeType === 1 && node.matches) {
            for (const selector of selectors) {
              if (node.matches(selector) || node.querySelector(selector)) {
                significantChange = true;
                newContent = true;
                break;
              }
            }
            if (node.matches('.content-wrapper, #movies-container, .movies-list, .film-grid, .movie-grid, .browse-movie-wrap, .torrent-grid, .grid')) {
              significantChange = true;
              newContent = true;
              break;
            }
          }
        }
      }

      if (significantChange) break;

      if (mutation.type === 'attributes') {
        if (mutation.attributeName === 'style' || mutation.attributeName === 'class') {
          const target = mutation.target;
          if (target.matches && target.matches('.modal-overlay') && target.classList.contains('active')) {
            significantChange = true;
            newContent = true;
          }
        }
      }
    }

    if (significantChange) {
      checkSPAContentChange(newContent);
    }
  });

  spaObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class', 'data-loaded', 'data-content']
  });

  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function(state, title, url) {
    const result = originalPushState.apply(this, arguments);
    handleSPAUrlChange(url || window.location.href);
    return result;
  };

  history.replaceState = function(state, title, url) {
    const result = originalReplaceState.apply(this, arguments);
    handleSPAUrlChange(url || window.location.href);
    return result;
  };

  window.addEventListener('popstate', () => {
    handleSPAUrlChange(window.location.href);
  });

  window.addEventListener('hashchange', () => {
    handleSPAUrlChange(window.location.href);
  });
}

function checkSPAContentChange(newContent = false) {
  const currentUrl = window.location.href;
  const pageState = getPageState();

  if (currentUrl !== lastSPAUrl || newContent) {
    lastSPAUrl = currentUrl;
    spaContentDetected = true;

    let data = null;
    if (isArabicMovieSite()) {
      data = extractArabicMovies();
      if (data && data.length > 0) {
        chrome.runtime.sendMessage({
          type: 'arabic_movies_extracted',
          data: data,
          url: currentUrl
        }).catch(() => {});
      }
    } else if (isSaveFilesSite()) {
      data = extractSaveFiles();
      if (data && data.downloadUrl) {
        chrome.runtime.sendMessage({
          type: 'savefiles_extracted',
          data: data,
          url: currentUrl
        }).catch(() => {});
      }
    } else if (isStreamingSite()) {
      data = extractStreamingContent();
      if (data && data.length > 0) {
        chrome.runtime.sendMessage({
          type: 'streaming_content_extracted',
          data: data,
          url: currentUrl
        }).catch(() => {});
      }
    }

    chrome.runtime.sendMessage({
      type: "spa_navigate",
      url: currentUrl,
      selector: "SPA_content_update",
      pageState: pageState,
      data: data
    }).catch(() => {});

    chrome.runtime.sendMessage({
      type: "pageLoaded",
      url: currentUrl
    }).catch(() => {});
  }
}

function handleSPAUrlChange(url) {
  if (url !== lastSPAUrl) {
    lastSPAUrl = url;
    const pageState = getPageState();

    chrome.runtime.sendMessage({
      type: "action",
      actionType: "navigate",
      url: url,
      selector: "SPA_navigation",
      pageState: pageState
    }).catch(() => {});

    chrome.runtime.sendMessage({
      type: "pageLoaded",
      url: url
    }).catch(() => {});
  }
}

// ═══ ENHANCED: Page load tracking ═══
let previousUrl = window.location.href;

function trackPageLoad() {
  pageLoadCount++;
  const currentUrl = window.location.href;

  // Only send if URL changed or it's the first load
  if (currentUrl !== previousUrl || pageLoadCount === 1) {
    previousUrl = currentUrl;
    const pageState = getPageState();

    chrome.runtime.sendMessage({
      type: "pageLoaded",
      url: currentUrl,
      pageState: pageState,
      loadCount: pageLoadCount
    }).catch(() => {});
  }
}

// ═══ INITIALIZE SPA DETECTION ═══
chrome.runtime.sendMessage({ type: "getRecordingStatus" }, (response) => {
  if (chrome.runtime.lastError) return;
  if (response) {
    isRecordingActive = response.recording;
    if (isRecordingActive) {
      showRecordingIndicator();
      initSPADetection();
      trackPageLoad();

      if (isArabicMovieSite()) {
        setTimeout(() => {
          const movies = extractArabicMovies();
          if (movies.length > 0) {
            chrome.runtime.sendMessage({
              type: 'arabic_movies_extracted',
              data: movies,
              url: window.location.href
            });
          }
        }, 1000);
      } else if (isSaveFilesSite()) {
        setTimeout(() => {
          const data = extractSaveFiles();
          if (data && data.downloadUrl) {
            chrome.runtime.sendMessage({
              type: 'savefiles_extracted',
              data: data,
              url: window.location.href
            });
          }
        }, 1000);
      } else if (isStreamingSite()) {
        setTimeout(() => {
          const data = extractStreamingContent();
          if (data && data.length > 0) {
            chrome.runtime.sendMessage({
              type: 'streaming_content_extracted',
              data: data,
              url: window.location.href
            });
          }
        }, 1000);
      }
    }
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === "recordingStateChanged") {
    isRecordingActive = message.recording;
    if (isRecordingActive) {
      showRecordingIndicator();
      if (!spaObserver) initSPADetection();
      trackPageLoad();
    } else {
      hideRecordingIndicator();
    }
  }
});

// ═══ ENHANCED: CLICK LISTENER ═══
document.addEventListener('click', (event) => {
  const target = event.target;
  const tagName = target.tagName.toLowerCase();
  const interactiveTags = ['a', 'button', 'input', 'video', 'source'];
  const isRoleButton = typeof target.matches === 'function' && target.matches('div[role="button"]');

  if (interactiveTags.includes(tagName) || isRoleButton ||
      target.closest('a, button, div[role="button"], .play-button, .vjs-big-play-button, .magnet-btn, .play-torrent, .mode-btn, .sidebar-item, .page-btn, .torrent-card, .copy-hash')) {

    const selector = getSelector(target);
    const pageState = getPageState();
    const anchor = tagName === 'a' ? target : target.closest('a');
    const href = anchor ? anchor.href : '';
    const downloadAttr = anchor && anchor.hasAttribute('download')
      ? (anchor.getAttribute('download') || true) : null;
    const isDownload = href && (
      href.includes('savefiles.com/v/') ||
      href.match(/\.(mp4|mkv|avi|mov|wmv|flv|webm|m4v|mpg|mpeg)(\?|$)/i) ||
      anchor?.hasAttribute('download')
    );

    let data = null;
    if (isSaveFilesSite()) {
      data = extractSaveFiles();
    } else if (isArabicMovieSite()) {
      data = extractArabicMovies();
    } else if (isStreamingSite()) {
      data = extractStreamingContent();
    }

    // Send click event
    chrome.runtime.sendMessage({
      type: "action",
      actionType: "click",
      selector: selector,
      tagName: tagName,
      url: window.location.href,
      href: href,
      isDownloadLink: !!downloadAttr || isDownload,
      text: target.innerText?.substring(0, 100) || target.value || '',
      pageState: pageState,
      data: data
    }).catch(() => {});

    // Take screenshot on download link click
    if (isDownload && isRecordingActive) {
      chrome.runtime.sendMessage({
        type: "captureScreenshot",
        tabId: chrome.runtime?.id ? undefined : undefined
      }).catch(() => {});
    }
  }
});

document.addEventListener('submit', (event) => {
  const form = event.target;
  const data = {};
  new FormData(form).forEach((value, key) => { data[key] = value; });
  const pageState = getPageState();

  chrome.runtime.sendMessage({
    type: "action",
    actionType: "submit",
    selector: getSelector(form),
    url: window.location.href,
    value: JSON.stringify(data),
    pageState: pageState
  }).catch(() => {});
});

// ═══ HISTORY PATCHING ═══
const originalPushState = history.pushState;
const originalReplaceState = history.replaceState;

history.pushState = function(...args) {
  originalPushState.apply(this, args);
  const pageState = getPageState();
  chrome.runtime.sendMessage({
    type: "action",
    actionType: "navigate",
    url: window.location.href,
    selector: "pushState",
    pageState: pageState
  }).catch(() => {});
};

history.replaceState = function(...args) {
  originalReplaceState.apply(this, args);
  const pageState = getPageState();
  chrome.runtime.sendMessage({
    type: "action",
    actionType: "navigate",
    url: window.location.href,
    selector: "replaceState",
    pageState: pageState
  }).catch(() => {});
};

// ═══ CLOUDFLARE CHALLENGE DETECTION ═══
let challengeAlreadyReported = false;

function detectCloudflareChallenge() {
  if (document.querySelector('[data-sitekey]')) return 'turnstile';
  if (document.querySelector('.cf-turnstile')) return 'turnstile';
  if (document.querySelector('iframe[src*="turnstile"]')) return 'turnstile';
  if (document.querySelector('#cf-browser-verification, .cf-browser-verification')) return 'managed';
  if (document.querySelector('#cf-challenge-running, #challenge-running, .cf-im-under-attack, #challenge-form')) return 'js';
  if (document.title.includes('Just a moment') || document.title.includes('Attention Required')) return 'js';
  return null;
}

function checkAndReportChallenge() {
  if (challengeAlreadyReported) return;
  const challengeType = detectCloudflareChallenge();
  if (challengeType) {
    challengeAlreadyReported = true;
    chrome.runtime.sendMessage({
      type: 'challengeDetected',
      challengeType: challengeType,
      url: window.location.href
    }).catch(() => {});
    observer.disconnect();
  }
}

const observer = new MutationObserver(() => {
  checkAndReportChallenge();
});
observer.observe(document.documentElement, { childList: true, subtree: true });

// ═══ ENHANCED: Track page visibility changes ═══
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && isRecordingActive) {
    // Page became visible again - check if URL changed
    if (window.location.href !== previousUrl) {
      trackPageLoad();
    }
  }
});

// ═══ ENHANCED: Handle iframe loading ═══
document.addEventListener('load', (event) => {
  if (event.target && event.target.tagName === 'IFRAME') {
    // Iframe loaded, may contain content
    try {
      const iframe = event.target;
      if (iframe.contentDocument && iframe.contentDocument.location.href) {
        // Send iframe load event
        chrome.runtime.sendMessage({
          type: "action",
          actionType: "iframe_loaded",
          url: window.location.href,
          iframeUrl: iframe.contentDocument.location.href,
          selector: getSelector(iframe)
        }).catch(() => {});
      }
    } catch (e) {
      // Cross-origin iframe
    }
  }
});

// ═══ INITIALIZATION ═══
if (document.readyState === 'complete') {
  checkAndReportChallenge();
  trackPageLoad();
  if (isRecordingActive) {
    initSPADetection();
  }
} else {
  window.addEventListener('load', () => {
    checkAndReportChallenge();
    trackPageLoad();
    if (isRecordingActive) {
      initSPADetection();
    }
  });
}

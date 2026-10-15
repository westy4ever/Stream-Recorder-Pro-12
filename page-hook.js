// page-hook.js — Runs in the PAGE's own JS context (manifest "world": "MAIN")
// Captures fetch/XHR/JWPlayer/Hls.js/Video.js/WebSocket

(function () {
  const SOURCE_TAG = "stream-recorder-page-hook";
  let MAX_BODY_CHARS = 1000 * 1024;   // matches the 1000 KB default in background/config.js
  const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;

  // [FIX] confirmed directly: isRecordingActive starts false and only becomes
  // known once this "stream-recorder-control" message arrives -- but that
  // requires an async round-trip (content.js -> chrome.runtime.sendMessage ->
  // background service worker -> response -> postMessage back into this page).
  // A React/SPA site's own initial API calls (its listing/detail JSON fetches)
  // can easily fire before that round-trip completes, especially if the
  // service worker needs to wake up -- and since the old code bailed out
  // immediately whenever isRecordingActive was still false, those early,
  // often most-important responses were silently lost every time, even
  // though recording was genuinely on by the time the page loaded. networkLog
  // (captured separately, in the background script, gated on its own
  // already-current state) never had this problem, which is why it worked
  // while xhrBodies came back completely empty for exactly these calls.
  // Fix: track whether the recording state is known yet, SEPARATELY from
  // what it is. While unknown, still do the capture work and hold the
  // payload in a small, bounded buffer instead of discarding it outright;
  // once the real state arrives, flush the buffer if recording turned out
  // to be on, or drop it if not. Only bail out early once the state is
  // actually KNOWN to be off -- never while it's merely not-yet-known.
  let isRecordingActive = false;
  let recordingStateKnown = false;
  const MAX_PENDING_BUFFER = 50;
  const pendingBuffer = [];

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "stream-recorder-control") return;
    isRecordingActive = !!data.recording;
    recordingStateKnown = true;
    if (data.maxBodySize) {
      MAX_BODY_CHARS = Math.max(1000, parseInt(data.maxBodySize, 10) * 1024);
    }
    if (isRecordingActive && pendingBuffer.length) {
      for (const buffered of pendingBuffer) post(buffered);
    }
    pendingBuffer.length = 0;
  });

  function postOrBuffer(payload) {
    if (recordingStateKnown) {
      if (isRecordingActive) post(payload);
      return;
    }
    pendingBuffer.push(payload);
    if (pendingBuffer.length > MAX_PENDING_BUFFER) pendingBuffer.shift();
  }

  function post(payload) {
    try {
      window.postMessage({ source: SOURCE_TAG, payload }, "*");
    } catch (e) { /* ignore */ }
  }

  function truncate(text) {
    if (typeof text !== "string") return { body: null, truncated: false };
    if (text.length > MAX_BODY_CHARS) {
      return { body: text.slice(0, MAX_BODY_CHARS), truncated: true };
    }
    return { body: text, truncated: false };
  }

  function isKnownApiUrl(url) {
    if (!url) return false;
    const urlLower = url.toLowerCase();
    return (
      urlLower.includes('vidcore.io/api/') ||
      urlLower.includes('vidcore.io/play') ||
      urlLower.includes('vidcloud.icu/api/') ||
      urlLower.includes('embed.su/api/') ||
      urlLower.includes('vidsrcme.ru/api.php') ||
      urlLower.includes('/api/stream') ||
      urlLower.includes('/api/play') ||
      urlLower.includes('/api/video') ||
      urlLower.includes('/api/source') ||
      urlLower.includes('/api/embed') ||
      urlLower.includes('/api/hls') ||
      urlLower.includes('/api/manifest') ||
      urlLower.includes('/api/master') ||
      urlLower.includes('streamrk.site') ||
      urlLower.includes('polarcandy.top') ||
      urlLower.includes('xpass.top') ||
      urlLower.includes('vaplayer.ru') ||
      urlLower.includes('scalablecontentengine.site') ||
      urlLower.includes('cloudorchestranova.com') ||
      urlLower.includes('panoplypalaver.site') ||
      urlLower.includes('viduki.net') ||
      urlLower.includes('1shows.app') ||
      urlLower.includes('moviesapi.to') ||
      urlLower.includes('netrocdn.site') ||
      urlLower.includes('shows.st') ||
      urlLower.includes('yts.lu/api/v2/') ||
      urlLower.includes('yify.sc/api/v2/') ||
      urlLower.includes('yts.mx/api/v2/') ||
      urlLower.includes('en.yts.lu/api/') ||
      urlLower.includes('en.yify.sc/api/') ||
      urlLower.includes('torrentio.strem') ||
      urlLower.includes('moonlighthathel.org') ||
      urlLower.includes('andthoughmy.org') ||
      urlLower.includes('ghabovethec.info') ||
      urlLower.includes('/dl') ||
      urlLower.includes('/download') ||
      urlLower.includes('/pass_md5') ||
      urlLower.includes('/getfile') ||
      urlLower.includes('/direct') ||
      urlLower.includes('/file/') ||
      urlLower.includes('/v/') ||
      urlLower.includes('savefiles.com/v/') ||
      urlLower.includes('savefiles.com/dl/') ||
      urlLower.includes('wecima.cx/api/') ||
      urlLower.includes('mycima.cx/api/') ||
      urlLower.includes('.torrent') ||
      urlLower.includes('magnet:') ||
      urlLower.match(/\.(mp4|mkv|avi|mov|wmv|flv|webm|m4v|mpg|mpeg|torrent)(\?|$)/i) !== null
    );
  }

  function extractStreamUrlsFromText(text) {
    if (!text || typeof text !== 'string') return [];
    const urls = [];
    const patterns = [
      /https?:\/\/[^\s"']+\.m3u8[^\s"']*/gi,
      /https?:\/\/[^\s"']+\.mp4[^\s"']*/gi,
      /https?:\/\/[^\s"']+\.ts[^\s"']*/gi,
      /https?:\/\/[^\s"']+master\.m3u8[^\s"']*/gi,
      /https?:\/\/[^\s"']+index-f[0-9]+\.m3u8[^\s"']*/gi,
      /https?:\/\/[^\s"']+\/playlist\/[^\s"']+\.m3u8[^\s"']*/gi,
      /https?:\/\/[^\s"']+\/pl\/[^\s"']+\.m3u8[^\s"']*/gi,
      /https?:\/\/[^\s"']+\/hls2\/[^\s"']+\.m3u8[^\s"']*/gi,
      /https?:\/\/[^\s"']+\/hls\/[^\s"']+\.m3u8[^\s"']*/gi,
      /https?:\/\/[^\s"']+\/e\/[^\s"']+\.m3u8[^\s"']*/gi,
      /https?:\/\/[^\s"']+\.hakunaymatata\.com[^\s"']+\.mp4[^\s"']*/gi,
      /https?:\/\/[^\s"']+\/convert-h264\/[^\s"']+\.mp4[^\s"']*/gi,
      /https?:\/\/[^\s"']+\/bt\/[^\s"']+\.mp4[^\s"']*/gi,
      /https?:\/\/[^\s"']+\.netrocdn\.site[^\s"']+\.m3u8[^\s"']*/gi,
      /https?:\/\/[^\s"']+\.shows\.st\/api[^\s"']+\.(?:m3u8|ts)[^\s"']*/gi,
      /https?:\/\/[^\s"']+\.(?:streamdata|vaplayer)\.ru[^\s"']+\.m3u8[^\s"']*/gi,
    ];
    for (const pattern of patterns) {
      const matches = text.match(pattern);
      if (matches) {
        for (const match of matches) {
          let url = match.replace(/\\/g, '').replace(/&amp;/g, '&').trim();
          url = url.replace(/[.,;:!?)]$/, '');
          if (url && !urls.includes(url)) urls.push(url);
        }
      }
    }
    return urls;
  }

  function deepExtractStreamUrls(obj, path = '') {
    const results = [];
    if (!obj) return results;
    if (typeof obj === 'string') {
      const urls = extractStreamUrlsFromText(obj);
      for (const url of urls) {
        results.push({ url, path: path || 'string' });
      }
      return results;
    }
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        const subResults = deepExtractStreamUrls(obj[i], `${path}[${i}]`);
        results.push(...subResults);
      }
      return results;
    }
    if (typeof obj === 'object') {
      for (const [key, value] of Object.entries(obj)) {
        const keyLower = key.toLowerCase();
        if (['url', 'file', 'src', 'source', 'hls', 'playlist', 'stream', 
             'stream_url', 'video_url', 'm3u8', 'manifest', 'master', 
             'playlist_url', 'media_url', 'link', 'href', 'path', 'uri',
             'download_url', 'file_url', 'direct_url'].includes(keyLower)) {
          if (typeof value === 'string') {
            const urls = extractStreamUrlsFromText(value);
            for (const url of urls) {
              results.push({ url, path: `${path}.${key}` });
            }
          }
        }
        const subResults = deepExtractStreamUrls(value, `${path}.${key}`);
        results.push(...subResults);
      }
    }
    return results;
  }

  // ═══ FETCH HOOK ═══
  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function (...args) {
      const startedAt = Date.now();
      return originalFetch.apply(this, args).then((response) => {
        try {
          if (recordingStateKnown && !isRecordingActive) return response;
          const reqInput = args[0];
          const reqInit = args[1];
          const url = response.url || (typeof reqInput === "string" ? reqInput : (reqInput && reqInput.url) || "");
          const method = (reqInit && reqInit.method) || (reqInput && typeof reqInput === "object" && reqInput.method) || "GET";
          const lenHeader = response.headers && response.headers.get && response.headers.get("content-length");
          const tooBig = lenHeader && Number(lenHeader) > MAX_CAPTURE_BYTES;
          if (!tooBig && typeof response.clone === "function") {
            response.clone().text().then((text) => {
              const { body, truncated } = truncate(text);
              let streamUrls = [];
              let jsonData = null;
              let contentType = 'text';
              
              try {
                jsonData = JSON.parse(body);
                const extracted = deepExtractStreamUrls(jsonData);
                streamUrls = extracted.map(e => e.url);
                contentType = 'json';
              } catch (e) {
                streamUrls = extractStreamUrlsFromText(body);
              }
              
              // FIX: Use the actual truncated value
              if (isKnownApiUrl(url) || streamUrls.length > 0) {
                const payload = { 
                  url, 
                  method, 
                  status: response.status, 
                  timestamp: startedAt, 
                  body, 
                  truncated: truncated,
                  via: "fetch", 
                  streamUrls, 
                  isStreamApi: streamUrls.length > 0, 
                  isKnownApi: isKnownApiUrl(url),
                  contentType: contentType,
                  jsonData: jsonData
                };
                postOrBuffer(payload);
              } else {
                postOrBuffer({ url, method, status: response.status, timestamp: startedAt, body, truncated, via: "fetch" });
              }
            }).catch(() => {});
          }
        } catch (e) { /* ignore */ }
        return response;
      });
    };
  }

  // ═══ XHR HOOK ═══
  const OriginalXHR = window.XMLHttpRequest;
  if (OriginalXHR) {
    const originalOpen = OriginalXHR.prototype.open;
    const originalSend = OriginalXHR.prototype.send;

    OriginalXHR.prototype.open = function (method, url, ...rest) {
      this.__srMethod = method;
      this.__srUrl = url;
      return originalOpen.call(this, method, url, ...rest);
    };

    OriginalXHR.prototype.send = function (...args) {
      const startedAt = Date.now();
      this.addEventListener("load", function () {
        try {
          if (recordingStateKnown && !isRecordingActive) return;
          const rt = this.responseType;
          if (rt !== "" && rt !== "text" && rt !== "json") return;
          const lenHeader = this.getResponseHeader && this.getResponseHeader("content-length");
          if (lenHeader && Number(lenHeader) > MAX_CAPTURE_BYTES) return;
          const raw = rt === "json" ? JSON.stringify(this.response) : this.responseText;
          const { body, truncated } = truncate(raw);
          const url = this.__srUrl || this.responseURL || "";
          const method = this.__srMethod || "GET";
          let streamUrls = [];
          let jsonData = null;
          let contentType = 'text';
          
          try {
            jsonData = JSON.parse(body);
            const extracted = deepExtractStreamUrls(jsonData);
            streamUrls = extracted.map(e => e.url);
            contentType = 'json';
          } catch (e) {
            streamUrls = extractStreamUrlsFromText(body);
          }
          
          // FIX: Use the actual truncated value
          if (isKnownApiUrl(url) || streamUrls.length > 0) {
            const payload = { 
              url, 
              method, 
              status: this.status, 
              timestamp: startedAt, 
              body, 
              truncated: truncated,
              via: "xhr", 
              streamUrls, 
              isStreamApi: streamUrls.length > 0, 
              isKnownApi: isKnownApiUrl(url),
              contentType: contentType,
              jsonData: jsonData
            };
            postOrBuffer(payload);
          } else {
            postOrBuffer({ url, method, status: this.status, timestamp: startedAt, body, truncated, via: "xhr" });
          }
        } catch (e) { /* ignore */ }
      });
      return originalSend.apply(this, args);
    };
  }

  // ═══ JWP HOOK ═══
  function wrapJwplayer(existing) {
    if (typeof existing !== "function" || existing.__srIsWrapped) return existing;
    function wrapInstance(instance) {
      if (!instance || typeof instance.setup !== "function" || instance.__srSetupWrapped) return instance;
      const originalSetup = instance.setup.bind(instance);
      instance.__srSetupWrapped = true;
      instance.setup = function (config) {
        try {
          // [FIX] same race condition as the fetch/XHR hooks above, same
          // fix: a player's setup() call can easily fire before the
          // async recording-state signal arrives, especially right on
          // page load -- confirmed as the same isRecordingActive-gated,
          // immediate-bail pattern, applied consistently here too.
          if (!recordingStateKnown || isRecordingActive) {
            let streamUrls = [];
            if (config && config.file) {
              const urls = extractStreamUrlsFromText(config.file);
              streamUrls.push(...urls);
            }
            if (config && config.sources) {
              for (const source of config.sources) {
                if (source && source.file) {
                  const urls = extractStreamUrlsFromText(source.file);
                  streamUrls.push(...urls);
                }
              }
            }
            postOrBuffer({ 
              url: location.href, 
              method: "JWPLAYER_SETUP", 
              status: 200, 
              timestamp: Date.now(), 
              body: JSON.stringify(config), 
              truncated: false, 
              via: "jwplayer", 
              streamUrls, 
              isStreamApi: streamUrls.length > 0,
              isKnownApi: true
            });
          }
        } catch (e) { /* ignore */ }
        return originalSetup(config);
      };
      return instance;
    }
    const wrapped = function (...args) {
      return wrapInstance(existing.apply(this, args));
    };
    wrapped.__srIsWrapped = true;
    for (const k in existing) {
      try { wrapped[k] = existing[k]; } catch (e) { /* ignore */ }
    }
    return wrapped;
  }

  function installPersistentHook(propName, wrapFn) {
    let current = window[propName];
    try {
      Object.defineProperty(window, propName, {
        configurable: true,
        enumerable: true,
        get() { return current; },
        set(v) { current = wrapFn(v); },
      });
      if (current !== undefined) window[propName] = current;
    } catch (e) {
      let attempts = 0;
      const interval = setInterval(() => {
        const val = window[propName];
        if (typeof val === "function" && !val.__srIsWrapped) {
          try { window[propName] = wrapFn(val); } catch (e2) { /* ignore */ }
        }
        if (++attempts > 100) clearInterval(interval);
      }, 50);
    }
  }

  installPersistentHook("jwplayer", wrapJwplayer);

  // ═══ HLS.JS HOOK ═══
  function wrapHlsCtor(HlsCtor) {
    if (typeof HlsCtor !== "function" || HlsCtor.__srIsWrapped) return HlsCtor;
    if (!HlsCtor.prototype || typeof HlsCtor.prototype.loadSource !== "function") return HlsCtor;
    const originalLoadSource = HlsCtor.prototype.loadSource;
    HlsCtor.prototype.loadSource = function (url) {
      try {
        // [FIX] same race condition as the fetch/XHR hooks above, same fix.
        if (!recordingStateKnown || isRecordingActive) {
          const streamUrls = extractStreamUrlsFromText(url);
          postOrBuffer({ 
            url: location.href, 
            method: "HLSJS_LOADSOURCE", 
            status: 200, 
            timestamp: Date.now(), 
            body: JSON.stringify({ file: url }), 
            truncated: false, 
            via: "hlsjs", 
            streamUrls, 
            isStreamApi: streamUrls.length > 0,
            isKnownApi: true
          });
        }
      } catch (e) { /* ignore */ }
      return originalLoadSource.call(this, url);
    };
    HlsCtor.__srIsWrapped = true;
    return HlsCtor;
  }

  installPersistentHook("Hls", wrapHlsCtor);

  // ═══ VIDEO.JS HOOK ═══
  function wrapVideojs(videojsCtor) {
    if (typeof videojsCtor !== "function" || videojsCtor.__srIsWrapped) return videojsCtor;
    
    function wrapPlayerInstance(instance) {
      if (!instance || typeof instance.src !== 'function' || instance.__srSrcWrapped) return instance;
      const originalSrc = instance.src.bind(instance);
      instance.__srSrcWrapped = true;
      instance.src = function(source) {
        try {
          // [FIX] same race condition as the fetch/XHR hooks above, same fix.
          if (!recordingStateKnown || isRecordingActive) {
            let streamUrls = [];
            if (typeof source === 'string') {
              streamUrls = extractStreamUrlsFromText(source);
            } else if (source && typeof source === 'object') {
              if (source.src) streamUrls = extractStreamUrlsFromText(source.src);
              if (source.sources) {
                for (const s of source.sources) {
                  if (s && s.src) {
                    const urls = extractStreamUrlsFromText(s.src);
                    streamUrls.push(...urls);
                  }
                }
              }
            }
            postOrBuffer({ 
              url: location.href, 
              method: "VIDEOJS_SRC", 
              status: 200, 
              timestamp: Date.now(), 
              body: JSON.stringify({ source: source }), 
              truncated: false, 
              via: "videojs", 
              streamUrls, 
              isStreamApi: streamUrls.length > 0,
              isKnownApi: true
            });
          }
        } catch (e) { /* ignore */ }
        return originalSrc(source);
      };
      return instance;
    }

    const wrapped = function(...args) {
      const result = videojsCtor.apply(this, args);
      return wrapPlayerInstance(result);
    };
    wrapped.__srIsWrapped = true;
    for (const k in videojsCtor) {
      try { wrapped[k] = videojsCtor[k]; } catch (e) { /* ignore */ }
    }
    return wrapped;
  }

  installPersistentHook("videojs", wrapVideojs);

  // ═══ YTS DATA DETECTION ═══
  function detectYTSDataLoad() {
    // [FIX] same race condition as the fetch/XHR hooks above, same fix --
    // this is observer-triggered and could in principle re-fire later
    // once recording state is known, but for a site that only populates
    // its DOM once on load, the first (and only) call here could easily
    // land before that state arrives, same as every other hook.
    if (recordingStateKnown && !isRecordingActive) return;
    const movieContainers = document.querySelectorAll(
      '.movie-list, .film-grid, .movie-grid, .movies-list, .browse-movies, .content-wrapper, .browse-movie-wrap, .torrent-grid, .grid, .modal-body'
    );
    if (movieContainers.length > 0) {
      movieContainers.forEach(container => {
        const movies = container.querySelectorAll('.movie-item, .film-item, [data-movie-id], .movie-card, .film-list-item, .browse-movie-wrap, .card, .torrent-card');
        if (movies.length > 0) {
          const movieData = [];
          movies.forEach(movie => {
            const title = movie.querySelector('.browse-movie-title, .card-title, .torrent-name, .modal-title, .title, .movie-title, h3, h4')?.textContent?.trim() || '';
            const year = movie.querySelector('.browse-movie-year, .year-badge, .year, .movie-year, [data-year]')?.textContent?.trim() || '';
            const quality = movie.querySelector('.torrent-quality, .quality, .resolution, .format')?.textContent?.trim() || '';
            const poster = movie.querySelector('img')?.src || '';
            const link = movie.querySelector('a[href*="/movie/"], a[href*="magnet:"], a[href*=".torrent"], .magnet-btn')?.href || '';
            const torrents = [];
            movie.querySelectorAll('a[href*="magnet:"], a[href*=".torrent"], .magnet-btn, .play-torrent').forEach(t => {
              torrents.push({ url: t.href || '', text: t.textContent?.trim() || '' });
            });
            // [FIX] this used to attach seeds/size/source to movieData[movieData.length - 1]
            // BEFORE this movie's own entry had been pushed -- meaning it always attached to
            // the PREVIOUS movie in the loop instead of itself. Confirmed directly with a
            // 3-item simulation: movie A's stats landed on... nothing (shifted forward);
            // movie B got movie A's stats meant for a different card entirely; the actual
            // stats for the LAST movie in any list were dropped completely, since there was
            // no next iteration to (wrongly) attach them. Every torrent-card's displayed
            // seed/size/source would have been for the wrong movie. Computed here, alongside
            // this movie's own data, and attached directly to the object being pushed instead
            // of relying on a fragile "last pushed item" index lookup at all.
            let seeds = '', size = '', source = '';
            if (movie.classList && movie.classList.contains('torrent-card')) {
              seeds = movie.querySelector('.torrent-stat.seeds, .torrent-stat .seeds')?.textContent?.trim() || '';
              size = movie.querySelector('.torrent-stat.size, .torrent-stat .size')?.textContent?.trim() || '';
              source = movie.querySelector('.torrent-source')?.textContent?.trim() || '';
            }
            if (title || torrents.length > 0) {
              const entry = { title, year, quality, poster, link, torrents };
              if (seeds || size || source) {
                entry.seeds = seeds;
                entry.size = size;
                entry.source = source;
              }
              movieData.push(entry);
            }
          });
          if (movieData.length > 0) {
            postOrBuffer({ 
              url: location.href, 
              method: 'YTS_DATA_LOAD', 
              status: 200, 
              timestamp: Date.now(), 
              body: JSON.stringify({ type: 'yts_data_loaded', movieCount: movieData.length, movies: movieData, container: container.className }), 
              truncated: false, 
              via: 'yts_detector',
              isKnownApi: true
            });
          }
        }
      });
    }
  }

  const ytsObserver = new MutationObserver(() => { detectYTSDataLoad(); });
  setTimeout(() => {
    ytsObserver.observe(document.body, { childList: true, subtree: true, attributes: false });
    detectYTSDataLoad();
  }, 1000);
})();

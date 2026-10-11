// websocket-hook.js - WebSocket hook injected into page context
// This file is loaded as an external script to avoid CSP inline-script violations
// UPDATED v4.0.0: Now respects maxBodySize and includes quality/extraction data

(function() {
  let __srWsRecording = false;
  let __srMaxBodySize = 500000; // Default, overridden by control message

  // [FIX] same race condition confirmed and fixed in page-hook.js's
  // fetch/XHR/JWPlayer/Hls.js/Video.js hooks this session: __srWsRecording
  // starts false and only becomes known once this control message arrives
  // via an async round-trip (content.js -> background service worker ->
  // response -> postMessage back into the page). A WebSocket connection
  // opened right as the page loads -- a live-chat widget initializing
  // immediately, for instance -- could race ahead of that signal the same
  // way a React app's initial fetch calls did. This file has its own
  // separate scope from page-hook.js (loaded as a distinct script, no
  // shared post()/postOrBuffer() helper available), so the same fix is
  // reimplemented locally here rather than shared.
  let __srWsRecordingKnown = false;
  const __srWsPendingBuffer = [];
  const __SR_WS_MAX_PENDING = 50;

  function __srWsPostOrBuffer(payload) {
    if (__srWsRecordingKnown) {
      if (__srWsRecording) {
        window.postMessage({ source: "stream-recorder-page-hook", payload }, "*");
      }
      return;
    }
    __srWsPendingBuffer.push(payload);
    if (__srWsPendingBuffer.length > __SR_WS_MAX_PENDING) __srWsPendingBuffer.shift();
  }

  // Listen for recording state and maxBodySize from content script
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "stream-recorder-control") return;
    __srWsRecording = !!data.recording;
    __srWsRecordingKnown = true;
    if (data.maxBodySize) {
      __srMaxBodySize = Math.max(1000, parseInt(data.maxBodySize, 10) * 1024);
    }
    if (__srWsRecording && __srWsPendingBuffer.length) {
      for (const buffered of __srWsPendingBuffer) {
        window.postMessage({ source: "stream-recorder-page-hook", payload: buffered }, "*");
      }
    }
    __srWsPendingBuffer.length = 0;
  });

  // Helper: Truncate message if too large
  function truncateMessage(data) {
    if (typeof data !== 'string') {
      // For binary data, we just indicate it's binary
      return { body: '[binary data]', truncated: false };
    }
    if (data.length > __srMaxBodySize) {
      return { body: data.slice(0, __srMaxBodySize) + '…[truncated]', truncated: true };
    }
    return { body: data, truncated: false };
  }

  // Helper: Detect if message contains stream-related data
  function detectStreamData(data) {
    if (typeof data !== 'string') return { isStream: false, streamUrls: [], jsonData: null };
    
    const streamUrls = [];
    const patterns = [
      /https?:\/\/[^\s"']+\.m3u8[^\s"']*/gi,
      /https?:\/\/[^\s"']+\.mp4[^\s"']*/gi,
      /https?:\/\/[^\s"']+\.ts[^\s"']*/gi,
      /https?:\/\/[^\s"']+master\.m3u8[^\s"']*/gi,
      /https?:\/\/[^\s"']+index-f[0-9]+\.m3u8[^\s"']*/gi,
    ];
    
    for (const pattern of patterns) {
      const matches = data.match(pattern);
      if (matches) {
        for (const match of matches) {
          let url = match.replace(/\\/g, '').replace(/&amp;/g, '&').trim();
          url = url.replace(/[.,;:!?)]$/, '');
          if (url && !streamUrls.includes(url)) streamUrls.push(url);
        }
      }
    }
    
    let jsonData = null;
    try {
      jsonData = JSON.parse(data);
    } catch (e) {
      // Not JSON
    }
    
    return { 
      isStream: streamUrls.length > 0, 
      streamUrls: streamUrls,
      jsonData: jsonData,
      isJson: jsonData !== null
    };
  }

  // Store the original WebSocket constructor
  const originalWebSocket = window.WebSocket;

  // Only wrap if not already wrapped
  if (!originalWebSocket.__srIsWrapped) {
    window.WebSocket = function(url, protocols) {
      // Create the WebSocket instance
      const ws = new originalWebSocket(url, protocols);
      
      // Store the URL for reference
      const wsUrl = url;
      const wsProtocols = protocols;
      const wsInstance = ws;

      // Hook send method
      const originalSend = ws.send;
      ws.send = function(data) {
        if (!__srWsRecordingKnown || __srWsRecording) {
          const { body, truncated } = truncateMessage(data);
          const streamData = detectStreamData(data);
          
          // Send message to background via content script
          __srWsPostOrBuffer({
              url: wsUrl,
              method: 'WEBSOCKET_SEND',
              timestamp: Date.now(),
              body: body,
              truncated: truncated,
              via: 'websocket',
              isStream: streamData.isStream,
              streamUrls: streamData.streamUrls,
              isJson: streamData.isJson,
              jsonData: streamData.jsonData,
              messageType: typeof data,
              isBinary: typeof data !== 'string'
          });
        }
        return originalSend.call(this, data);
      };

      // Hook message event
      ws.addEventListener('message', (event) => {
        if (__srWsRecordingKnown && !__srWsRecording) return;
        
        const data = event.data;
        const { body, truncated } = truncateMessage(data);
        const streamData = detectStreamData(data);
        
        __srWsPostOrBuffer({
            url: wsUrl,
            method: 'WEBSOCKET_RECEIVE',
            timestamp: Date.now(),
            body: body,
            truncated: truncated,
            via: 'websocket',
            isStream: streamData.isStream,
            streamUrls: streamData.streamUrls,
            isJson: streamData.isJson,
            jsonData: streamData.jsonData,
            messageType: typeof data,
            isBinary: typeof data !== 'string'
        });
      });

      // Also hook close and error events for additional context
      ws.addEventListener('close', (event) => {
        if (__srWsRecordingKnown && !__srWsRecording) return;
        
        __srWsPostOrBuffer({
            url: wsUrl,
            method: 'WEBSOCKET_CLOSE',
            timestamp: Date.now(),
            code: event.code,
            reason: event.reason || '',
            wasClean: event.wasClean,
            via: 'websocket'
        });
      });

      ws.addEventListener('error', (event) => {
        if (__srWsRecordingKnown && !__srWsRecording) return;
        
        __srWsPostOrBuffer({
            url: wsUrl,
            method: 'WEBSOCKET_ERROR',
            timestamp: Date.now(),
            error: event.message || 'WebSocket error',
            via: 'websocket'
        });
      });

      return ws;
    };

    // [FIX] window.WebSocket was replaced with a plain function that returns a real
    // originalWebSocket instance, but never inherited the original's prototype -- the new
    // function's own .prototype was left as its default, empty object, completely unrelated
    // to originalWebSocket.prototype. Confirmed directly with a faithful reproduction: an
    // instance created via `new window.WebSocket(...)` -- a genuine, real WebSocket under the
    // hood -- returned false for `instance instanceof window.WebSocket`, even though it
    // returned true against the original class. Any site code using the very common
    // `if (socket instanceof WebSocket)` type-check (real-time chat widgets, live-update
    // features, or a player's own WebSocket handling) would silently fail that check the
    // moment this hook was installed, with no error message pointing at the actual cause.
    // Pointing this function's .prototype at the original's is the standard fix: it makes
    // instanceof checks against the (now-wrapping) global WebSocket succeed again, without
    // changing any of the actual wrapped behavior above.
    window.WebSocket.prototype = originalWebSocket.prototype;

    // Mark as wrapped to prevent double wrapping
    window.WebSocket.__srIsWrapped = true;
    
    // Copy static properties from original
    try {
      window.WebSocket.CONNECTING = originalWebSocket.CONNECTING;
      window.WebSocket.OPEN = originalWebSocket.OPEN;
      window.WebSocket.CLOSING = originalWebSocket.CLOSING;
      window.WebSocket.CLOSED = originalWebSocket.CLOSED;
    } catch (e) {
      // Some properties may not be copyable
    }
  }

  // Helper function to manually check if recording is active
  // Useful for debugging
  window.__srGetWebSocketStatus = function() {
    return {
      recording: __srWsRecording,
      maxBodySize: __srMaxBodySize
    };
  };

  console.log("[WebSocket Hook] v4.0.0 initialized, recording:", __srWsRecording);
})();

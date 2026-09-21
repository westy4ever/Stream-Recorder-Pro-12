// websocket-hook.js - WebSocket hook injected into page context
// This file is loaded as an external script to avoid CSP inline-script violations
// UPDATED v4.0.0: Now respects maxBodySize and includes quality/extraction data

(function() {
  let __srWsRecording = false;
  let __srMaxBodySize = 500000; // Default, overridden by control message

  // Listen for recording state and maxBodySize from content script
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "stream-recorder-control") return;
    __srWsRecording = !!data.recording;
    if (data.maxBodySize) {
      __srMaxBodySize = Math.max(1000, parseInt(data.maxBodySize, 10) * 1024);
    }
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
        if (__srWsRecording) {
          const { body, truncated } = truncateMessage(data);
          const streamData = detectStreamData(data);
          
          // Send message to background via content script
          window.postMessage({
            source: "stream-recorder-page-hook",
            payload: {
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
            }
          }, "*");
        }
        return originalSend.call(this, data);
      };

      // Hook message event
      ws.addEventListener('message', (event) => {
        if (!__srWsRecording) return;
        
        const data = event.data;
        const { body, truncated } = truncateMessage(data);
        const streamData = detectStreamData(data);
        
        window.postMessage({
          source: "stream-recorder-page-hook",
          payload: {
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
          }
        }, "*");
      });

      // Also hook close and error events for additional context
      ws.addEventListener('close', (event) => {
        if (!__srWsRecording) return;
        
        window.postMessage({
          source: "stream-recorder-page-hook",
          payload: {
            url: wsUrl,
            method: 'WEBSOCKET_CLOSE',
            timestamp: Date.now(),
            code: event.code,
            reason: event.reason || '',
            wasClean: event.wasClean,
            via: 'websocket'
          }
        }, "*");
      });

      ws.addEventListener('error', (event) => {
        if (!__srWsRecording) return;
        
        window.postMessage({
          source: "stream-recorder-page-hook",
          payload: {
            url: wsUrl,
            method: 'WEBSOCKET_ERROR',
            timestamp: Date.now(),
            error: event.message || 'WebSocket error',
            via: 'websocket'
          }
        }, "*");
      });

      return ws;
    };
    
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
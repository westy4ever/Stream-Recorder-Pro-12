// magnet-parser.js - Magnet/Torrent Metadata Extraction
import { state } from './state.js';

export function parseMagnetLink(magnetUrl) {
  if (!magnetUrl || !magnetUrl.startsWith('magnet:')) {
    return null;
  }

  const parsed = {
    raw: magnetUrl,
    infoHash: null,
    displayName: null,
    trackers: [],
    files: [],
    quality: null,
    size: null,
    seeds: null,
    peers: null,
    source: null
  };

  const params = new URLSearchParams(magnetUrl.replace('magnet:', ''));
  
  const xt = params.get('xt');
  if (xt && xt.startsWith('urn:btih:')) {
    parsed.infoHash = xt.replace('urn:btih:', '');
  } else if (xt) {
    parsed.infoHash = xt;
  }

  parsed.displayName = params.get('dn');
  const trackerUrls = params.getAll('tr');
  parsed.trackers = trackerUrls;

  if (parsed.displayName) {
    const qualityMatch = parsed.displayName.match(/\b(1080p|720p|480p|360p|2160p|4K|FHD|HD)\b/i);
    if (qualityMatch) {
      parsed.quality = qualityMatch[1].toUpperCase();
    }

    const yearMatch = parsed.displayName.match(/\b(19|20)\d{2}\b/);
    if (yearMatch) {
      parsed.year = yearMatch[0];
    }
  }

  return parsed;
}

export function analyzeMagnetLinks() {
  const s = state;
  const xhrBodies = s.xhrBodies || [];
  const networkLog = s.networkLog || [];
  
  const magnets = [];
  const seen = new Set();

  for (const entry of networkLog) {
    if (entry.url && entry.url.startsWith('magnet:')) {
      if (!seen.has(entry.url)) {
        seen.add(entry.url);
        const parsed = parseMagnetLink(entry.url);
        if (parsed) {
          parsed.source = 'network_log';
          parsed.timestamp = entry.timestamp;
          magnets.push(parsed);
        }
      }
    }
  }

  for (const body of xhrBodies) {
    if (body.body) {
      const magnetMatches = body.body.match(/magnet:\?xt=urn:btih:[a-fA-F0-9]+[^\s"']*/g) || [];
      for (const match of magnetMatches) {
        if (!seen.has(match)) {
          seen.add(match);
          const parsed = parseMagnetLink(match);
          if (parsed) {
            parsed.source = body.url || 'response_body';
            parsed.timestamp = body.timestamp || Date.now();
            magnets.push(parsed);
          }
        }
      }
    }
  }

  return magnets;
}

export function generateTorrentMetadata(magnetLink) {
  const parsed = parseMagnetLink(magnetLink);
  if (!parsed) return null;

  const s = state;
  const xhrBodies = s.xhrBodies || [];
  
  for (const body of xhrBodies) {
    if (body.body && body.body.includes(parsed.infoHash)) {
      try {
        const data = JSON.parse(body.body);
        if (data.streams && Array.isArray(data.streams)) {
          for (const stream of data.streams) {
            if (stream.infoHash === parsed.infoHash) {
              parsed.title = stream.title || parsed.displayName;
              parsed.quality = stream.quality || parsed.quality;
              parsed.fileIdx = stream.fileIdx;
              parsed.size = stream.size;
              parsed.seeds = stream.seeds;
              parsed.peers = stream.peers;
            }
          }
        }
        if (data.data && data.data.streams) {
          for (const stream of data.data.streams) {
            if (stream.infoHash === parsed.infoHash) {
              parsed.title = stream.title || parsed.displayName;
              parsed.quality = stream.quality || parsed.quality;
              parsed.fileIdx = stream.fileIdx;
              parsed.size = stream.size;
              parsed.seeds = stream.seeds;
              parsed.peers = stream.peers;
            }
          }
        }
      } catch (e) {}
    }
  }

  let enhancedMagnet = `magnet:?xt=urn:btih:${parsed.infoHash}`;
  if (parsed.displayName) {
    enhancedMagnet += `&dn=${encodeURIComponent(parsed.displayName)}`;
  }
  for (const tracker of parsed.trackers) {
    enhancedMagnet += `&tr=${encodeURIComponent(tracker)}`;
  }
  
  return {
    ...parsed,
    enhancedMagnet: enhancedMagnet,
    metadata: {
      title: parsed.title || parsed.displayName,
      quality: parsed.quality || 'Unknown',
      size: parsed.size || 'Unknown',
      seeds: parsed.seeds || 'Unknown',
      peers: parsed.peers || 'Unknown',
      trackers: parsed.trackers
    }
  };
}
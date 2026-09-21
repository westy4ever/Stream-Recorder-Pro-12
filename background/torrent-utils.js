// torrent-utils.js - Enhanced Torrent API discovery
import { state } from './state.js';
import { TORRENT_BODY_PATTERNS } from './config.js';

export function getTorrentLinks() {
  const s = state;
  const xhrBodies = s.xhrBodies || [];
  const networkLog = s.networkLog || [];
  const results = [];

  for (const body of xhrBodies) {
    if (!body.body) continue;
    
    // Check for torrent patterns
    let matchCount = 0;
    for (const pattern of TORRENT_BODY_PATTERNS) {
      if (pattern.test(body.body)) matchCount++;
    }
    
    if (matchCount >= 2) {
      const entry = {
        type: 'torrent_api',
        apiEndpoint: body.url,
        method: body.method || 'GET',
        status: body.status || 200,
        bodyLength: body.body.length,
        bodyPreview: body.body.substring(0, 500),
        infoHashCount: (body.body.match(/[a-fA-F0-9]{40}/g) || []).length,
        magnetCount: (body.body.match(/magnet:/g) || []).length,
        hasFileIdx: body.body.includes('fileIdx'),
        imdbId: body.body.match(/tt\d{7,8}/)?.[0] || null,
        contentType: body.contentType || 'unknown'
      };
      results.push(entry);
    }
  }

  // Check network logs for direct magnets
  for (const entry of networkLog) {
    if (entry.url && entry.url.startsWith('magnet:')) {
      results.push({
        type: 'direct_magnet',
        apiEndpoint: entry.url,
        method: 'GET',
        status: 200,
        timestamp: entry.timestamp || Date.now()
      });
    }
    
    // Check for suspected backend APIs
    if (entry.url && (entry.url.includes('/api/') || entry.url.includes('/backend/'))) {
      const body = xhrBodies.find(b => b.url === entry.url);
      if (body && body.body && body.body.length > 100) {
        results.push({
          type: 'suspected_backend',
          apiEndpoint: entry.url,
          method: entry.method || 'GET',
          status: entry.statusCode || 0,
          contentType: body.contentType || 'unknown',
          bodyLength: body.body.length
        });
      }
    }
  }

  return results;
}

// NEW: Analyze torrent response
export function analyzeTorrentResponse(body) {
  if (!body) return null;
  
  const analysis = {
    hashes: [],
    magnets: [],
    titles: [],
    qualities: [],
    seeds: [],
    peers: [],
    size: null,
    fileIdx: null,
    imdbId: null,
    source: null,
    raw: body
  };

  // Extract info hashes
  const hashMatches = body.match(/[a-fA-F0-9]{40}/g) || [];
  analysis.hashes = [...new Set(hashMatches)];

  // Extract magnet links
  const magnetMatches = body.match(/magnet:\?xt=urn:btih:[^\s"']+/g) || [];
  analysis.magnets = [...new Set(magnetMatches)];

  // Extract titles
  const titleMatches = body.match(/"title"\s*:\s*"([^"]+)"/g) || [];
  for (const match of titleMatches) {
    const title = match.replace(/"title"\s*:\s*"/, '').replace(/"$/, '');
    analysis.titles.push(title);
  }

  // Extract quality
  const qualityMatch = body.match(/(1080p|720p|480p|360p|2160p|4K|FHD|HD)/i);
  if (qualityMatch) analysis.qualities.push(qualityMatch[1]);

  // Extract seeds
  const seedsMatch = body.match(/"seeds"\s*:\s*(\d+)/i);
  if (seedsMatch) analysis.seeds.push(parseInt(seedsMatch[1]));

  // Extract peers
  const peersMatch = body.match(/"peers"\s*:\s*(\d+)/i);
  if (peersMatch) analysis.peers.push(parseInt(peersMatch[1]));

  // Extract fileIdx
  const fileIdxMatch = body.match(/"fileIdx"\s*:\s*(\d+)/i);
  if (fileIdxMatch) analysis.fileIdx = parseInt(fileIdxMatch[1]);

  // Extract IMDB ID
  const imdbMatch = body.match(/tt\d{7,8}/);
  if (imdbMatch) analysis.imdbId = imdbMatch[0];

  // Extract source
  const sourceMatch = body.match(/"source"\s*:\s*"([^"]+)"/i);
  if (sourceMatch) analysis.source = sourceMatch[1];

  return analysis;
}

// NEW: Generate magnet link from torrent data
export function generateMagnetFromAnalysis(analysis) {
  if (!analysis || !analysis.hashes || analysis.hashes.length === 0) {
    return null;
  }

  const hash = analysis.hashes[0];
  const title = analysis.titles[0] || 'Unknown';
  const trackers = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://tracker.coppersurfer.tk:6969/announce',
    'udp://tracker.leechers-paradise.org:6969/announce',
    'udp://tracker.openbittorrent.com:6969/announce'
  ];

  let magnet = `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}`;
  for (const tracker of trackers) {
    magnet += `&tr=${encodeURIComponent(tracker)}`;
  }

  return magnet;
}
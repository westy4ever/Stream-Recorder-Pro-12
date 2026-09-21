// quality-discoverer.js - Quality Variant Discovery
import { state } from './state.js';

export function discoverQualityVariants() {
  const s = state;
  const networkLog = s.networkLog || [];
  const xhrBodies = s.xhrBodies || [];

  const qualities = {
    variants: [],
    bestQuality: null,
    qualityMap: {},
    sources: []
  };

  const qualityPatterns = [
    { pattern: /1080p|1080|fhd|fullhd/, label: '1080p', rank: 1 },
    { pattern: /720p|720|hd/, label: '720p', rank: 2 },
    { pattern: /480p|480|sd/, label: '480p', rank: 3 },
    { pattern: /360p|360/, label: '360p', rank: 4 },
    { pattern: /240p|240/, label: '240p', rank: 5 },
    { pattern: /2160p|4k|ultrahd/, label: '2160p', rank: 0 }
  ];

  for (const entry of networkLog) {
    if (entry.url) {
      for (const qp of qualityPatterns) {
        if (qp.pattern.test(entry.url)) {
          qualities.variants.push({
            url: entry.url,
            quality: qp.label,
            rank: qp.rank,
            source: 'url'
          });
          if (!qualities.qualityMap[qp.label]) {
            qualities.qualityMap[qp.label] = [];
          }
          qualities.qualityMap[qp.label].push(entry.url);
        }
      }
    }
  }

  for (const body of xhrBodies) {
    if (body.body) {
      try {
        const data = JSON.parse(body.body);
        const urls = extractUrlsFromObject(data);
        for (const url of urls) {
          for (const qp of qualityPatterns) {
            if (qp.pattern.test(url)) {
              qualities.variants.push({
                url: url,
                quality: qp.label,
                rank: qp.rank,
                source: body.url || 'json'
              });
              if (!qualities.qualityMap[qp.label]) {
                qualities.qualityMap[qp.label] = [];
              }
              qualities.qualityMap[qp.label].push(url);
            }
          }
        }
      } catch (e) {
        if (body.body.includes('#EXT-X-STREAM-INF')) {
          const variants = parseHLSPlaylist(body.body);
          for (const variant of variants) {
            qualities.variants.push({
              url: variant.url,
              quality: variant.quality,
              rank: variant.rank,
              source: 'hls_playlist',
              resolution: variant.resolution,
              bandwidth: variant.bandwidth
            });
          }
        }
      }
    }
  }

  if (qualities.variants.length > 0) {
    qualities.variants.sort((a, b) => a.rank - b.rank);
    qualities.bestQuality = qualities.variants[0];
  }

  return qualities;
}

function extractUrlsFromObject(obj) {
  const urls = [];
  if (typeof obj === 'string') {
    const matches = obj.match(/https?:\/\/[^\s"']+/g) || [];
    urls.push(...matches);
  } else if (Array.isArray(obj)) {
    for (const item of obj) {
      urls.push(...extractUrlsFromObject(item));
    }
  } else if (typeof obj === 'object' && obj !== null) {
    for (const [key, value] of Object.entries(obj)) {
      if (key.toLowerCase().includes('url') || key.toLowerCase().includes('src') || key.toLowerCase().includes('file')) {
        urls.push(...extractUrlsFromObject(value));
      } else {
        urls.push(...extractUrlsFromObject(value));
      }
    }
  }
  return urls;
}

function parseHLSPlaylist(playlist) {
  const variants = [];
  const lines = playlist.split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('#EXT-X-STREAM-INF')) {
      const info = lines[i];
      const url = lines[i + 1]?.trim();
      
      if (url) {
        let quality = 'Unknown';
        let rank = 99;
        let resolution = '';
        let bandwidth = '';

        const resMatch = info.match(/RESOLUTION=(\d+)x(\d+)/);
        if (resMatch) {
          resolution = `${resMatch[1]}x${resMatch[2]}`;
          const height = parseInt(resMatch[2]);
          if (height >= 1080) { quality = '1080p'; rank = 1; }
          else if (height >= 720) { quality = '720p'; rank = 2; }
          else if (height >= 480) { quality = '480p'; rank = 3; }
          else if (height >= 360) { quality = '360p'; rank = 4; }
        }

        const bwMatch = info.match(/BANDWIDTH=(\d+)/);
        if (bwMatch) {
          bandwidth = `${Math.round(parseInt(bwMatch[1]) / 1000)}kbps`;
        }

        variants.push({
          url: url,
          quality: quality,
          rank: rank,
          resolution: resolution,
          bandwidth: bandwidth
        });
      }
    }
  }

  return variants;
}
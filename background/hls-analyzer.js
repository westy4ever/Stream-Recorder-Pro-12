// hls-analyzer.js - HLS Playlist Analyzer
import { state } from './state.js';

export function analyzeHLSPlaylist(playlistUrl, playlistContent) {
  if (!playlistContent) {
    return analyzeHLSFromUrl(playlistUrl);
  }

  const analysis = {
    url: playlistUrl,
    type: 'unknown',
    variants: [],
    segments: [],
    duration: 0,
    isMaster: false,
    isMedia: false
  };

  const lines = playlistContent.split('\n');
  let currentVariant = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      analysis.isMaster = true;
      analysis.type = 'master';
      const variant = parseVariantInfo(line);
      const url = lines[i + 1]?.trim();
      if (url) {
        variant.url = resolveUrl(playlistUrl, url);
        analysis.variants.push(variant);
      }
      continue;
    }

    if (line.startsWith('#EXTINF:')) {
      analysis.isMedia = true;
      analysis.type = 'media';
      const duration = parseFloat(line.replace('#EXTINF:', '').split(',')[0]);
      const url = lines[i + 1]?.trim();
      if (url) {
        analysis.segments.push({
          duration: duration,
          url: resolveUrl(playlistUrl, url)
        });
        analysis.duration += duration;
      }
      continue;
    }

    if (line.startsWith('#EXT-X-TARGETDURATION')) {
      const match = line.match(/\d+/);
      if (match) {
        analysis.targetDuration = parseInt(match[0]);
      }
    }

    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
      const match = line.match(/\d+/);
      if (match) {
        analysis.mediaSequence = parseInt(match[0]);
      }
    }
  }

  if (analysis.isMaster && analysis.variants.length > 0) {
    analysis.summary = {
      totalVariants: analysis.variants.length,
      qualities: [...new Set(analysis.variants.map(v => v.quality))],
      bestQuality: analysis.variants.sort((a, b) => a.rank - b.rank)[0] || null
    };
  }

  if (analysis.isMedia) {
    analysis.summary = {
      totalSegments: analysis.segments.length,
      totalDuration: analysis.duration,
      avgSegmentDuration: analysis.segments.length > 0 ? analysis.duration / analysis.segments.length : 0
    };
  }

  return analysis;
}

function parseVariantInfo(line) {
  const variant = {
    raw: line,
    quality: 'Unknown',
    rank: 99,
    resolution: null,
    bandwidth: null,
    codecs: null
  };

  const resMatch = line.match(/RESOLUTION=(\d+)x(\d+)/);
  if (resMatch) {
    variant.resolution = `${resMatch[1]}x${resMatch[2]}`;
    const height = parseInt(resMatch[2]);
    if (height >= 1080) { variant.quality = '1080p'; variant.rank = 1; }
    else if (height >= 720) { variant.quality = '720p'; variant.rank = 2; }
    else if (height >= 480) { variant.quality = '480p'; variant.rank = 3; }
    else if (height >= 360) { variant.quality = '360p'; variant.rank = 4; }
  }

  const bwMatch = line.match(/BANDWIDTH=(\d+)/);
  if (bwMatch) {
    variant.bandwidth = parseInt(bwMatch[1]);
  }

  const codecMatch = line.match(/CODECS="([^"]+)"/);
  if (codecMatch) {
    variant.codecs = codecMatch[1];
  }

  return variant;
}

function resolveUrl(baseUrl, relativeUrl) {
  if (relativeUrl.startsWith('http://') || relativeUrl.startsWith('https://')) {
    return relativeUrl;
  }
  try {
    const base = new URL(baseUrl);
    return new URL(relativeUrl, base).href;
  } catch (e) {
    return relativeUrl;
  }
}

function analyzeHLSFromUrl(url) {
  return new Promise((resolve) => {
    fetch(url, { 
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' 
      } 
    })
    .then(response => response.text())
    .then(content => {
      resolve(analyzeHLSPlaylist(url, content));
    })
    .catch(() => {
      resolve({ error: 'Failed to fetch playlist' });
    });
  });
}

export function findBestQuality(analysis) {
  if (!analysis || !analysis.variants || analysis.variants.length === 0) {
    return null;
  }

  const sorted = [...analysis.variants].sort((a, b) => a.rank - b.rank);
  return sorted[0];
}

export function generateQualityReport(analysis) {
  if (!analysis) return 'No HLS analysis available.';

  let report = '=== HLS PLAYLIST ANALYSIS ===\n\n';
  report += `URL: ${analysis.url}\n`;
  report += `Type: ${analysis.type}\n\n`;

  if (analysis.isMaster) {
    report += `📊 MASTER PLAYLIST\n`;
    report += `  Variants: ${analysis.variants.length}\n`;
    report += `  Available Qualities: ${analysis.summary?.qualities?.join(', ') || 'Unknown'}\n\n`;

    report += `📋 VARIANT DETAILS:\n`;
    for (const variant of analysis.variants) {
      report += `  [${variant.quality}] ${variant.resolution || 'unknown'}`;
      if (variant.bandwidth) {
        report += ` | ${Math.round(variant.bandwidth / 1000)}kbps`;
      }
      if (variant.codecs) {
        report += ` | ${variant.codecs}`;
      }
      report += `\n    URL: ${variant.url}\n`;
    }
  }

  if (analysis.isMedia) {
    report += `📹 MEDIA PLAYLIST\n`;
    report += `  Segments: ${analysis.segments.length}\n`;
    report += `  Total Duration: ${Math.round(analysis.duration)}s\n`;
    report += `  Target Duration: ${analysis.targetDuration || 'Unknown'}s\n`;
    if (analysis.mediaSequence) {
      report += `  Media Sequence: ${analysis.mediaSequence}\n`;
    }
    report += `\n  First segments:\n`;
    for (const seg of analysis.segments.slice(0, 5)) {
      report += `    [${seg.duration}s] ${seg.url.substring(0, 80)}...\n`;
    }
  }

  if (analysis.summary?.bestQuality) {
    report += `\n⭐ RECOMMENDED QUALITY: ${analysis.summary.bestQuality.quality}`;
    if (analysis.summary.bestQuality.resolution) {
      report += ` (${analysis.summary.bestQuality.resolution})`;
    }
    report += '\n';
  }

  return report;
}
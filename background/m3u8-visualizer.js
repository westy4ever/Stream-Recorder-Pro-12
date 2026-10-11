// m3u8-visualizer.js - M3U8 Playlist Visualizer
import { state } from './state.js';

// [FIX] this function only ever worked when playlistContent was already supplied -- with no
// content, it returned {error: 'No playlist content provided'} unconditionally. Confirmed
// directly: popup.js's "Visualize HLS Playlist" button prompts for a URL and sends ONLY that
// (no content), so this feature has been completely non-functional every time it's been
// clicked -- the sibling "Analyze HLS Playlist" button takes the same kind of input and
// actually works, because hls-analyzer.js's analyzeHLSPlaylist() already has a real
// fetch-from-URL fallback that this file never got. Mirrors that same, already-proven
// fallback here. This necessarily makes the function always return a Promise now (fetching
// is inherently async) -- its caller in message-handlers.js is updated to await it in the
// same change, closing this out the same way Features 14/15/25 were fixed earlier tonight
// rather than leaving a caller behind that still doesn't await it.
export function visualizeHLSPlaylist(playlistUrl, playlistContent) {
  if (!playlistContent) {
    return visualizeHLSFromUrl(playlistUrl);
  }
  return Promise.resolve(visualizeHLSPlaylistSync(playlistUrl, playlistContent));
}

function visualizeHLSFromUrl(url) {
  return new Promise((resolve) => {
    fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    })
    .then(response => response.text())
    .then(content => {
      resolve(visualizeHLSPlaylistSync(url, content));
    })
    .catch(() => {
      resolve({ error: 'Failed to fetch playlist' });
    });
  });
}

function visualizeHLSPlaylistSync(playlistUrl, playlistContent) {
  const analysis = {
    url: playlistUrl,
    type: 'unknown',
    variants: [],
    segments: [],
    duration: 0,
    isMaster: false,
    isMedia: false,
    tree: null,
    summary: {}
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
          url: resolveUrl(playlistUrl, url),
          index: analysis.segments.length
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

  // Build tree
  analysis.tree = buildPlaylistTree(analysis);

  // Generate summary
  // [FIX] .sort() mutates the array it's called on IN PLACE, and this used to call it TWICE
  // in a row on the same analysis.variants -- once ascending for bestQuality, then once
  // descending for worstQuality -- silently leaving analysis.variants in descending-rank
  // order by the time this object literal finished evaluating. Confirmed directly: since
  // buildPlaylistTree() above already ran BEFORE this mutation (using the original, as-parsed
  // order) while the "VARIANT DETAILS" list further down in generateVisualizationReport()
  // runs AFTER it (seeing the now-mutated order), the SAME generated report showed the SAME
  // variants in two different, inconsistent orders in two adjacent sections. bestQuality and
  // worstQuality themselves were still computed correctly either way (a second sort of an
  // already-sorted array is still correct), but the shared array itself should never have
  // been touched to get there. Same bug class already confirmed and fixed in the sibling
  // hls-analyzer.js and quality-discoverer.js this session.
  const sortedAscending = [...analysis.variants].sort((a, b) => a.rank - b.rank);
  const sortedDescending = [...analysis.variants].sort((a, b) => b.rank - a.rank);
  analysis.summary = {
    totalVariants: analysis.variants.length,
    totalSegments: analysis.segments.length,
    totalDuration: analysis.duration,
    avgSegmentDuration: analysis.segments.length > 0 ? analysis.duration / analysis.segments.length : 0,
    qualities: [...new Set(analysis.variants.map(v => v.quality))],
    bestQuality: sortedAscending[0] || null,
    worstQuality: sortedDescending[0] || null
  };

  return analysis;
}

function parseVariantInfo(line) {
  const variant = {
    raw: line,
    quality: 'Unknown',
    rank: 99,
    resolution: null,
    bandwidth: null,
    codecs: null,
    fps: null
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

  const fpsMatch = line.match(/FRAME-RATE=([\d.]+)/);
  if (fpsMatch) {
    variant.fps = parseFloat(fpsMatch[1]);
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

function buildPlaylistTree(analysis) {
  const tree = {
    name: '📹 ' + (analysis.url ? analysis.url.split('/').pop() : 'playlist'),
    children: []
  };

  if (analysis.isMaster) {
    tree.children = analysis.variants.map(v => ({
      name: `🎯 ${v.quality} (${Math.round(v.bandwidth / 1000)}kbps)`,
      children: [{
        name: `${v.resolution || 'unknown'} | ${v.codecs || 'unknown'}`,
        children: []
      }],
      url: v.url
    }));
  } else if (analysis.isMedia) {
    const segments = analysis.segments.slice(0, 10);
    tree.children = segments.map(s => ({
      name: `📄 segment_${String(s.index).padStart(4, '0')}.ts (${s.duration}s)`,
      children: [],
      url: s.url
    }));
    if (analysis.segments.length > 10) {
      tree.children.push({
        name: `... and ${analysis.segments.length - 10} more segments`,
        children: []
      });
    }
  }

  return tree;
}

export function generateVisualizationReport(analysis) {
  if (!analysis) return 'No HLS analysis available.';

  let report = '=== HLS PLAYLIST VISUALIZATION ===\n\n';

  report += `📹 ${analysis.url}\n`;
  report += `Type: ${analysis.type.toUpperCase()}\n\n`;

  report += '📊 SUMMARY:\n';
  report += `  ${analysis.isMaster ? 'Variants: ' + analysis.summary.totalVariants : 'Segments: ' + analysis.summary.totalSegments}\n`;
  report += `  Total Duration: ${formatDuration(analysis.duration)}\n`;

  if (analysis.isMaster) {
    report += `  Available Qualities: ${analysis.summary.qualities.join(', ') || 'Unknown'}\n`;
    if (analysis.summary.bestQuality) {
      report += `  🏆 Best: ${analysis.summary.bestQuality.quality}`;
      if (analysis.summary.bestQuality.resolution) {
        report += ` (${analysis.summary.bestQuality.resolution})`;
      }
      if (analysis.summary.bestQuality.bandwidth) {
        report += ` | ${Math.round(analysis.summary.bestQuality.bandwidth / 1000)}kbps`;
      }
      report += '\n';
    }
  }

  report += '\n' + drawPlaylistTree(analysis.tree, 0);

  if (analysis.isMaster) {
    report += '\n📋 VARIANT DETAILS:\n';
    for (const variant of analysis.variants) {
      report += `  [${variant.quality}]`;
      if (variant.resolution) report += ` ${variant.resolution}`;
      if (variant.bandwidth) report += ` | ${Math.round(variant.bandwidth / 1000)}kbps`;
      if (variant.fps) report += ` | ${variant.fps}fps`;
      if (variant.codecs) report += ` | ${variant.codecs}`;
      report += `\n    ${variant.url}\n`;
    }
  }

  return report;
}

function drawPlaylistTree(node, depth) {
  const indent = '  '.repeat(depth);
  let output = '';

  if (typeof node === 'object' && node.name) {
    output += `${indent}${node.name}\n`;
    if (node.children && node.children.length > 0) {
      for (const child of node.children) {
        output += drawPlaylistTree(child, depth + 1);
      }
    }
  }

  return output;
}

function formatDuration(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    return `${mins}:${String(secs).padStart(2, '0')}`;
  }
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.round(seconds % 60);
  return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

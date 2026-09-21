// m3u8-visualizer.js - M3U8 Playlist Visualizer
import { state } from './state.js';

export function visualizeHLSPlaylist(playlistUrl, playlistContent) {
  if (!playlistContent) {
    return { error: 'No playlist content provided' };
  }

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
  analysis.summary = {
    totalVariants: analysis.variants.length,
    totalSegments: analysis.segments.length,
    totalDuration: analysis.duration,
    avgSegmentDuration: analysis.segments.length > 0 ? analysis.duration / analysis.segments.length : 0,
    qualities: [...new Set(analysis.variants.map(v => v.quality))],
    bestQuality: analysis.variants.sort((a, b) => a.rank - b.rank)[0] || null,
    worstQuality: analysis.variants.sort((a, b) => b.rank - a.rank)[0] || null
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
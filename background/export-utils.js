// export-utils.js - Export functions
export function exportAsCSV(data) {
  const headers = ['timestamp', 'type', 'url', 'method', 'status'];
  const rows = (data.networkLog || []).map(entry => 
    headers.map(h => {
      let val = entry[h] || '';
      if (typeof val === 'string' && val.includes(',')) {
        val = `"${val}"`;
      }
      return val;
    }).join(',')
  );
  return [headers.join(','), ...rows].join('\n');
}

export function exportAsHAR(data) {
  return {
    log: {
      version: '1.2',
      creator: { name: 'Stream Recorder Pro', version: '3.0' },
      entries: (data.networkLog || []).map(entry => ({
        startedDateTime: new Date(entry.timestamp).toISOString(),
        time: 0,
        request: {
          method: entry.method || 'GET',
          url: entry.url,
          httpVersion: 'HTTP/1.1',
          headers: Object.entries(entry.requestHeaders || {}).map(([name, value]) => ({ name, value })),
          cookies: [],
          queryString: [],
          postData: entry.requestBody ? { mimeType: 'application/json', text: entry.requestBody } : undefined
        },
        response: {
          status: entry.statusCode || 0,
          statusText: '',
          httpVersion: 'HTTP/1.1',
          headers: Object.entries(entry.responseHeaders || {}).map(([name, value]) => ({ name, value })),
          cookies: [],
          content: { size: 0, mimeType: 'application/json' }
        },
        cache: {},
        timings: { send: 0, wait: 0, receive: 0 }
      }))
    }
  };
}

export function exportAsMarkdown(data) {
  let md = '# Stream Recorder Export\n\n';
  md += `## Summary\n`;
  md += `- Recorded: ${new Date().toISOString()}\n`;
  md += `- Filter Mode: ${data.filterMode || 'all'}\n`;
  md += `- Actions: ${data.actions?.length || 0}\n`;
  md += `- Network Log: ${data.networkLog?.length || 0}\n`;
  md += `- XHR Bodies: ${data.xhrBodies?.length || 0}\n\n`;
  
  if (data.contentPipeline?.movieList?.length) {
    md += `## Movies\n`;
    data.contentPipeline.movieList.forEach((m, i) => {
      md += `${i+1}. **${m.title}**`;
      if (m.year) md += ` (${m.year})`;
      if (m.rating) md += ` ⭐${m.rating}`;
      if (m.quality) md += ` [${m.quality}]`;
      if (m.genre) md += ` 🎭${m.genre}`;
      md += `\n   URL: ${m.url}\n`;
    });
    md += '\n';
  }
  
  if (data.contentPipeline?.downloadLinks?.length) {
    md += `## Downloads\n`;
    data.contentPipeline.downloadLinks.forEach((d, i) => {
      md += `${i+1}. **${d.filename || 'Unknown'}**\n`;
      md += `   URL: ${d.downloadUrl || d.url || ''}\n`;
      if (d.filesize) md += `   Size: ${d.filesize}\n`;
      if (d.expiry) md += `   Expires: ${d.expiry} hours\n`;
    });
    md += '\n';
  }
  
  if (data.userJourney?.length) {
    md += `## User Journey\n`;
    data.userJourney.forEach((step, i) => {
      const time = new Date(step.timestamp).toLocaleTimeString();
      md += `${i+1}. [${time}] ${step.action} → ${step.url}\n`;
    });
  }
  
  return md;
}
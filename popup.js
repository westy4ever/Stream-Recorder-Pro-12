// popup.js – Stream Recorder Pro with ALL improvements

let currentRecordingData = null;
let streamLinks = [];
let isExporting = false;

const startBtn = document.getElementById("start");
const stopBtn = document.getElementById("stop");
const exportBtn = document.getElementById("export");
const exportMarkdownBtn = document.getElementById("exportMarkdown");
const copyBtn = document.getElementById("copy");
const solveBtn = document.getElementById("solveChallenge");
const saveSnapshotBtn = document.getElementById("saveSnapshot");
const copyStreamLinksBtn = document.getElementById("copyStreamLinks");
const extractYTSTorrentsBtn = document.getElementById("extractYTSTorrents");
const extractArabicMoviesBtn = document.getElementById("extractArabicMovies");
const extractSaveFilesBtn = document.getElementById("extractSaveFiles");
const findTorrentApiBtn = document.getElementById("findTorrentApi");
const viewPipelineBtn = document.getElementById("viewPipeline");
const statusDiv = document.getElementById("status");
const challengeStatusDiv = document.getElementById("challengeStatus");
const jsonPreview = document.getElementById("jsonPreview");
const xhrOnlyCheckbox = document.getElementById("xhrOnly");
const filterHint = document.getElementById("filterHint");
const autoSnapshotCheckbox = document.getElementById("autoSnapshot");
const hideTMDBCheckbox = document.getElementById("hideTMDB");
const recordTabSelect = document.getElementById("recordTab");
const progressFill = document.getElementById("progressFill");
const torrentResultsDiv = document.getElementById("torrentResults");
const optionsLink = document.getElementById("optionsLink");
const popOutBtn = document.getElementById("popOutBtn");
const detachedHint = document.getElementById("detachedHint");
const recBadge = document.getElementById("recBadge");

// Popout window support
chrome.windows.getCurrent((win) => {
  if (win.type === "popup") {
    popOutBtn.style.display = "none";
    detachedHint.style.display = "block";
  }
});

popOutBtn.onclick = () => {
  chrome.windows.create({
    url: chrome.runtime.getURL("popup.html"),
    type: "popup",
    width: 500,
    height: 820,
    focused: true
  });
  window.close();
};

// Load saved preferences
chrome.storage.local.get(["xhrOnly", "autoSnapshot", "hideTMDB", "recordTab"], (result) => {
  xhrOnlyCheckbox.checked = !!result.xhrOnly;
  autoSnapshotCheckbox.checked = !!result.autoSnapshot;
  hideTMDBCheckbox.checked = result.hideTMDB !== false;
  recordTabSelect.value = result.recordTab || "all";
  updateFilterHint();
});

xhrOnlyCheckbox.onchange = () => {
  chrome.storage.local.set({ xhrOnly: xhrOnlyCheckbox.checked });
  updateFilterHint();
};

autoSnapshotCheckbox.onchange = () => {
  chrome.storage.local.set({ autoSnapshot: autoSnapshotCheckbox.checked });
  chrome.runtime.sendMessage({ type: "autoSnapshotToggled", enabled: autoSnapshotCheckbox.checked });
};

hideTMDBCheckbox.onchange = () => {
  chrome.storage.local.set({ hideTMDB: hideTMDBCheckbox.checked });
};

recordTabSelect.onchange = () => {
  chrome.storage.local.set({ recordTab: recordTabSelect.value });
};

function updateFilterHint() {
  filterHint.innerText = xhrOnlyCheckbox.checked
    ? "(only XHR/fetch calls captured)"
    : "(unchecked = capture everything)";
}

// Get current recording status
chrome.runtime.sendMessage({ type: "getRecordingStatus" }, (response) => {
  if (response && response.recording) {
    setRecordingUI(true, response.filterMode);
    autoSnapshotCheckbox.checked = !!response.autoSnapshot;
    if (response.recordTabId) {
      recordTabSelect.value = "current";
    }
  }
});

function setRecordingUI(isRecording, filterMode) {
  xhrOnlyCheckbox.disabled = isRecording;
  autoSnapshotCheckbox.disabled = isRecording;
  recordTabSelect.disabled = isRecording;
  if (isRecording) {
    recBadge.textContent = "🔴 REC";
    recBadge.className = "badge badge-rec";
    statusDiv.innerText = filterMode === "xhr" ? "🔴 Recording (XHR/Fetch only)..." : "🔴 Recording (everything + SPA + WebSocket)...";
    statusDiv.style.background = "#2e7d32";
    startBtn.disabled = true;
    stopBtn.disabled = false;
  } else {
    recBadge.textContent = "⏹ Stopped";
    recBadge.className = "badge";
    statusDiv.style.background = "#161B22";
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }
}

// ═══ START RECORDING ═══
startBtn.onclick = () => {
  const filterMode = xhrOnlyCheckbox.checked ? "xhr" : "all";
  const autoSnapshot = autoSnapshotCheckbox.checked;
  const useCurrentTabOnly = recordTabSelect.value === "current";

  const startWith = (tabId) => {
    chrome.storage.sync.get(['allowedDomains', 'blockedDomains', 'maxBodySize'], (cfg) => {
      chrome.runtime.sendMessage({
        type: "startRecording",
        filterMode,
        autoSnapshot,
        tabId: tabId,
        allowedDomains: cfg.allowedDomains || [],
        blockedDomains: cfg.blockedDomains || [],
        maxBodySize: cfg.maxBodySize || 100
      });
    });
  };

  if (useCurrentTabOnly) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      startWith(tabs && tabs[0] ? tabs[0].id : null);
    });
  } else {
    startWith(null);
  }

  setRecordingUI(true, filterMode);
  jsonPreview.value = "";
  currentRecordingData = null;
  streamLinks = [];
  torrentResultsDiv.innerHTML = "";
  torrentResultsDiv.style.display = "none";
  progressFill.style.width = "0%";
};

// ═══ STOP RECORDING ═══
stopBtn.onclick = () => {
  chrome.runtime.sendMessage({ type: "stopRecording" });
  setRecordingUI(false);
  statusDiv.innerText = "⏹ Stopped. Fetching data...";
  progressFill.style.width = "30%";
  
  chrome.runtime.sendMessage({ type: "getRecordingData" }, (response) => {
    if (response && response.data) {
      currentRecordingData = response.data;
      const jsonStr = JSON.stringify(currentRecordingData, null, 2);
      jsonPreview.value = jsonStr;
      statusDiv.innerText = `✅ Ready. ${currentRecordingData.actions?.length || 0} actions, ${currentRecordingData.networkLog?.length || 0} network entries.`;
      progressFill.style.width = "100%";
      setTimeout(() => { progressFill.style.width = "0%"; }, 1000);
    } else {
      statusDiv.innerText = "❌ No recording data found.";
      jsonPreview.value = "";
      progressFill.style.width = "0%";
    }
  });
};

// ═══ EXPORT SCOPE (large sessions -> smaller, focused files) ═══
const exportScopeSelect = document.getElementById("exportScope");

// The top-level sections a recording can be split into, in the order they should download.
const EXPORT_SECTIONS = [
  { key: 'networkLog', label: 'networkLog' },
  { key: 'xhrBodies', label: 'xhrBodies' },
  { key: 'actions', label: 'actions' },
  { key: 'userJourney', label: 'userJourney' },
  { key: 'contentPipeline', label: 'contentPipeline' },
];

// Returns a smaller data object containing only what the chosen scope asks for. "all" and
// "split" both return the full object -- "split" needs every section available so it can
// hand each one to a separate download; only single-section scopes actually filter anything.
// This is deliberately just a filter in front of the EXISTING export functions (exportAsCSV /
// exportAsHAR / exportAsMarkdown / plain JSON.stringify) rather than a rewrite of them, so
// every format keeps working exactly as it did before for anyone who leaves scope on "all".
function getScopedData(data, scope) {
  if (scope === 'all' || scope === 'split' || !scope) return data;
  if (scope === 'actions') {
    // "Actions / Journey" is a combined view since both describe user-driven navigation.
    return { actions: data.actions || [], userJourney: data.userJourney || [] };
  }
  if (EXPORT_SECTIONS.some(s => s.key === scope)) {
    return { [scope]: data[scope] };
  }
  return data;
}

function sizeLabel(str) {
  const bytes = str.length;
  if (bytes > 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  if (bytes > 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

function downloadBlob(content, filename, mimeType) {
  return new Promise((resolve) => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename, saveAs: false }, (downloadId) => {
      const ok = !chrome.runtime.lastError;
      URL.revokeObjectURL(url);
      resolve({ ok, filename, error: chrome.runtime.lastError?.message });
    });
  });
}

// One section can still be huge on its own (a long session's networkLog, say) even after
// splitting by category. MAX_CHUNK_BYTES caps how big any single downloaded file is allowed
// to get -- an oversized array-valued section is broken into further "_part1", "_part2", ...
// files, each under this size, instead of one very large file for that section.
const MAX_CHUNK_BYTES = 4 * 1024 * 1024; // 4MB -- comfortably uploadable/readable in one go

// Splits an array into pieces whose SERIALIZED JSON size each stay under maxBytes. A single
// item that is itself larger than maxBytes still gets its own chunk (never dropped, never
// stuck in an infinite loop) -- it just can't be shrunk further without losing data.
function chunkArrayBySize(array, maxBytes) {
  const chunks = [];
  let current = [];
  let currentSize = 2; // "[]"
  for (const item of array) {
    const itemSize = JSON.stringify(item).length + 1; // +1 for the comma/bracket overhead
    if (current.length > 0 && currentSize + itemSize > maxBytes) {
      chunks.push(current);
      current = [];
      currentSize = 2;
    }
    current.push(item);
    currentSize += itemSize;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// Splits the recording into one file per non-empty top-level section, plus a small manifest
// file listing what was produced and how big each piece is -- this is what actually solves
// "the JSON is too large to open/upload": each downloaded file stays focused on one kind of
// data instead of everything landing in a single, often huge, combined file. Sections that are
// themselves still too large after that (a long session's networkLog, say) are further broken
// into size-capped "_part1", "_part2", ... files via chunkArrayBySize above, so no single
// downloaded file should end up unmanageably large either way.
async function doSplitExport(data, format) {
  const isMarkdown = format === 'markdown';
  const ext = isMarkdown ? 'md' : 'json';
  const mimeType = isMarkdown ? 'text/markdown' : 'application/json';
  const manifest = [];
  let done = 0;

  const sectionsPresent = EXPORT_SECTIONS.filter(s => {
    const v = data[s.key];
    return Array.isArray(v) ? v.length > 0 : (v && Object.keys(v).length > 0);
  });

  // Pre-flight: work out how many files each section will actually produce, so progress
  // reporting and the manifest both reflect the real total (including chunked-out parts).
  const plan = sectionsPresent.map(section => {
    const value = data[section.key];
    if (Array.isArray(value)) {
      const wholeSize = JSON.stringify(value).length;
      if (wholeSize > MAX_CHUNK_BYTES) {
        return { section, chunks: chunkArrayBySize(value, MAX_CHUNK_BYTES) };
      }
      return { section, chunks: [value] };
    }
    // non-array sections (contentPipeline, etc.) aren't chunked internally -- downloaded whole.
    return { section, chunks: [value] };
  });
  const total = plan.reduce((n, p) => n + p.chunks.length, 0);

  for (const { section, chunks } of plan) {
    const multi = chunks.length > 1;
    for (let i = 0; i < chunks.length; i++) {
      const scoped = { [section.key]: chunks[i] };
      const content = isMarkdown ? exportAsMarkdown(scoped) : JSON.stringify(scoped, null, 2);
      const partSuffix = multi ? `_part${i + 1}of${chunks.length}` : '';
      const filename = `stream_recording_${section.label}${partSuffix}.${ext}`;
      const result = await downloadBlob(content, filename, mimeType);
      manifest.push(`${result.ok ? '✅' : '❌'} ${filename} — ${sizeLabel(content)}${result.error ? ' (' + result.error + ')' : ''}`);
      done++;
      progressFill.style.width = Math.round((done / total) * 90) + "%";
      statusDiv.innerText = `⏳ Splitting export... (${done}/${total})`;
      // small gap between downloads -- Chrome silently drops downloads fired in too tight a burst
      await new Promise(r => setTimeout(r, 150));
    }
  }

  const manifestText = `Stream Recorder Pro — split export manifest\n` +
    `Generated: ${new Date().toISOString()}\n` +
    `Max file size target: ${(MAX_CHUNK_BYTES / 1024 / 1024).toFixed(0)} MB per file\n\n` +
    manifest.join('\n') + '\n';
  await downloadBlob(manifestText, 'stream_recording_MANIFEST.txt', 'text/plain');

  progressFill.style.width = "100%";
  statusDiv.innerText = `✅ Split export done: ${total} file(s) + manifest`;
  setTimeout(() => {
    if (statusDiv.innerText.includes("Split export done")) statusDiv.innerText = "✅ Ready";
  }, 3000);
}

// ═══ EXPORT FUNCTIONS ═══
function doExport(format) {
  if (!currentRecordingData) { alert("No recording data. Click Stop first."); return; }
  if (isExporting) return;
  isExporting = true;

  const scope = exportScopeSelect ? exportScopeSelect.value : 'all';

  statusDiv.innerText = `⏳ Exporting ${format.toUpperCase()}... (0%)`;
  progressFill.style.width = "0%";

  if (scope === 'split' && (format === 'json' || format === 'markdown')) {
    doSplitExport(currentRecordingData, format).finally(() => { isExporting = false; });
    return;
  }

  try {
    const data = getScopedData(currentRecordingData, scope);
    let content, filename, mimeType;
    const scopeSuffix = (scope && scope !== 'all') ? `_${scope}` : '';
    
    switch (format) {
      case 'csv':
        content = exportAsCSV(data);
        // ═══ FIX: Use proper filename ═══
        filename = `stream_recording${scopeSuffix}.csv`;
        mimeType = 'text/csv';
        break;
      case 'har':
        content = JSON.stringify(exportAsHAR(data), null, 2);
        filename = `stream_recording${scopeSuffix}.har`;
        mimeType = 'application/json';
        break;
      case 'markdown':
        content = exportAsMarkdown(data);
        // ═══ FIX: Use proper filename ═══
        filename = `stream_recording${scopeSuffix}.md`;
        mimeType = 'text/markdown';
        break;
      default:
        content = JSON.stringify(data, null, 2);
        // ═══ FIX: Use proper filename ═══
        filename = `stream_recording${scopeSuffix}.json`;
        mimeType = 'application/json';
    }
    
    const chunks = Math.ceil(content.length / (1024 * 1024));
    let progress = 0;
    const interval = setInterval(() => {
      progress = Math.min(progress + 10, 90);
      progressFill.style.width = progress + "%";
      statusDiv.innerText = `⏳ Exporting ${format.toUpperCase()}... (${progress}%)`;
      if (progress >= 90) clearInterval(interval);
    }, 100);
    
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    
    chrome.downloads.download({
      url: url,
      // ═══ FIX: Use the filename variable ═══
      filename: filename,
      saveAs: true
    }, (downloadId) => {
      clearInterval(interval);
      progressFill.style.width = "100%";
      if (chrome.runtime.lastError) {
        statusDiv.innerText = `❌ Export ${format} failed: ${chrome.runtime.lastError.message}`;
      } else {
        statusDiv.innerText = `✅ Exported ${format.toUpperCase()} as ${filename} (${sizeLabel(content)})`;
        setTimeout(() => {
          if (statusDiv.innerText.includes("Exported")) {
            statusDiv.innerText = "✅ Ready";
          }
        }, 3000);
      }
      URL.revokeObjectURL(url);
      isExporting = false;
    });
  } catch (e) {
    statusDiv.innerText = `❌ Export ${format} error: ${e.message}`;
    progressFill.style.width = "0%";
    isExporting = false;
  }
}

function exportAsCSV(data) {
  const headers = ['timestamp', 'type', 'url', 'method', 'status'];
  const rows = (data.networkLog || []).map(entry => 
    headers.map(h => {
      let val = entry[h] || '';
      if (typeof val === 'string' && (val.includes(',') || val.includes('"'))) {
        val = `"${val.replace(/"/g, '""')}"`;
      }
      return val;
    }).join(',')
  );
  return [headers.join(','), ...rows].join('\n');
}

function exportAsHAR(data) {
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

function exportAsMarkdown(data) {
  let md = '# Stream Recorder Pro Export\n\n';
  md += `> Generated: ${new Date().toISOString()}\n\n`;
  
  // ═══ SUMMARY ═══
  md += `## 📊 Summary\n\n`;
  md += `| Metric | Value |\n`;
  md += `|--------|-------|\n`;
  md += `| Filter Mode | ${data.filterMode || 'all'} |\n`;
  md += `| Actions | ${data.actions?.length || 0} |\n`;
  md += `| Network Log | ${data.networkLog?.length || 0} |\n`;
  md += `| XHR Bodies | ${data.xhrBodies?.length || 0} |\n`;
  md += `| User Journey | ${data.userJourney?.length || 0} steps |\n`;
  md += `| Screenshots | ${data.screenshots?.length || 0} |\n`;
  md += `| Movies Found | ${data.contentPipeline?.movieList?.length || 0} |\n`;
  md += `| Downloads Found | ${data.contentPipeline?.downloadLinks?.length || 0} |\n\n`;

  // ═══ USER JOURNEY ═══
  if (data.userJourney && data.userJourney.length > 0) {
    md += `## 🗺️ User Journey\n\n`;
    md += `| # | Time | Action | URL |\n`;
    md += `|---|------|--------|-----|\n`;
    data.userJourney.forEach((step, i) => {
      const time = new Date(step.timestamp).toLocaleTimeString();
      const action = step.action || 'unknown';
      const url = step.url || '';
      md += `| ${i+1} | ${time} | ${action} | ${url} |\n`;
    });
    md += '\n';
  }

  // ═══ ACTIONS ═══
  if (data.actions && data.actions.length > 0) {
    md += `## 🎯 Actions\n\n`;
    md += `| # | Time | Type | URL | Selector |\n`;
    md += `|---|------|------|-----|----------|\n`;
    data.actions.slice(0, 100).forEach((action, i) => {
      const time = new Date(action.timestamp).toLocaleTimeString();
      const type = action.type || 'unknown';
      const url = action.url || action.href || '';
      const selector = action.selector || '';
      md += `| ${i+1} | ${time} | ${type} | ${url} | ${selector} |\n`;
    });
    if (data.actions.length > 100) {
      md += `| ... | ... | ... | ... | ... |\n`;
      md += `| *${data.actions.length - 100} more actions* | | | |\n`;
    }
    md += '\n';
  }

  // ═══ NETWORK REQUESTS ═══
  if (data.networkLog && data.networkLog.length > 0) {
    md += `## 🌐 Network Requests\n\n`;
    md += `| # | Time | Method | Status | URL |\n`;
    md += `|---|------|--------|--------|-----|\n`;
    data.networkLog.slice(0, 100).forEach((req, i) => {
      const time = new Date(req.timestamp).toLocaleTimeString();
      const method = req.method || 'GET';
      const status = req.statusCode || req.status || '?';
      const url = req.url || '';
      md += `| ${i+1} | ${time} | ${method} | ${status} | ${url} |\n`;
    });
    if (data.networkLog.length > 100) {
      md += `| ... | ... | ... | ... | ... |\n`;
      md += `| *${data.networkLog.length - 100} more requests* | | | |\n`;
    }
    md += '\n';
  }

  // ═══ API RESPONSES (XHR Bodies) ═══
  if (data.xhrBodies && data.xhrBodies.length > 0) {
    md += `## 📡 API Responses (XHR/Fetch)\n\n`;
    
    const grouped = {};
    for (const body of data.xhrBodies) {
      const key = body.url || 'unknown';
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(body);
    }
    
    for (const [url, bodies] of Object.entries(grouped)) {
      md += `### 🔗 ${url}\n\n`;
      md += `| # | Method | Status | Via | Truncated | Time |\n`;
      md += `|---|--------|--------|-----|-----------|------|\n`;
      bodies.slice(0, 5).forEach((body, i) => {
        const method = body.method || 'GET';
        const status = body.status || '?';
        const via = body.via || 'unknown';
        const truncated = body.truncated ? '⚠️ Yes' : '✅ No';
        const time = new Date(body.timestamp).toLocaleTimeString();
        md += `| ${i+1} | ${method} | ${status} | ${via} | ${truncated} | ${time} |\n`;
      });
      if (bodies.length > 5) {
        md += `| ... | *${bodies.length - 5} more* | | | |\n`;
      }
      
      const lastBody = bodies[bodies.length - 1];
      if (lastBody && lastBody.body) {
        md += `\n**Response Body:**\n`;
        md += '```json\n';
        try {
          const parsed = JSON.parse(lastBody.body);
          md += JSON.stringify(parsed, null, 2).substring(0, 2000);
          if (JSON.stringify(parsed, null, 2).length > 2000) {
            md += '\n... (truncated, full in JSON export)';
          }
        } catch (e) {
          md += lastBody.body.substring(0, 2000);
          if (lastBody.body.length > 2000) {
            md += '\n... (truncated, full in JSON export)';
          }
        }
        md += '\n```\n\n';
      }
    }
  }

  // ═══ CONTENT PIPELINE - MOVIES ═══
  if (data.contentPipeline?.movieList && data.contentPipeline.movieList.length > 0) {
    md += `## 🎬 Movies Found\n\n`;
    data.contentPipeline.movieList.forEach((movie, i) => {
      md += `### ${i+1}. ${movie.title || 'Unknown Title'}\n`;
      if (movie.year) md += `- **Year:** ${movie.year}\n`;
      if (movie.rating) md += `- **Rating:** ⭐${movie.rating}\n`;
      if (movie.quality) md += `- **Quality:** ${movie.quality}\n`;
      if (movie.genre) md += `- **Genre:** ${movie.genre}\n`;
      if (movie.url) md += `- **URL:** ${movie.url}\n`;
      if (movie.poster) md += `- **Poster:** ${movie.poster}\n`;
      md += '\n';
    });
  }

  // ═══ CONTENT PIPELINE - DOWNLOADS ═══
  if (data.contentPipeline?.downloadLinks && data.contentPipeline.downloadLinks.length > 0) {
    md += `## 📥 Downloads Found\n\n`;
    data.contentPipeline.downloadLinks.forEach((dl, i) => {
      md += `### ${i+1}. ${dl.filename || 'Unknown File'}\n`;
      if (dl.downloadUrl || dl.url) md += `- **URL:** ${dl.downloadUrl || dl.url}\n`;
      if (dl.filesize) md += `- **Size:** ${dl.filesize}\n`;
      if (dl.expiry) md += `- **Expires:** ${dl.expiry} hours\n`;
      if (dl.mime) md += `- **MIME:** ${dl.mime}\n`;
      md += '\n';
    });
  }

  // ═══ CONTENT PIPELINE - METADATA ═══
  if (data.contentPipeline?.metadata && Object.keys(data.contentPipeline.metadata).length > 0) {
    md += `## 📋 Metadata\n\n`;
    md += `| Key | Value |\n`;
    md += `|-----|-------|\n`;
    for (const [key, value] of Object.entries(data.contentPipeline.metadata)) {
      md += `| ${key} | ${value} |\n`;
    }
    md += '\n';
  }

  // ═══ CONTENT PIPELINE - SEQUENCE ═══
  if (data.contentPipeline?.sequence && data.contentPipeline.sequence.length > 0) {
    md += `## 🔄 Pipeline Sequence\n\n`;
    md += `| # | Time | Type | Data |\n`;
    md += `|---|------|------|------|\n`;
    data.contentPipeline.sequence.slice(0, 50).forEach((step, i) => {
      const time = new Date(step.timestamp).toLocaleTimeString();
      const type = step.type || 'unknown';
      const dataSummary = step.data ? Object.keys(step.data).join(', ') : '';
      md += `| ${i+1} | ${time} | ${type} | ${dataSummary} |\n`;
    });
    if (data.contentPipeline.sequence.length > 50) {
      md += `| ... | *${data.contentPipeline.sequence.length - 50} more* | |\n`;
    }
    md += '\n';
  }

  // ═══ SCREENSHOTS ═══
  if (data.screenshots && data.screenshots.length > 0) {
    md += `## 📸 Screenshots\n\n`;
    md += `| # | Time | Tab ID |\n`;
    md += `|---|------|--------|\n`;
    data.screenshots.forEach((s, i) => {
      const time = new Date(s.timestamp).toLocaleTimeString();
      md += `| ${i+1} | ${time} | ${s.tabId || 'N/A'} |\n`;
    });
    md += '\n';
    md += `> 💡 Full screenshot data available in JSON export.\n\n`;
  }

  // ═══ STREAM URLS ═══
  const streamUrls = [];
  if (data.networkLog) {
    for (const entry of data.networkLog) {
      if (entry.url && (entry.url.includes('.m3u8') || entry.url.includes('.mp4') || entry.url.includes('.ts'))) {
        streamUrls.push(entry.url);
      }
    }
  }
  if (data.xhrBodies) {
    for (const body of data.xhrBodies) {
      if (body.body) {
        const matches = body.body.match(/https?:\/\/[^\s"']+\.(?:m3u8|mp4|ts)[^\s"']*/g) || [];
        streamUrls.push(...matches);
      }
    }
  }
  
  if (streamUrls.length > 0) {
    md += `## 🎬 Stream URLs Found (${streamUrls.length})\n\n`;
    const unique = [...new Set(streamUrls)];
    unique.slice(0, 50).forEach((url, i) => {
      md += `${i+1}. ${url}\n`;
    });
    if (unique.length > 50) {
      md += `\n... and ${unique.length - 50} more streams\n`;
    }
    md += '\n';
  }

  // ═══ CONTENT PIPELINE - SOURCE ═══
  if (data.contentPipeline?.source) {
    md += `## 📌 Content Source\n\n`;
    md += `**Source:** ${data.contentPipeline.source}\n\n`;
  }

  // ═══ FOOTER ═══
  md += `---\n\n`;
  md += `*Generated by Stream Recorder Pro v4.0.0*\n`;
  md += `*For full data, use the JSON export.*\n`;

  return md;
}

exportBtn.onclick = () => { doExport('json'); };
exportMarkdownBtn.onclick = () => { doExport('markdown'); };

// ═══ COPY ═══
copyBtn.onclick = () => {
  if (!currentRecordingData) { alert("No recording data. Click Stop first."); return; }
  const jsonStr = JSON.stringify(currentRecordingData, null, 2);
  navigator.clipboard.writeText(jsonStr).then(() => {
    statusDiv.innerText = "📋 JSON copied to clipboard!";
    setTimeout(() => {
      if (statusDiv.innerText === "📋 JSON copied to clipboard!") {
        statusDiv.innerText = "✅ Ready";
      }
    }, 2000);
  }).catch(err => {
    alert("Copy failed: " + err);
    statusDiv.innerText = "❌ Copy error";
  });
};

// ═══ SNAPSHOT ═══
saveSnapshotBtn.onclick = () => {
  statusDiv.innerText = "📸 Saving snapshot...";
  progressFill.style.width = "30%";
  chrome.runtime.sendMessage({ type: "saveSnapshot" }, (response) => {
    progressFill.style.width = "100%";
    if (response && response.status === "saved") {
      statusDiv.innerText = "✅ Snapshot saved to Downloads folder.";
      setTimeout(() => {
        if (statusDiv.innerText === "✅ Snapshot saved to Downloads folder.") {
          statusDiv.innerText = "✅ Ready";
        }
      }, 3000);
    } else {
      statusDiv.innerText = "❌ Snapshot save failed. Check console.";
    }
    setTimeout(() => { progressFill.style.width = "0%"; }, 500);
  });
};

// ═══ STREAM LINKS ═══
copyStreamLinksBtn.onclick = () => {
  statusDiv.innerText = "🔗 Finding stream links...";
  progressFill.style.width = "30%";
  chrome.runtime.sendMessage({ type: "getStreamLinks" }, (response) => {
    progressFill.style.width = "100%";
    const labeled = (response && response.labeledLinks) || [];
    const links = labeled.length ? labeled : ((response && response.links) || []);
    if (!links.length) {
      statusDiv.innerText = "❌ No stream-looking URLs found yet.";
      setTimeout(() => { progressFill.style.width = "0%"; }, 500);
      return;
    }
    streamLinks = links;
    statusDiv.innerText = `📋 Found ${links.length} stream link(s)! Click to copy.`;
    setTimeout(() => { progressFill.style.width = "0%"; }, 500);
  });
};

document.addEventListener('click', (event) => {
  if (event.target.id === 'copyStreamLinks' && streamLinks.length > 0) {
    navigator.clipboard.writeText(streamLinks.join("\n")).then(() => {
      statusDiv.innerText = `📋 Copied ${streamLinks.length} stream link(s) to clipboard!`;
      setTimeout(() => {
        if (statusDiv.innerText.startsWith("📋 Copied")) {
          statusDiv.innerText = "✅ Ready";
        }
      }, 2500);
    }).catch(err => {
      alert("Copy failed: " + err);
      statusDiv.innerText = "❌ Copy error";
    });
  }
});

// ═══ SOLVE CHALLENGE ═══
solveBtn.onclick = () => {
  chrome.windows.getLastFocused({ windowTypes: ["normal"], populate: true }, (win) => {
    const tab = (win && win.tabs || []).find(t => t.active);
    if (!tab) {
      challengeStatusDiv.innerText = "❌ No active site tab found.";
      return;
    }
    challengeStatusDiv.innerText = "🧩 Starting manual solve...";
    chrome.runtime.sendMessage({
      type: "manualSolve",
      tabId: tab.id,
      url: tab.url
    }, (response) => {
      if (response && response.status === "solving") {
        challengeStatusDiv.innerText = "🧩 Solving challenge... (check new tab)";
      } else {
        challengeStatusDiv.innerText = "❌ Failed to start solving.";
      }
    });
  });
};

// ═══ YTS EXTRACTION ═══
extractYTSTorrentsBtn.onclick = () => {
  chrome.windows.getLastFocused({ windowTypes: ["normal"], populate: true }, (win) => {
    const tab = (win && win.tabs || []).find(t => t.active);
    if (!tab) {
      statusDiv.innerText = "❌ No active site tab found.";
      return;
    }
    
    statusDiv.innerText = "🔍 Extracting torrent links...";
    progressFill.style.width = "30%";
    chrome.runtime.sendMessage({
      type: "extractYTSData",
      tabId: tab.id
    }, (response) => {
      progressFill.style.width = "100%";
      if (response && response.success && response.data && response.data.length > 0) {
        const data = response.data;
        let output = [];
        let totalLinks = 0;
        data.forEach(item => {
          if (item.links && item.links.length > 0) {
            let text = `${item.title}`;
            if (item.year) text += ` (${item.year})`;
            if (item.quality) text += ` - ${item.quality}`;
            output.push(text);
            item.links.forEach(link => {
              output.push(`  ${link.text}: ${link.url}`);
              totalLinks++;
            });
            if (item.poster) output.push(`  Poster: ${item.poster}`);
            output.push('');
          }
        });
        
        const resultText = output.join('\n');
        if (resultText.trim()) {
          navigator.clipboard.writeText(resultText).then(() => {
            const count = data.filter(d => d.links && d.links.length > 0).length;
            statusDiv.innerText = `📋 Extracted ${count} movie(s) with ${totalLinks} links! Check clipboard.`;
            jsonPreview.value = resultText;
          }).catch(err => {
            jsonPreview.value = resultText;
            statusDiv.innerText = "📋 Data extracted! See preview below.";
          });
        } else {
          statusDiv.innerText = "❌ No torrent/magnet links found on this page.";
        }
      } else {
        statusDiv.innerText = "❌ No YTS movie data found on this page. Try navigating to a YTS site.";
      }
      setTimeout(() => { progressFill.style.width = "0%"; }, 500);
    });
  });
};

// ═══ ARABIC MOVIES EXTRACTION ═══
extractArabicMoviesBtn.onclick = () => {
  chrome.windows.getLastFocused({ windowTypes: ["normal"], populate: true }, (win) => {
    const tab = (win && win.tabs || []).find(t => t.active);
    if (!tab) {
      statusDiv.innerText = "❌ No active site tab found.";
      return;
    }
    
    statusDiv.innerText = "🇸🇦 Extracting Arabic movies...";
    progressFill.style.width = "30%";
    chrome.runtime.sendMessage({
      type: "extractArabicMovies",
      tabId: tab.id
    }, (response) => {
      progressFill.style.width = "100%";
      if (response && response.success && response.data && response.data.length > 0) {
        const data = response.data;
        let output = [];
        data.forEach(movie => {
          let line = `${movie.title}`;
          if (movie.year) line += ` (${movie.year})`;
          if (movie.rating) line += ` ⭐${movie.rating}`;
          if (movie.quality) line += ` [${movie.quality}]`;
          if (movie.genre) line += ` 🎭${movie.genre}`;
          line += `\n  🔗 ${movie.url}`;
          output.push(line);
        });
        
        const resultText = output.join('\n\n');
        navigator.clipboard.writeText(resultText).then(() => {
          statusDiv.innerText = `📋 Extracted ${data.length} Arabic movies! Check clipboard.`;
          jsonPreview.value = resultText;
        }).catch(err => {
          jsonPreview.value = resultText;
          statusDiv.innerText = "📋 Data extracted! See preview below.";
        });
      } else {
        statusDiv.innerText = "❌ No Arabic movie data found. Try navigating to WeCima or MyCima.";
      }
      setTimeout(() => { progressFill.style.width = "0%"; }, 500);
    });
  });
};

// ═══ SAVEFILES EXTRACTION ═══
extractSaveFilesBtn.onclick = () => {
  chrome.windows.getLastFocused({ windowTypes: ["normal"], populate: true }, (win) => {
    const tab = (win && win.tabs || []).find(t => t.active);
    if (!tab) {
      statusDiv.innerText = "❌ No active site tab found.";
      return;
    }
    
    statusDiv.innerText = "📦 Extracting SaveFiles download...";
    progressFill.style.width = "30%";
    chrome.runtime.sendMessage({
      type: "extractSaveFiles",
      tabId: tab.id
    }, (response) => {
      progressFill.style.width = "100%";
      if (response && response.success && response.data && response.data.downloadUrl) {
        const data = response.data;
        let output = `📥 Download URL:\n${data.downloadUrl}\n\n`;
        if (data.filename) output += `📄 Filename: ${data.filename}\n`;
        if (data.filesize) output += `📊 Filesize: ${data.filesize}\n`;
        if (data.expiry) output += `⏰ Expires in: ${data.expiry} hours\n`;
        if (data.metadata && data.metadata.exactSize) output += `🔢 Exact size: ${data.metadata.exactSize}\n`;
        if (data.metadata && data.metadata.yourIP) output += `🌐 Your IP: ${data.metadata.yourIP}\n`;
        
        navigator.clipboard.writeText(output).then(() => {
          statusDiv.innerText = "📋 Download URL copied to clipboard!";
          jsonPreview.value = output;
        }).catch(err => {
          jsonPreview.value = output;
          statusDiv.innerText = "📋 Data extracted! See preview below.";
        });
      } else {
        statusDiv.innerText = "❌ No SaveFiles download found. Try navigating to a SaveFiles download page.";
      }
      setTimeout(() => { progressFill.style.width = "0%"; }, 500);
    });
  });
};

// ═══ FIND TORRENT API ═══
findTorrentApiBtn.onclick = () => {
  const hideTMDB = hideTMDBCheckbox.checked;
  statusDiv.innerText = "🧲 Scanning captured responses for torrent data...";
  progressFill.style.width = "30%";
  chrome.runtime.sendMessage({ type: "getTorrentLinksFiltered", hideTMDB }, (response) => {
    progressFill.style.width = "100%";
    const data = (response && response.data) || [];
    
    if (!data.length) {
      torrentResultsDiv.innerHTML = '<div class="torrent-empty">No torrent API responses found yet.<br><br>1. Start recording<br>2. Browse to a movie/show on the site<br>3. Click it to load torrents<br>4. Click "Find Torrent API" again</div>';
      torrentResultsDiv.style.display = "block";
      statusDiv.innerText = "❌ No torrent data found. Browse a movie first.";
      setTimeout(() => { progressFill.style.width = "0%"; }, 500);
      return;
    }
    
    let html = '';
    for (const item of data) {
      if (item.type === 'torrent_api') {
        html += '<div class="torrent-hit api-found">';
        html += '<h3>🎯 TORRENT API FOUND</h3>';
        html += `<code>${escHtml(item.apiEndpoint)}</code>`;
        html += '<div style="margin:4px 0">';
        html += `<span class="tstat seeds">📊 ${item.infoHashCount} hashes</span>`;
        html += `<span class="tstat">🧲 ${item.magnetCount} magnets</span>`;
        if (item.hasFileIdx) html += '<span class="tstat idx">⚡ torrentio-style</span>';
        if (item.imdbId) html += `<span class="tstat"> IMDb: ${item.imdbId}</span>`;
        html += `<span class="tstat">Status: ${item.status}</span>`;
        html += '</div>';
        if (item.sampleHashes && item.sampleHashes.length) {
          html += `<pre>${escHtml(item.sampleHashes.join('\n'))}</pre>`;
        }
        html += `<details><summary>Body preview (${item.bodyLength} chars)</summary><pre>${escHtml(item.bodyPreview)}</pre></details>`;
        html += `<button class="copy-py-btn" data-url="${escAttr(item.apiEndpoint)}">📋 Copy as Python fetch_json</button>`;
        html += '</div>';
      } else if (item.type === 'direct_magnet') {
        html += '<div class="torrent-hit">';
        html += '<h3>🧲 Direct Magnet URL</h3>';
        html += `<code>${escHtml(item.apiEndpoint)}</code>`;
        html += '</div>';
      } else if (item.type === 'suspected_backend') {
        html += '<div class="torrent-hit" style="border-color:#e67e22">';
        html += '<h3 style="color:#e67e22">🔌 Suspected Backend</h3>';
        html += `<code>${escHtml(item.apiEndpoint)}</code>`;
        html += '<div>';
        html += `<span class="tstat backend">${item.status || '—'}</span>`;
        html += `<span class="tstat">${escHtml(item.contentType || 'unknown')}</span>`;
        html += '</div>';
        html += '</div>';
      }
    }
    torrentResultsDiv.innerHTML = html;
    torrentResultsDiv.style.display = "block";
    statusDiv.innerText = `✅ Found ${data.length} torrent-related response(s)!`;
    setTimeout(() => { progressFill.style.width = "0%"; }, 500);
    
    torrentResultsDiv.querySelectorAll('.copy-py-btn').forEach(btn => {
      btn.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "copyAsPython", url: btn.dataset.url }, (resp) => {
          if (resp && resp.snippet) {
            navigator.clipboard.writeText(resp.snippet).then(() => {
              btn.textContent = '✅ Copied!';
              setTimeout(() => { btn.textContent = '📋 Copy as Python fetch_json'; }, 2000);
            });
          }
        });
      });
    });
  });
};

// ═══ VIEW CONTENT PIPELINE ═══
viewPipelineBtn.onclick = () => {
  statusDiv.innerText = "📊 Fetching content pipeline...";
  progressFill.style.width = "30%";
  chrome.runtime.sendMessage({ type: "getContentPipeline" }, (response) => {
    progressFill.style.width = "100%";
    const data = (response && response.data) || {};
    
    let output = '=== CONTENT PIPELINE ===\n\n';
    
    if (data.source) {
      output += `📌 Source: ${data.source}\n\n`;
    }
    
    if (data.movieList && data.movieList.length > 0) {
      output += `🎬 MOVIES (${data.movieList.length}):\n`;
      data.movieList.forEach((m, i) => {
        output += `  ${i+1}. ${m.title} (${m.year || 'N/A'})`;
        if (m.rating) output += ` ⭐${m.rating}`;
        if (m.quality) output += ` [${m.quality}]`;
        output += '\n';
      });
      output += '\n';
    }
    
    if (data.downloadLinks && data.downloadLinks.length > 0) {
      output += `📥 DOWNLOAD LINKS (${data.downloadLinks.length}):\n`;
      data.downloadLinks.forEach((d, i) => {
        output += `  ${i+1}. ${d.filename || 'Unknown file'}\n`;
        output += `     ${d.downloadUrl || d.url || ''}\n`;
        if (d.filesize) output += `     Size: ${d.filesize}\n`;
        if (d.expiry) output += `     Expires: ${d.expiry} hours\n`;
      });
      output += '\n';
    }
    
    if (data.metadata && Object.keys(data.metadata).length > 0) {
      output += `📋 METADATA:\n`;
      Object.entries(data.metadata).forEach(([key, value]) => {
        output += `  ${key}: ${value}\n`;
      });
      output += '\n';
    }
    
    if (data.sequence && data.sequence.length > 0) {
      output += `🔄 SEQUENCE (${data.sequence.length} steps):\n`;
      data.sequence.forEach((step, i) => {
        const time = new Date(step.timestamp).toLocaleTimeString();
        output += `  ${i+1}. [${time}] ${step.type}`;
        if (step.data && step.data.title) output += ` - ${step.data.title}`;
        output += '\n';
      });
    }
    
    if (!data.movieList && !data.downloadLinks && !data.sequence) {
      output += 'No content pipeline data available yet.\n';
      output += 'Start recording and browse sites to build the pipeline.\n';
    }
    
    jsonPreview.value = output;
    statusDiv.innerText = "📊 Content pipeline displayed below.";
    setTimeout(() => { progressFill.style.width = "0%"; }, 500);
  });
};

// ═══ GENERATE PYTHON EXTRACTOR ═══
document.getElementById('genExtractor').addEventListener('click', () => {
  if (!currentRecordingData) { 
    alert('⚠️ No recording data. Click Stop first.'); 
    return; 
  }

  const siteName = prompt('📝 Enter site name (e.g., Wecima, EgyDead, YTS):', 'CustomSite');
  if (!siteName) return;

  statusDiv.innerText = `⏳ Generating Python extractor for ${siteName}...`;
  progressFill.style.width = '30%';

  chrome.runtime.sendMessage({ 
    type: "generatePythonExtractor", 
    siteName: siteName,
    data: currentRecordingData 
  }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.code) {
      jsonPreview.value = response.code;
      
      // ═══ FIX: Use proper filename ═══
      const filename = `${siteName.toLowerCase().replace(/[^a-z0-9]/g, '_')}_extractor.py`;
      
      const blob = new Blob([response.code], { type: 'text/x-python' });
      const url = URL.createObjectURL(blob);
      chrome.downloads.download({
        url: url,
        filename: filename,
        saveAs: true
      }, () => {
        URL.revokeObjectURL(url);
      });
      
      statusDiv.innerText = `✅ Python extractor saved as ${filename}`;
    } else {
      statusDiv.innerText = '❌ Failed to generate extractor. Check console.';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
  });
});

// ═══ GENERATE RESOLVER ═══
document.getElementById('genResolver').addEventListener('click', () => {
  if (!currentRecordingData) { 
    alert('⚠️ No recording data. Click Stop first.'); 
    return; 
  }

  const host = prompt('📝 Enter hostname (e.g., streamruby.net, doodstream.com):', '');
  if (!host) return;

  statusDiv.innerText = `⏳ Generating resolver for ${host}...`;
  progressFill.style.width = '30%';

  chrome.runtime.sendMessage({ 
    type: "generateResolver", 
    host: host,
    data: currentRecordingData 
  }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.code) {
      jsonPreview.value = response.code;
      
      // ═══ FIX: Use proper filename ═══
      const safeHost = host.replace(/[^a-zA-Z0-9]/g, '_');
      const filename = `resolve_${safeHost}.py`;
      
      const blob = new Blob([response.code], { type: 'text/x-python' });
      const url = URL.createObjectURL(blob);
      chrome.downloads.download({
        url: url,
        filename: filename,
        saveAs: true
      }, () => {
        URL.revokeObjectURL(url);
      });
      
      statusDiv.innerText = `✅ Resolver saved as ${filename}`;
    } else {
      statusDiv.innerText = '❌ Failed to generate resolver. Check console.';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
  });
});

// ═══ GENERATE COMPLETE EXTRACTOR ═══
document.getElementById('exportFullExtractor').addEventListener('click', () => {
  if (!currentRecordingData) { 
    alert('⚠️ No recording data. Click Stop first.'); 
    return; 
  }

  const siteName = prompt('📝 Enter site name for the complete extractor:', 'CustomSite');
  if (!siteName) return;

  statusDiv.innerText = `⏳ Generating complete extractor for ${siteName}...`;
  progressFill.style.width = '30%';

  chrome.runtime.sendMessage({ 
    type: "generateCompleteExtractor", 
    siteName: siteName,
    data: currentRecordingData 
  }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.content) {
      jsonPreview.value = response.content;
      
      // ═══ FIX: Use proper filename ═══
      const filename = `${siteName.toLowerCase().replace(/[^a-z0-9]/g, '_')}_extractor.py`;
      
      const blob = new Blob([response.content], { type: 'text/x-python' });
      const url = URL.createObjectURL(blob);
      chrome.downloads.download({
        url: url,
        filename: filename,
        saveAs: true
      }, () => {
        URL.revokeObjectURL(url);
      });
      
      statusDiv.innerText = `✅ Complete extractor saved as ${filename}`;
    } else {
      statusDiv.innerText = '❌ Failed to generate extractor. Check console.';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
  });
});

// ═══ DISCOVER API ENDPOINTS ═══
document.getElementById('discoverAPI').addEventListener('click', () => {
  if (!currentRecordingData) { 
    alert('⚠️ No recording data. Click Stop first.'); 
    return; 
  }

  statusDiv.innerText = '🔍 Discovering API endpoints...';
  progressFill.style.width = '30%';

  chrome.runtime.sendMessage({ type: "discoverAPIEndpoints" }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.endpoints) {
      const endpoints = response.endpoints;
      let output = '=== API ENDPOINTS DISCOVERED ===\n\n';
      
      for (const ep of endpoints) {
        output += `[${ep.method}] ${ep.baseUrl}\n`;
        output += `  Status: ${ep.status}\n`;
        output += `  Type: ${ep.contentType}\n`;
        if (ep.samples.length > 0) {
          output += `  Samples:\n`;
          for (const sample of ep.samples.slice(0, 3)) {
            output += `    ${sample.url}\n`;
          }
        }
        output += '\n';
      }
      
      jsonPreview.value = output;
      statusDiv.innerText = `✅ Found ${endpoints.length} API endpoints.`;
    } else {
      statusDiv.innerText = '❌ No API endpoints found.';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
  });
});

// ═══ DISCOVER SITE STRUCTURE ═══
document.getElementById('discoverStructure').addEventListener('click', () => {
  if (!currentRecordingData) { 
    alert('⚠️ No recording data. Click Stop first.'); 
    return; 
  }

  statusDiv.innerText = '📊 Analyzing site structure...';
  progressFill.style.width = '30%';

  chrome.runtime.sendMessage({ type: "discoverSiteStructure" }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.structure) {
      const struct = response.structure;
      let output = '=== SITE STRUCTURE ===\n\n';
      
      output += `Navigation Flow: ${struct.navigationFlow.length} steps\n`;
      for (const nav of struct.navigationFlow.slice(0, 10)) {
        output += `  ${nav.type}: ${nav.from} → ${nav.to}\n`;
      }
      
      output += `\nCategories: ${struct.categories.length}\n`;
      for (const cat of struct.categories.slice(0, 10)) {
        if (cat.title) output += `  - ${cat.title}\n`;
      }
      
      output += `\nItem Selectors: ${struct.itemSelectors.join(', ')}\n`;
      
      jsonPreview.value = output;
      statusDiv.innerText = '✅ Site structure analyzed.';
    } else {
      statusDiv.innerText = '❌ Failed to analyze structure.';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
  });
});

// ═══ DISCOVER QUALITY VARIANTS ═══
document.getElementById('discoverQualities').addEventListener('click', () => {
  if (!currentRecordingData) { 
    alert('⚠️ No recording data. Click Stop first.'); 
    return; 
  }

  statusDiv.innerText = '🎯 Discovering quality variants...';
  progressFill.style.width = '30%';

  chrome.runtime.sendMessage({ type: "discoverQualityVariants" }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.qualities) {
      const q = response.qualities;
      let output = '=== QUALITY VARIANTS ===\n\n';
      output += `Total variants: ${q.variants.length}\n`;
      if (q.bestQuality) {
        output += `Best quality: ${q.bestQuality.quality}\n`;
        output += `  URL: ${q.bestQuality.url}\n`;
      }
      output += '\nQuality map:\n';
      for (const [quality, urls] of Object.entries(q.qualityMap)) {
        output += `  ${quality}: ${urls.length} URLs\n`;
      }
      output += '\nVariants:\n';
      for (const variant of q.variants.slice(0, 20)) {
        output += `  [${variant.quality}] ${variant.url.substring(0, 80)}...\n`;
      }
      jsonPreview.value = output;
      statusDiv.innerText = `✅ Found ${q.variants.length} quality variants.`;
    } else {
      statusDiv.innerText = '❌ No quality variants found.';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
  });
});

// ═══ ANALYZE HLS PLAYLIST ═══
document.getElementById('analyzeHLS').addEventListener('click', () => {
  const url = prompt('📝 Enter HLS playlist URL:', '');
  if (!url) return;

  statusDiv.innerText = '📊 Analyzing HLS playlist...';
  progressFill.style.width = '30%';

  chrome.runtime.sendMessage({ type: "analyzeHLSPlaylist", url: url }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.report) {
      jsonPreview.value = response.report;
      statusDiv.innerText = `✅ HLS analysis complete. Best quality: ${response.bestQuality?.quality || 'Unknown'}`;
    } else {
      statusDiv.innerText = '❌ Failed to analyze HLS playlist.';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
  });
});

// ═══ FIND CHANGES ═══
document.getElementById('findChanges').addEventListener('click', () => {
  if (!currentRecordingData) { 
    alert('⚠️ No recording data. Click Stop first.'); 
    return; 
  }

  statusDiv.innerText = '🔍 Finding request changes...';
  progressFill.style.width = '30%';

  chrome.runtime.sendMessage({ type: "findRequestChanges" }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.report) {
      jsonPreview.value = response.report;
      statusDiv.innerText = `✅ Found ${response.diffs?.length || 0} changed endpoints.`;
    } else {
      statusDiv.innerText = '❌ No changes found.';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
  });
});

// ═══ ANALYZE MAGNET LINKS ═══
document.getElementById('analyzeMagnets').addEventListener('click', () => {
  if (!currentRecordingData) { 
    alert('⚠️ No recording data. Click Stop first.'); 
    return; 
  }

  statusDiv.innerText = '🧲 Analyzing magnet links...';
  progressFill.style.width = '30%';

  chrome.runtime.sendMessage({ type: "analyzeMagnetLinks" }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.magnets) {
      let output = '=== MAGNET LINKS ===\n\n';
      for (const magnet of response.magnets) {
        output += `📌 ${magnet.displayName || 'Unknown'}\n`;
        output += `   Hash: ${magnet.infoHash}\n`;
        output += `   Quality: ${magnet.quality || 'Unknown'}\n`;
        if (magnet.year) output += `   Year: ${magnet.year}\n`;
        if (magnet.trackers.length > 0) {
          output += `   Trackers: ${magnet.trackers.length}\n`;
        }
        output += `   Source: ${magnet.source}\n`;
        output += `   ${magnet.raw}\n\n`;
      }
      jsonPreview.value = output;
      statusDiv.innerText = `✅ Found ${response.magnets.length} magnet links.`;
    } else {
      statusDiv.innerText = '❌ No magnet links found.';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
  });
});

// ═══ MAP SPA ROUTES ═══
document.getElementById('mapSPA').addEventListener('click', () => {
  if (!currentRecordingData) { 
    alert('⚠️ No recording data. Click Stop first.'); 
    return; 
  }

  statusDiv.innerText = '🗺️ Mapping SPA routes...';
  progressFill.style.width = '30%';

  chrome.runtime.sendMessage({ type: "mapSPARoutes" }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.structure) {
      jsonPreview.value = response.structure;
      statusDiv.innerText = `✅ Mapped ${response.routes?.totalRoutes || 0} SPA routes.`;
    } else {
      statusDiv.innerText = '❌ No SPA routes found.';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
  });
});

// ═══ DISCOVER ALL ROUTES ═══
document.getElementById('discoverRoutes').addEventListener('click', () => {
  if (!currentRecordingData) { 
    alert('⚠️ No recording data. Click Stop first.'); 
    return; 
  }

  statusDiv.innerText = '🗺️ Discovering all routes...';
  progressFill.style.width = '30%';

  chrome.runtime.sendMessage({ type: "discoverAllRoutes" }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.report) {
      jsonPreview.value = response.report;
      statusDiv.innerText = `✅ Found ${response.routes?.summary?.totalPages || 0} pages, ${response.routes?.summary?.totalAPI || 0} APIs.`;
    } else {
      statusDiv.innerText = '❌ Failed to discover routes.';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
  });
});

// ═══ DISCOVER SELECTORS ═══
document.getElementById('discoverSelectors').addEventListener('click', () => {
  if (!currentRecordingData) { 
    alert('⚠️ No recording data. Click Stop first.'); 
    return; 
  }

  statusDiv.innerText = '🎯 Discovering selectors...';
  progressFill.style.width = '30%';

  chrome.runtime.sendMessage({ type: "discoverSelectors" }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.report) {
      jsonPreview.value = response.report;
      statusDiv.innerText = `✅ Found ${response.selectors?.itemContainers?.length || 0} container selectors.`;
    } else {
      statusDiv.innerText = '❌ Failed to discover selectors. Try browsing more pages first.';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
  });
});

// ═══ GENERATE SCHEMA ═══
document.getElementById('generateSchema').addEventListener('click', () => {
  if (!currentRecordingData) { 
    alert('⚠️ No recording data. Click Stop first.'); 
    return; 
  }

  statusDiv.innerText = '📋 Generating schema...';
  progressFill.style.width = '30%';

  chrome.runtime.sendMessage({ type: "generateSchema" }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.report) {
      jsonPreview.value = response.report;
      statusDiv.innerText = `✅ Schema generated from ${response.schema ? 'captured data' : 'available data'}.`;
    } else {
      statusDiv.innerText = '❌ Failed to generate schema.';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
  });
});

// ═══ VISUALIZE HLS ═══
document.getElementById('visualizeHLS').addEventListener('click', () => {
  const url = prompt('📝 Enter HLS playlist URL to visualize:', '');
  if (!url) return;

  statusDiv.innerText = '📹 Visualizing HLS playlist...';
  progressFill.style.width = '30%';

  chrome.runtime.sendMessage({ type: "visualizeHLSPlaylist", url: url }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.report) {
      jsonPreview.value = response.report;
      statusDiv.innerText = `✅ HLS visualization complete.`;
    } else {
      statusDiv.innerText = '❌ Failed to visualize HLS.';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
  });
});

// ═══ DEOBFUSCATE JS ═══
document.getElementById('deobfuscateJS').addEventListener('click', () => {
  const code = prompt('📝 Paste obfuscated JavaScript code to deobfuscate:');
  if (!code) return;

  statusDiv.innerText = '🔓 Deobfuscating JavaScript...';
  progressFill.style.width = '30%';

  chrome.runtime.sendMessage({ type: "deobfuscateJavaScript", code: code }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.report) {
      jsonPreview.value = response.report;
      statusDiv.innerText = `✅ Deobfuscation complete.`;
    } else {
      statusDiv.innerText = '❌ Failed to deobfuscate.';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
  });
});

// ═══ ANALYZE COOKIES ═══
document.getElementById('analyzeCookies').addEventListener('click', () => {
  if (!currentRecordingData) { 
    alert('⚠️ No recording data. Click Stop first.'); 
    return; 
  }

  statusDiv.innerText = '🍪 Analyzing cookies...';
  progressFill.style.width = '30%';

  chrome.runtime.sendMessage({ type: "analyzeCookies" }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.report) {
      jsonPreview.value = response.report;
      statusDiv.innerText = `✅ Cookie analysis complete.`;
    } else {
      statusDiv.innerText = '❌ Failed to analyze cookies.';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
  });
});

// ═══ RECORD SEQUENCE ═══
document.getElementById('recordSequence').addEventListener('click', () => {
  if (!currentRecordingData) { 
    alert('⚠️ No recording data. Click Stop first.'); 
    return; 
  }

  statusDiv.innerText = '🔄 Recording request sequence...';
  progressFill.style.width = '30%';

  chrome.runtime.sendMessage({ type: "recordRequestSequence" }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.report) {
      jsonPreview.value = response.report;
      statusDiv.innerText = `✅ Sequence recorded (${response.sequence?.summary?.totalRequests || 0} requests).`;
    } else {
      statusDiv.innerText = '❌ Failed to record sequence.';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
  });
});

// ═══ COMPARE SITES ═══
document.getElementById('compareSites').addEventListener('click', () => {
  if (!currentRecordingData) { 
    alert('⚠️ No recording data. Click Stop first.'); 
    return; 
  }

  const input = prompt('📝 Paste JSON data for Site 2 (or leave empty to compare with current data):');
  let site2Data = null;
  if (input) {
    try {
      site2Data = JSON.parse(input);
    } catch (e) {
      alert('❌ Invalid JSON data.');
      return;
    }
  }

  statusDiv.innerText = '🔀 Comparing sites...';
  progressFill.style.width = '30%';

  chrome.runtime.sendMessage({ 
    type: "compareSites", 
    site1Data: currentRecordingData,
    site2Data: site2Data 
  }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.report) {
      jsonPreview.value = response.report;
      statusDiv.innerText = `✅ Site comparison complete.`;
    } else {
      statusDiv.innerText = '❌ Failed to compare sites.';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
  });
});

// ═══ GENERATE REGEX ═══
document.getElementById('generateRegex').addEventListener('click', () => {
  if (!currentRecordingData) { 
    alert('⚠️ No recording data. Click Stop first.'); 
    return; 
  }

  statusDiv.innerText = '📝 Generating regex patterns...';
  progressFill.style.width = '30%';

  chrome.runtime.sendMessage({ type: "generateRegexPatterns" }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.report) {
      jsonPreview.value = response.report;
      statusDiv.innerText = `✅ Regex patterns generated.`;
    } else {
      statusDiv.innerText = '❌ Failed to generate regex.';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
  });
});

// ═══ TRACK VERSION ═══
document.getElementById('trackVersion').addEventListener('click', () => {
  if (!currentRecordingData) { 
    alert('⚠️ No recording data. Click Stop first.'); 
    return; 
  }

  statusDiv.innerText = '📌 Tracking site version...';
  progressFill.style.width = '30%';

  chrome.runtime.sendMessage({ type: "trackSiteVersion" }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.report) {
      jsonPreview.value = response.report;
      statusDiv.innerText = `✅ Version tracking complete.`;
    } else {
      statusDiv.innerText = '❌ Failed to track version.';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
  });
});

// ═══ GENERATE TESTS ═══
document.getElementById('generateTests').addEventListener('click', () => {
  if (!currentRecordingData) { 
    alert('⚠️ No recording data. Click Stop first.'); 
    return; 
  }

  const siteName = prompt('📝 Enter site name for tests:', 'CustomSite');
  if (!siteName) return;

  statusDiv.innerText = '🧪 Generating tests...';
  progressFill.style.width = '30%';

  chrome.runtime.sendMessage({ 
    type: "generateTests", 
    siteName: siteName,
    data: currentRecordingData 
  }, (response) => {
    progressFill.style.width = '100%';
    if (response && response.status === 'ok' && response.code) {
      jsonPreview.value = response.code;
      
      // ═══ FIX: Use proper filename ═══
      const filename = `test_${siteName.toLowerCase().replace(/[^a-z0-9]/g, '_')}.py`;
      
      const blob = new Blob([response.code], { type: 'text/x-python' });
      const url = URL.createObjectURL(blob);
      chrome.downloads.download({
        url: url,
        filename: filename,
        saveAs: true
      }, () => {
        URL.revokeObjectURL(url);
      });
      
      statusDiv.innerText = `✅ Tests saved as ${filename}`;
    } else {
      statusDiv.innerText = '❌ Failed to generate tests.';
    }
    setTimeout(() => { progressFill.style.width = '0%'; }, 500);
  });
});

// ═══ OPTIONS LINK ═══
optionsLink.onclick = (e) => {
  e.preventDefault();
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  }
  return false;
};

// ═══ MESSAGE HANDLERS ═══
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'challengeStatus') {
    if (message.status === 'solving') {
      challengeStatusDiv.innerText = "🧩 Solving challenge... (check new tab)";
    } else if (message.status === 'solved') {
      challengeStatusDiv.innerText = "✅ Challenge solved!";
      setTimeout(() => { challengeStatusDiv.innerText = ""; }, 5000);
    } else if (message.status === 'failed') {
      challengeStatusDiv.innerText = "❌ Challenge solving failed. Try manual.";
    }
  } else if (message.type === 'ytsDataExtracted') {
    if (message.data && message.data.length > 0) {
      const totalLinks = message.data.reduce((acc, d) => acc + (d.links ? d.links.length : 0), 0);
      statusDiv.innerText = `🎯 YTS data auto-extracted: ${message.data.length} movies, ${totalLinks} links found. Click "YTS" to copy.`;
      window._ytsData = message.data;
    }
  } else if (message.type === 'arabicMoviesExtracted') {
    if (message.data && message.data.length > 0) {
      statusDiv.innerText = `🇸🇦 Arabic movies auto-extracted: ${message.data.length} movies found. Click "WeCima" to copy.`;
      window._arabicData = message.data;
    }
  } else if (message.type === 'saveFilesExtracted') {
    if (message.data && message.data.downloadUrl) {
      statusDiv.innerText = `📦 SaveFiles download auto-extracted: ${message.data.filename || 'file'}`;
      window._saveFilesData = message.data;
    }
  } else if (message.type === 'autoSnapshotToggled') {
    autoSnapshotCheckbox.checked = message.enabled;
    statusDiv.innerText = `📸 Auto-snapshot ${message.enabled ? 'enabled' : 'disabled'}`;
  }
});

// ═══ KEYBOARD SHORTCUT HANDLING ═══
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.key === 'S') {
    e.preventDefault();
    saveSnapshotBtn.click();
  }
  if (e.ctrlKey && e.shiftKey && e.key === 'R') {
    e.preventDefault();
    if (!startBtn.disabled) {
      startBtn.click();
    } else {
      stopBtn.click();
    }
  }
});

// ═══ HELPERS ═══
function escHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(s) {
  return (s || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

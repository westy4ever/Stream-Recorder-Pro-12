// options.js - Options page logic
document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  setupEventListeners();
});

function loadSettings() {
  chrome.storage.sync.get([
    'defaultRecordingMode', 'defaultFilterMode', 'autoSnapshotDefault',
    'maxBodySize', 'maxScreenshots', 'allowedDomains', 'blockedDomains',
    'defaultSiteName', 'includeComments', 'includeTypeHints', 'exportFormat',
    'browserProxy', 'tmdbApiKey', 'torrserverUrl', 'captureDownloadsOnly'
  ], (result) => {
    document.getElementById('defaultRecordingMode').value = result.defaultRecordingMode || 'all';
    document.getElementById('defaultFilterMode').value = result.defaultFilterMode || 'all';
    document.getElementById('autoSnapshotDefault').checked = result.autoSnapshotDefault !== false;
    document.getElementById('maxBodySize').value = result.maxBodySize || 100;
    document.getElementById('maxScreenshots').value = result.maxScreenshots || 20;
    document.getElementById('allowedDomains').value = (result.allowedDomains || []).join(', ');
    document.getElementById('blockedDomains').value = (result.blockedDomains || []).join(', ');
    document.getElementById('defaultSiteName').value = result.defaultSiteName || 'CustomSite';
    document.getElementById('includeComments').checked = result.includeComments !== false;
    document.getElementById('includeTypeHints').checked = result.includeTypeHints !== false;
    document.getElementById('exportFormat').value = result.exportFormat || 'full';
    document.getElementById('browserProxy').value = result.browserProxy || '';
    document.getElementById('tmdbApiKey').value = result.tmdbApiKey || '';
    document.getElementById('torrserverUrl').value = result.torrserverUrl || '';
    document.getElementById('captureDownloadsOnly').checked = result.captureDownloadsOnly !== false;
    
    showStatus('Settings loaded.', 'info');
  });
}

function setupEventListeners() {
  // Save domain filters
  document.getElementById('saveDomainFilters').addEventListener('click', () => {
    const allowed = document.getElementById('allowedDomains').value.split(',').map(s => s.trim()).filter(Boolean);
    const blocked = document.getElementById('blockedDomains').value.split(',').map(s => s.trim()).filter(Boolean);
    
    chrome.storage.sync.set({ allowedDomains: allowed, blockedDomains: blocked }, () => {
      // [FIX] chrome.storage.sync enforces a real per-item quota (8KB) -- a long domain list
      // (plausible here, given this tool's whole purpose is capturing/filtering across many
      // sites) can exceed it, and the set() callback still fires either way. Every save
      // callback in this file previously showed "saved successfully" unconditionally, with no
      // check of chrome.runtime.lastError at all, so a failed save was indistinguishable from
      // a successful one -- the user would believe their filters were saved and only discover
      // otherwise much later. Applied the same check to every storage save/clear call below.
      if (chrome.runtime.lastError) {
        showStatus('❌ Failed to save domain filters: ' + chrome.runtime.lastError.message, 'error');
        return;
      }
      showStatus('✅ Domain filters saved successfully!', 'success');
    });
  });

  document.getElementById('clearDomainFilters').addEventListener('click', () => {
    document.getElementById('allowedDomains').value = '';
    document.getElementById('blockedDomains').value = '';
    chrome.storage.sync.set({ allowedDomains: [], blockedDomains: [] }, () => {
      if (chrome.runtime.lastError) {
        showStatus('❌ Failed to clear domain filters: ' + chrome.runtime.lastError.message, 'error');
        return;
      }
      showStatus('🗑️ Domain filters cleared.', 'info');
    });
  });

  // Save advanced settings
  document.getElementById('saveAdvanced').addEventListener('click', () => {
    const settings = {
      defaultRecordingMode: document.getElementById('defaultRecordingMode').value,
      defaultFilterMode: document.getElementById('defaultFilterMode').value,
      autoSnapshotDefault: document.getElementById('autoSnapshotDefault').checked,
      maxBodySize: parseInt(document.getElementById('maxBodySize').value) || 100,
      maxScreenshots: parseInt(document.getElementById('maxScreenshots').value) || 20,
      defaultSiteName: document.getElementById('defaultSiteName').value || 'CustomSite',
      includeComments: document.getElementById('includeComments').checked,
      includeTypeHints: document.getElementById('includeTypeHints').checked,
      exportFormat: document.getElementById('exportFormat').value,
      browserProxy: document.getElementById('browserProxy').value.trim(),
      tmdbApiKey: document.getElementById('tmdbApiKey').value.trim(),
      torrserverUrl: document.getElementById('torrserverUrl').value.trim(),
      captureDownloadsOnly: document.getElementById('captureDownloadsOnly').checked
    };
    
    chrome.storage.sync.set(settings, () => {
      if (chrome.runtime.lastError) {
        showStatus('❌ Failed to save settings: ' + chrome.runtime.lastError.message, 'error');
        return;
      }
      // Also update the proxy in base.py if browser proxy is set
      if (settings.browserProxy) {
        try {
          chrome.storage.local.set({ browserProxy: settings.browserProxy }, () => {
            if (chrome.runtime.lastError) {
              console.warn('[options] Failed to mirror browserProxy to local storage:', chrome.runtime.lastError.message);
            }
          });
        } catch (e) {}
      }
      
      showStatus('✅ All settings saved successfully!', 'success');
    });
  });

  document.getElementById('resetDefaults').addEventListener('click', () => {
    if (confirm('Reset all settings to default values?')) {
      const defaults = {
        defaultRecordingMode: 'all',
        defaultFilterMode: 'all',
        autoSnapshotDefault: true,
        maxBodySize: 100,
        maxScreenshots: 20,
        allowedDomains: [],
        blockedDomains: [],
        defaultSiteName: 'CustomSite',
        includeComments: true,
        includeTypeHints: true,
        exportFormat: 'full',
        browserProxy: '',
        tmdbApiKey: '',
        torrserverUrl: '',
        captureDownloadsOnly: true
      };
      
      chrome.storage.sync.set(defaults, () => {
        if (chrome.runtime.lastError) {
          showStatus('❌ Failed to reset settings: ' + chrome.runtime.lastError.message, 'error');
          return;
        }
        loadSettings();
        showStatus('🔄 Settings reset to defaults.', 'info');
      });
    }
  });

  // Export data
  document.getElementById('exportAllData').addEventListener('click', () => {
    chrome.storage.local.get(null, (data) => {
      const content = JSON.stringify(data, null, 2);
      const filename = `sr_data_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      // [FIX] uses the fixed downloadBlob() above instead of the
      // duplicated, premature-revoke pattern.
      downloadBlob(content, filename, 'application/json').then((result) => {
        if (result.ok) {
          showStatus('📥 Data exported successfully!', 'success');
        } else {
          showStatus('❌ Export failed: ' + (result.error || 'unknown error'), 'error');
        }
      });
    });
  });

  // Clear all data
  document.getElementById('clearAllData').addEventListener('click', () => {
    if (confirm('⚠️ This will delete ALL captured data. Are you sure?')) {
      chrome.storage.local.clear(() => {
        if (chrome.runtime.lastError) {
          showStatus('❌ Failed to clear local data: ' + chrome.runtime.lastError.message, 'error');
          return;
        }
        chrome.storage.sync.clear(() => {
          if (chrome.runtime.lastError) {
            showStatus('❌ Failed to clear synced settings: ' + chrome.runtime.lastError.message, 'error');
            return;
          }
          showStatus('🗑️ All data cleared.', 'info');
          loadSettings();
        });
      });
    }
  });

  // Export settings
  document.getElementById('exportSettings').addEventListener('click', () => {
    chrome.storage.sync.get(null, (data) => {
      const content = JSON.stringify(data, null, 2);
      const filename = `sr_settings_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      // [FIX] uses the fixed downloadBlob() above instead of the
      // duplicated, premature-revoke pattern.
      downloadBlob(content, filename, 'application/json').then((result) => {
        if (result.ok) {
          showStatus('⚙️ Settings exported!', 'success');
        } else {
          showStatus('❌ Export failed: ' + (result.error || 'unknown error'), 'error');
        }
      });
    });
  });

  // Import settings
  document.getElementById('importSettings').addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const settings = JSON.parse(event.target.result);
          chrome.storage.sync.set(settings, () => {
            if (chrome.runtime.lastError) {
              showStatus('❌ Failed to import settings: ' + chrome.runtime.lastError.message, 'error');
              return;
            }
            loadSettings();
            showStatus('📂 Settings imported successfully!', 'success');
          });
        } catch (err) {
          showStatus('❌ Invalid settings file: ' + err.message, 'error');
        }
      };
      reader.readAsText(file);
    };
    input.click();
  });
}

// [FIX] both downloads in this file originally called URL.revokeObjectURL(url)
// immediately inside chrome.downloads.download()'s own callback -- fixed first
// (wait for onChanged before revoking), then the blob: URL itself was replaced
// with a data: URL after confirming, with a live debug trace, that Brave's own
// "blob partitioning" privacy feature (brave/brave-browser#38256) silently
// corrupted the filename for any blob:-based download before any listener
// code could see the real name. [FIX] confirmed directly, again with real
// device logs: that only fixed it when saveAs is false. With saveAs: true
// (both calls below originally passed true, for a native "Save As" dialog),
// Brave discards the supplied filename entirely and falls back to its own
// generic default ("download.json") -- not even a smarter MIME-based guess --
// regardless of URL scheme. The one pattern proven correct in every device
// log all night is screenshot.js's snapshot download: saveAs: false, filename
// supplied directly. Matching that here -- saveAs is no longer a parameter;
// both exports now save silently and immediately to the default Downloads
// folder, trading the folder-picker dialog for a filename that is correct.
function downloadBlob(content, filename, mimeType) {
  return new Promise((resolve) => {
    const base64 = btoa(unescape(encodeURIComponent(content)));
    const url = `data:${mimeType};base64,${base64}`;
    let settled = false;

    function finish(result) {
      if (settled) return;
      settled = true;
      resolve(result);
    }

    chrome.downloads.download({ url, filename, saveAs: false, conflictAction: "uniquify" }, (downloadId) => {
      if (chrome.runtime.lastError || !downloadId) {
        finish({ ok: false, filename, downloadId: null, error: chrome.runtime.lastError?.message });
        return;
      }
      function onChanged(delta) {
        if (delta.id !== downloadId) return;
        if (delta.state && delta.state.current && delta.state.current !== "in_progress") {
          chrome.downloads.onChanged.removeListener(onChanged);
          const complete = delta.state.current === "complete";
          finish({
            ok: complete, filename, downloadId,
            error: complete ? undefined : (delta.error && delta.error.current) || delta.state.current
          });
        }
      }
      chrome.downloads.onChanged.addListener(onChanged);
      setTimeout(() => {
        if (!settled) {
          chrome.downloads.onChanged.removeListener(onChanged);
          finish({ ok: true, filename, downloadId });
        }
      }, 30000);
    });
  });
}

function showStatus(message, type = 'info') {
  const el = document.getElementById('statusMessage');
  el.textContent = message;
  el.className = 'status';
  if (type === 'success') el.className += ' status-success';
  else if (type === 'error') el.className += ' status-error';
  else el.className += ' status-info';
}

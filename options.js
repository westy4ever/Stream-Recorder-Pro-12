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
      showStatus('✅ Domain filters saved successfully!', 'success');
    });
  });

  document.getElementById('clearDomainFilters').addEventListener('click', () => {
    document.getElementById('allowedDomains').value = '';
    document.getElementById('blockedDomains').value = '';
    chrome.storage.sync.set({ allowedDomains: [], blockedDomains: [] }, () => {
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
      // Also update the proxy in base.py if browser proxy is set
      if (settings.browserProxy) {
        try {
          chrome.storage.local.set({ browserProxy: settings.browserProxy });
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
        loadSettings();
        showStatus('🔄 Settings reset to defaults.', 'info');
      });
    }
  });

  // Export data
  document.getElementById('exportAllData').addEventListener('click', () => {
    chrome.storage.local.get(null, (data) => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      chrome.downloads.download({
        url: url,
        filename: `sr_data_${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
        saveAs: true
      }, () => {
        URL.revokeObjectURL(url);
        showStatus('📥 Data exported successfully!', 'success');
      });
    });
  });

  // Clear all data
  document.getElementById('clearAllData').addEventListener('click', () => {
    if (confirm('⚠️ This will delete ALL captured data. Are you sure?')) {
      chrome.storage.local.clear(() => {
        chrome.storage.sync.clear(() => {
          showStatus('🗑️ All data cleared.', 'info');
          loadSettings();
        });
      });
    }
  });

  // Export settings
  document.getElementById('exportSettings').addEventListener('click', () => {
    chrome.storage.sync.get(null, (data) => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      chrome.downloads.download({
        url: url,
        filename: `sr_settings_${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
        saveAs: true
      }, () => {
        URL.revokeObjectURL(url);
        showStatus('⚙️ Settings exported!', 'success');
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

function showStatus(message, type = 'info') {
  const el = document.getElementById('statusMessage');
  el.textContent = message;
  el.className = 'status';
  if (type === 'success') el.className += ' status-success';
  else if (type === 'error') el.className += ' status-error';
  else el.className += ' status-info';
}
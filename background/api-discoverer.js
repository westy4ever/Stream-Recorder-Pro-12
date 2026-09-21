// api-discoverer.js - API Endpoint Discovery
import { state } from './state.js';

export function discoverAPIEndpoints() {
  const s = state;
  const networkLog = s.networkLog || [];
  const xhrBodies = s.xhrBodies || [];

  const endpoints = [];

  for (const entry of networkLog) {
    try {
      const url = new URL(entry.url);
      
      const isAPI = (
        entry.url.includes('/api/') ||
        entry.url.includes('/ajax/') ||
        entry.url.includes('/wp-json/') ||
        entry.url.includes('/graphql') ||
        entry.url.includes('.json') ||
        entry.url.includes('/v2/') ||
        entry.url.includes('/v3/') ||
        entry.url.includes('/rest/') ||
        entry.url.includes('/service/')
      );

      if (isAPI) {
        const body = xhrBodies.find(b => b.url === entry.url);
        const endpoint = {
          url: entry.url,
          method: entry.method || 'GET',
          status: entry.statusCode || 0,
          contentType: entry.responseHeaders?.['content-type'] || body?.contentType || 'unknown',
          responseSample: body?.body || null,
          isJson: body?.contentType === 'json' || entry.responseHeaders?.['content-type']?.includes('json'),
          timestamp: entry.timestamp || Date.now(),
          requestHeaders: entry.requestHeaders || {},
          responseHeaders: entry.responseHeaders || {},
          params: Object.fromEntries(url.searchParams.entries()),
          pathPattern: url.pathname.replace(/\d+/g, '{id}').replace(/[a-f0-9]{32,}/g, '{hash}')
        };
        endpoints.push(endpoint);
      }
    } catch (e) {}
  }

  const grouped = {};
  for (const endpoint of endpoints) {
    const key = `${endpoint.method}:${endpoint.pathPattern}`;
    if (!grouped[key]) {
      grouped[key] = {
        method: endpoint.method,
        pattern: endpoint.pathPattern,
        baseUrl: endpoint.url.split('?')[0].replace(/\d+/g, '{id}').replace(/[a-f0-9]{32,}/g, '{hash}'),
        status: endpoint.status,
        contentType: endpoint.contentType,
        isJson: endpoint.isJson,
        samples: []
      };
    }
    grouped[key].samples.push({
      url: endpoint.url,
      params: endpoint.params,
      status: endpoint.status,
      timestamp: endpoint.timestamp
    });
  }

  return Object.values(grouped);
}

export function discoverStreamResolvers() {
  const s = state;
  const networkLog = s.networkLog || [];
  const xhrBodies = s.xhrBodies || [];

  const streamUrls = [];
  for (const entry of networkLog) {
    if (entry.url && (
      entry.url.includes('.m3u8') ||
      entry.url.includes('.mp4') ||
      entry.url.includes('master.m3u8') ||
      entry.url.includes('playlist.m3u8')
    )) {
      streamUrls.push({
        url: entry.url,
        referer: entry.referer || entry.initiator || '',
        status: entry.statusCode || 0,
        responseHeaders: entry.responseHeaders || {}
      });
    }
  }

  for (const body of xhrBodies) {
    if (body.body && (
      body.body.includes('.m3u8') ||
      body.body.includes('.mp4') ||
      body.body.includes('master.m3u8')
    )) {
      const matches = body.body.match(/https?:\/\/[^\s"']+\.(?:m3u8|mp4)[^\s"']*/g) || [];
      for (const url of matches) {
        streamUrls.push({
          url: url,
          referer: body.url || '',
          sourceBody: body.url,
          status: body.status || 0
        });
      }
    }
  }

  const byHost = {};
  for (const stream of streamUrls) {
    try {
      const host = new URL(stream.url).hostname;
      if (!byHost[host]) {
        byHost[host] = {
          host: host,
          urls: [],
          referers: new Set(),
          patterns: new Set()
        };
      }
      byHost[host].urls.push(stream.url);
      if (stream.referer) byHost[host].referers.add(stream.referer);
      byHost[host].patterns.add(stream.url.replace(/\d+/g, '{id}').replace(/[a-f0-9]{32,}/g, '{hash}'));
    } catch (e) {}
  }

  return Object.values(byHost);
}

export function discoverSiteStructure() {
  const s = state;
  const actions = s.actions || [];
  const contentPipeline = s.contentPipeline || {};

  const structure = {
    routes: [],
    categories: [],
    itemSelectors: [],
    navigationFlow: []
  };

  const navActions = actions.filter(a => 
    a.type === 'click' || a.type === 'navigate' || a.type === 'spa_navigate'
  );

  for (const action of navActions) {
    structure.navigationFlow.push({
      from: action.url,
      to: action.href || action.url,
      type: action.type,
      selector: action.selector,
      timestamp: action.timestamp
    });
  }

  if (contentPipeline.source === 'wecima' || contentPipeline.source === 'yts') {
    structure.categories = contentPipeline.movieList || [];
  }

  if (contentPipeline.movieList && contentPipeline.movieList.length > 0) {
    const sample = contentPipeline.movieList[0];
    structure.itemSelectors = Object.keys(sample);
  }

  return structure;
}
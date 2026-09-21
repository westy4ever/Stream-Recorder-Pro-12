// route-discoverer.js - Complete Site Route Discovery
import { state } from './state.js';

export function discoverAllRoutes() {
  const s = state;
  const networkLog = s.networkLog || [];
  const actions = s.actions || [];
  const xhrBodies = s.xhrBodies || [];

  const routes = {
    pages: [],
    apiEndpoints: [],
    dynamicRoutes: [],
    staticRoutes: [],
    routeTree: null,
    summary: {}
  };

  // Extract all unique paths from network logs
  const pathMap = new Map();
  for (const entry of networkLog) {
    try {
      const url = new URL(entry.url);
      const path = url.pathname;
      const method = entry.method || 'GET';
      const key = `${method}:${path}`;
      
      if (!pathMap.has(key)) {
        pathMap.set(key, {
          path: path,
          method: method,
          fullUrl: entry.url,
          params: Object.fromEntries(url.searchParams.entries()),
          status: entry.statusCode || 0,
          contentType: entry.responseHeaders?.['content-type'] || 'unknown',
          count: 1,
          timestamps: [entry.timestamp || Date.now()]
        });
      } else {
        const existing = pathMap.get(key);
        existing.count++;
        existing.timestamps.push(entry.timestamp || Date.now());
      }
    } catch (e) {}
  }

  // Extract routes from actions (SPA navigation)
  const navActions = actions.filter(a => 
    a.type === 'spa_navigate' || a.type === 'navigate'
  );
  
  for (const action of navActions) {
    try {
      const url = new URL(action.url || '');
      const path = url.pathname;
      const key = `SPA:${path}`;
      
      if (!pathMap.has(key)) {
        pathMap.set(key, {
          path: path,
          method: 'SPA',
          fullUrl: action.url,
          params: Object.fromEntries(url.searchParams.entries()),
          status: 200,
          contentType: 'html',
          count: 1,
          timestamps: [action.timestamp || Date.now()],
          isSPA: true,
          selector: action.selector
        });
      }
    } catch (e) {}
  }

  // Categorize routes
  for (const [key, route] of pathMap) {
    const isDynamic = route.path.match(/\d+/) || route.path.match(/[a-f0-9]{32,}/);
    const isAPI = route.path.includes('/api/') || route.path.includes('/ajax/') || 
                  route.path.includes('/wp-json/') || route.path.includes('/graphql');
    const isStatic = route.path.match(/\.(css|js|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot)$/);
    
    if (isAPI) {
      routes.apiEndpoints.push(route);
    } else if (isStatic) {
      routes.staticRoutes.push(route);
    } else if (isDynamic) {
      routes.dynamicRoutes.push(route);
    } else {
      routes.pages.push(route);
    }
  }

  // Build route tree
  routes.routeTree = buildRouteTreeFromPaths(routes.pages);

  // Generate summary
  routes.summary = {
    totalPages: routes.pages.length,
    totalAPI: routes.apiEndpoints.length,
    totalDynamic: routes.dynamicRoutes.length,
    totalStatic: routes.staticRoutes.length,
    totalSPA: navActions.length
  };

  return routes;
}

function buildRouteTreeFromPaths(paths) {
  const tree = {};
  
  for (const route of paths) {
    const parts = route.path.split('/').filter(p => p);
    let current = tree;
    
    for (const part of parts) {
      if (!current[part]) {
        current[part] = {};
      }
      current = current[part];
    }
    
    current['__route'] = {
      method: route.method,
      url: route.fullUrl,
      status: route.status,
      count: route.count
    };
  }
  
  return tree;
}

export function generateRouteReport() {
  const routes = discoverAllRoutes();
  
  let report = '=== COMPLETE SITE ROUTE DISCOVERY ===\n\n';
  
  report += `📊 SUMMARY:\n`;
  report += `  Pages: ${routes.summary.totalPages}\n`;
  report += `  API Endpoints: ${routes.summary.totalAPI}\n`;
  report += `  Dynamic Routes: ${routes.summary.totalDynamic}\n`;
  report += `  Static Assets: ${routes.summary.totalStatic}\n`;
  report += `  SPA Routes: ${routes.summary.totalSPA}\n\n`;
  
  report += '=== ROUTE TREE ===\n';
  report += formatRouteTree(routes.routeTree);
  
  report += '\n=== API ENDPOINTS ===\n';
  for (const api of routes.apiEndpoints) {
    report += `  [${api.method}] ${api.path}\n`;
    if (Object.keys(api.params).length > 0) {
      report += `    Params: ${JSON.stringify(api.params)}\n`;
    }
    report += `    Status: ${api.status}\n`;
    report += `    Count: ${api.count}\n`;
  }
  
  report += '\n=== DYNAMIC ROUTES ===\n';
  for (const route of routes.dynamicRoutes) {
    report += `  [${route.method}] ${route.path}\n`;
    report += `    Count: ${route.count}\n`;
  }
  
  return report;
}

function formatRouteTree(tree, depth = 0) {
  let output = '';
  const indent = '  '.repeat(depth);
  
  for (const [key, value] of Object.entries(tree)) {
    if (key === '__route') {
      output += `${indent}📍 ${value.method} ${value.url}\n`;
      continue;
    }
    output += `${indent}📁 ${key}/\n`;
    if (typeof value === 'object') {
      output += formatRouteTree(value, depth + 1);
    }
  }
  
  return output;
}
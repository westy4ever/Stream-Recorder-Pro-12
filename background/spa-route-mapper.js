// spa-route-mapper.js - SPA Route Map
import { state } from './state.js';

export function mapSPARoutes() {
  const s = state;
  const actions = s.actions || [];
  const networkLog = s.networkLog || [];

  const routes = [];
  const seen = new Set();

  const navActions = actions.filter(a => 
    a.type === 'spa_navigate' || a.type === 'navigate' || a.type === 'click'
  );

  for (const action of navActions) {
    try {
      const url = new URL(action.url || action.href || '');
      const path = url.pathname;
      const route = {
        path: path,
        fullUrl: action.url || action.href,
        type: action.type,
        selector: action.selector || 'auto',
        pageState: action.pageState || {},
        data: action.data || {},
        timestamp: action.timestamp || Date.now()
      };

      const paramMatch = path.match(/\/([^\/]+)\/(\d+)/);
      if (paramMatch) {
        route.routeType = 'detail';
        route.routeKey = paramMatch[1];
        route.routeId = paramMatch[2];
      } else if (path.includes('/category/') || path.includes('/genre/')) {
        route.routeType = 'category';
      } else if (path.includes('/search')) {
        route.routeType = 'search';
      } else if (path === '/' || path === '') {
        route.routeType = 'home';
      } else {
        route.routeType = 'page';
      }

      const routeKey = route.path;
      if (!seen.has(routeKey)) {
        seen.add(routeKey);
        routes.push(route);
      }
    } catch (e) {}
  }

  const routeTree = buildRouteTree(routes);
  
  return {
    routes: routes,
    routeTree: routeTree,
    totalRoutes: routes.length,
    routeTypes: {
      home: routes.filter(r => r.routeType === 'home').length,
      category: routes.filter(r => r.routeType === 'category').length,
      detail: routes.filter(r => r.routeType === 'detail').length,
      search: routes.filter(r => r.routeType === 'search').length,
      page: routes.filter(r => r.routeType === 'page').length
    }
  };
}

function buildRouteTree(routes) {
  const tree = {};
  
  for (const route of routes) {
    const parts = route.path.split('/').filter(p => p);
    let current = tree;
    
    for (const part of parts) {
      if (!current[part]) {
        current[part] = {};
      }
      current = current[part];
    }
    
    current['__route'] = {
      type: route.routeType,
      url: route.fullUrl,
      selector: route.selector
    };
  }
  
  return tree;
}

export function generateSPAStructure() {
  const structure = mapSPARoutes();
  
  let output = '=== SPA ROUTE MAP ===\n\n';
  
  output += `Total Routes: ${structure.totalRoutes}\n`;
  output += `  - Home: ${structure.routeTypes.home}\n`;
  output += `  - Categories: ${structure.routeTypes.category}\n`;
  output += `  - Detail Pages: ${structure.routeTypes.detail}\n`;
  output += `  - Search: ${structure.routeTypes.search}\n`;
  output += `  - Pages: ${structure.routeTypes.page}\n\n`;
  
  output += '=== ROUTE TREE ===\n';
  output += formatRouteTree(structure.routeTree, 0);
  
  output += '\n\n=== ROUTE DETAILS ===\n';
  for (const route of structure.routes.slice(0, 20)) {
    output += `[${route.routeType}] ${route.path}\n`;
    if (route.selector) {
      output += `  Selector: ${route.selector}\n`;
    }
    if (route.pageState && Object.keys(route.pageState).length > 0) {
      output += `  State: ${JSON.stringify(route.pageState, null, 2).substring(0, 200)}...\n`;
    }
    output += '\n';
  }
  
  return output;
}

function formatRouteTree(tree, depth) {
  let output = '';
  const indent = '  '.repeat(depth);
  
  for (const [key, value] of Object.entries(tree)) {
    if (key === '__route') {
      output += `${indent}📍 ${value.type}: ${value.url}\n`;
      continue;
    }
    output += `${indent}📁 ${key}/\n`;
    if (typeof value === 'object') {
      output += formatRouteTree(value, depth + 1);
    }
  }
  
  return output;
}
/* Shared by the service worker, content script, popup, and Node tests. */
(function (root) {
  'use strict';
  const ROUTES = Object.freeze({
    cdk: { label: 'CDK', folder: 'OneDrive-CDKGlobalLLC/transcript' },
    tao: { label: 'Tao Digital Solutions', folder: 'OneDrive-TaoDigitalSolutionsInc/transcript' },
  });
  const validRoute = value => Object.hasOwn(ROUTES, value);
  function routeForTenant(tenant) {
    const domain = String(tenant || '').trim().toLowerCase().split('@').pop();
    const domains = { 'cdk.com': 'cdk', 'taodigitalsolutions.com': 'tao' };
    return Object.hasOwn(domains, domain) ? domains[domain] : null;
  }
  function resolveRoute(selection, tenant) {
    return validRoute(selection) ? selection : routeForTenant(tenant);
  }
  function pendingKey(pending) { return `ttc_pending:${pending.id}`; }
  function pendingItems(storage) {
    const items = Object.entries(storage).filter(([key, p]) => key.startsWith('ttc_pending:') && p?.name && p?.id).map(([, p]) => p);
    const legacy = storage.ttc_pending;
    if (legacy?.name && !items.some(p => p.name === legacy.name && p.savedAt === legacy.savedAt && p.tenantKey === legacy.tenantKey)) {
      items.push({ ...legacy, id: legacy.id || `legacy-${legacy.savedAt || 0}-${legacy.tenantKey || 'default'}-${legacy.name}` });
    }
    return items.sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0));
  }
  const api = { ROUTES, validRoute, routeForTenant, resolveRoute, pendingKey, pendingItems };
  root.TtcRouting = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);

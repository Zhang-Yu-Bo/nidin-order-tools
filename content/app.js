/**
 * Nidin SPA 路由生命週期與啟動入口。
 */
(() => {
  "use strict";

  const root = globalThis.NidinOrderTools;
  const { CONFIG, currentRoute, routeKey } = root.core;
  const { showOrderNotice, initOrderPage } = root.pageUi;
  const { initMenuPage } = root.menuWorkflow;
  delete globalThis.NidinOrderTools;

  // ── Nidin SPA 路由生命週期 ──────────────────────────────────────

  let activeRouteKey = null;
  let activeRouteGeneration = 0;
  let activeRouteCleanup = null;
  let routeSyncQueued = false;

  function routeIsActive(expectedRouteKey, generation) {
    return (
      generation === activeRouteGeneration &&
      expectedRouteKey === activeRouteKey &&
      routeKey() === expectedRouteKey
    );
  }

  function registerRouteCleanup(generation, cleanup) {
    if (generation !== activeRouteGeneration) {
      cleanup();
      return;
    }
    activeRouteCleanup = cleanup;
  }

  async function bootstrap(route, expectedRouteKey, generation) {
    const lifecycle = { routeIsActive, registerRouteCleanup };
    if (route.kind === "order") {
      await initOrderPage(expectedRouteKey, generation, lifecycle);
    } else if (route.kind === "menu") {
      await initMenuPage(expectedRouteKey, generation, lifecycle);
    }
  }

  function syncRoute() {
    const route = currentRoute();
    const nextRouteKey = routeKey(route);
    if (nextRouteKey === activeRouteKey) return;

    activeRouteCleanup?.();
    activeRouteCleanup = null;
    activeRouteKey = nextRouteKey;
    const generation = ++activeRouteGeneration;
    document.getElementById(CONFIG.hostId)?.remove();

    void bootstrap(route, nextRouteKey, generation).catch((error) => {
      if (
        route.kind === "order" &&
        routeIsActive(nextRouteKey, generation)
      ) {
        showOrderNotice(`工具啟動失敗：${error.message}`);
      }
    });
  }

  function scheduleRouteSync() {
    if (routeKey() === activeRouteKey || routeSyncQueued) return;
    routeSyncQueued = true;
    queueMicrotask(() => {
      routeSyncQueued = false;
      syncRoute();
    });
  }

  const routeObserver = new MutationObserver(scheduleRouteSync);
  routeObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  addEventListener("popstate", scheduleRouteSync);
  addEventListener("hashchange", scheduleRouteSync);
  syncRoute();
})();

/*
 * MV3 service worker. Ephemeral. The heavy work (extraction, tax math, badge
 * injection) lives in the content script; this worker only seeds a default
 * region on install. Tariff tables ship baked in as core/tariffs.json and are
 * fetched by the content script; a future version can refresh them here on a
 * schedule from a Proxem-controlled endpoint (data only, never remote code).
 */
chrome.runtime.onInstalled.addListener(function () {
  chrome.storage.sync.get({ region: null }, function (cfg) {
    if (!cfg || !cfg.region) chrome.storage.sync.set({ region: "flanders" });
  });
});

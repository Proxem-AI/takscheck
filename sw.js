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

/*
 * Ruby toolbar match dot (Iris QA D2). The content script messages us on every
 * run with whether a car ad is present on its tab. When one is, we paint the
 * action badge ruby (#841922) with a blank label, so the toolbar icon shows the
 * page is supported; we clear it otherwise. Per-tab, so unrelated tabs stay
 * clean. The popup reads this state back via chrome.action.getBadgeText, which
 * the browser persists per tab even if this worker is evicted.
 */
chrome.runtime.onMessage.addListener(function (msg, sender) {
  if (!msg || msg.type !== "takscheck:match") return;
  var tabId = sender && sender.tab && sender.tab.id;
  if (tabId == null) return;
  if (msg.matched) {
    chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: "#841922" });
    chrome.action.setBadgeText({ tabId: tabId, text: " " });
  } else {
    chrome.action.setBadgeText({ tabId: tabId, text: "" });
  }
});

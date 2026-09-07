/*
 * MV3 service worker. Ephemeral. The heavy work (extraction, tax math, badge
 * injection) lives in the content script; this worker only seeds a default
 * region on install.
 *
 * Tariff tables ship baked in as core/tariffs.json and are read from the
 * extension package by the content script. There is NO remote refresh today and
 * no network call of any kind anywhere in this extension. That is what makes the
 * published privacy policy able to say the extension transmits nothing.
 *
 * IF YOU ADD THE SCHEDULED TARIFF REFRESH, READ THIS FIRST.
 * A refresh from a Proxem-controlled endpoint (data only, never remote code, per
 * MV3) is the right fix for tariff drift and is not discouraged. But it changes
 * Proxem AI's legal position, and the change is not optional to handle:
 *   1. Every install begins contacting a Proxem server, which necessarily
 *      receives an IP address and an install-level request pattern. Proxem AI
 *      becomes a GDPR controller of personal data, having been controller of
 *      none.
 *   2. The published privacy policy states the extension transmits nothing. That
 *      sentence becomes false on the day this ships. The policy carries a
 *      forward commitment that it will be updated BEFORE any such version is
 *      released. Meet it in the same pull request, not afterwards.
 *   3. The Chrome Web Store data usage declaration must be updated in step, and
 *      it must stay true. An inaccurate declaration is a store policy breach.
 * Two ways to keep the current position instead: serve the tariff file as a
 * static asset from a CDN with logging disabled, or ship rate updates as
 * ordinary extension version updates, which the store already distributes
 * without telling us anything about anyone.
 */
// storage.local, not storage.sync. The two keys here (region, lang) are small
// enough that sync would have worked, but sync replicates them through the
// user's Google account, which means data leaves the device. The whole claim
// this extension makes is that nothing does. Carrying a region choice between a
// user's machines is not worth qualifying that sentence. See README, Privacy.
chrome.runtime.onInstalled.addListener(function () {
  chrome.storage.local.get({ region: null }, function (cfg) {
    if (!cfg || !cfg.region) chrome.storage.local.set({ region: "flanders" });
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

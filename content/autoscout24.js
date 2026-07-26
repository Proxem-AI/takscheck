/*
 * AutoScout24 detail-page content script.
 * Parses __NEXT_DATA__ (props.pageProps.listingDetails), normalises the
 * vehicle, runs the tax engine for the user's region, and injects the badges.
 * Handles Next.js SPA navigation so a client-side route change re-runs.
 */
(function () {
  "use strict";

  var Tax = globalThis.BelgianCarTax;
  var Normalise = globalThis.BivNormalise;
  var Badge = globalThis.BivBadge;
  var tariffsPromise = null;

  function loadTariffs() {
    if (!tariffsPromise) {
      tariffsPromise = fetch(chrome.runtime.getURL("core/tariffs.json")).then(function (r) { return r.json(); });
    }
    return tariffsPromise;
  }

  function getRegion() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.sync.get({ region: "flanders" }, function (cfg) {
          resolve((cfg && cfg.region) || "flanders");
        });
      } catch (e) { resolve("flanders"); }
    });
  }

  // Read and parse the Next.js data blob.
  function readNextData() {
    var el = document.getElementById("__NEXT_DATA__");
    if (!el) return null;
    try { return JSON.parse(el.textContent); } catch (e) { return null; }
  }

  // Walk to listingDetails, with fallbacks.
  function findListingDetails(nextData) {
    if (!nextData) return null;
    var pp = nextData.props && nextData.props.pageProps;
    if (pp) {
      if (pp.listingDetails) return pp.listingDetails;
      if (pp.listing) return pp.listing;
    }
    // last resort: deep search for a node that looks like a detail object
    return Normalise.deepFind ? null : null;
  }

  function isDetailPage() {
    // AutoScout24 detail URLs contain /angebote/ (.de) or /aanbod/ /offre/ (.be), typically with an id.
    return /\/(angebote|aanbod|offre|offer|offers)\//i.test(location.pathname) ||
           (document.getElementById("__NEXT_DATA__") != null && /\-\d{5,}/.test(location.pathname));
  }

  var lastUrl = null;

  function run() {
    if (location.href === lastUrl) return;
    var nextData = readNextData();
    var details = findListingDetails(nextData);
    if (!details) { Badge.remove(); lastUrl = location.href; return; }

    var vehicle = Normalise.fromAutoScout24(details);
    if (!vehicle) { Badge.remove(); lastUrl = location.href; return; }
    lastUrl = location.href;

    Promise.all([loadTariffs(), getRegion()]).then(function (arr) {
      var tariffs = arr[0], region = arr[1];
      try {
        var engine = Tax.createTaxEngine(tariffs);
        var all = engine.computeAll(vehicle, region);
        Badge.render(all, vehicle, region);
        // eslint-disable-next-line no-console
        console.debug("[BIV+Rijtaks]", region, vehicle, all);
      } catch (e) {
        console.warn("[BIV+Rijtaks] compute failed", e);
      }
    });
  }

  function debounce(fn, ms) {
    var t = null;
    return function () { clearTimeout(t); t = setTimeout(fn, ms); };
  }
  var scheduled = debounce(run, 250);

  // Initial run.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scheduled);
  } else {
    scheduled();
  }

  // React to Next.js SPA route changes.
  ["pushState", "replaceState"].forEach(function (m) {
    var orig = history[m];
    history[m] = function () {
      var r = orig.apply(this, arguments);
      window.dispatchEvent(new Event("biv:locationchange"));
      return r;
    };
  });
  window.addEventListener("popstate", function () { window.dispatchEvent(new Event("biv:locationchange")); });
  window.addEventListener("biv:locationchange", function () { lastUrl = null; scheduled(); });

  // Catch late hydration where __NEXT_DATA__ is present but details fill in.
  var obs = new MutationObserver(debounce(function () {
    if (location.href !== lastUrl) scheduled();
  }, 400));
  obs.observe(document.documentElement, { childList: true, subtree: true });
})();

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

  // Tell the service worker whether a car ad is present on this tab, so it can
  // paint the ruby toolbar match dot and the popup can read the status. Fire and
  // forget; the SW handles missing tab ids and eviction.
  function notifyMatch(matched) {
    try { chrome.runtime.sendMessage({ type: "takscheck:match", matched: !!matched }); } catch (e) {}
  }

  function loadTariffs() {
    if (!tariffsPromise) {
      tariffsPromise = fetch(chrome.runtime.getURL("core/tariffs.json")).then(function (r) { return r.json(); });
    }
    return tariffsPromise;
  }

  function getRegion() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get({ region: "flanders" }, function (cfg) {
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

  // DOM fallback: read the CO2 spec row ("CO2-emissie" / "CO2-uitstoot" /
  // "CO2-Emission") when __NEXT_DATA__ carried no usable g/km figure. Only used
  // for combustion / hybrid cars; a value is filled in only when it is missing.
  function readCo2FromSpecs() {
    var labelRe = /co(?:2|₂)[\s.\-]*(emissie|uitstoot|emission|ausstoss|combined)/i;
    var els = document.querySelectorAll("dt, th, td, span, div, li, p");
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var txt = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!txt || txt.length > 60) continue;
      if (!labelRe.test(txt)) continue;
      var c = Normalise.co2FromText(txt);
      if (c == null) {
        var sib = el.nextElementSibling;
        if (sib) c = Normalise.co2FromText((sib.textContent || "").trim());
      }
      if (c != null && c > 0) return c;
    }
    return null;
  }

  var lastUrl = null;

  function run() {
    if (location.href === lastUrl) return;
    // The content script has read permission across all AutoScout24 pages, but a
    // badge is only injected on a DETAIL page. The reliable detail-page signal is
    // the presence of listingDetails in __NEXT_DATA__ (search/list pages carry
    // pageProps.listings instead, and get no badge). This is more robust than
    // matching localized URL path segments (/angebote/, /aanbod/, /offre/, ...).
    var nextData = readNextData();
    var details = findListingDetails(nextData);
    if (!details) { Badge.remove(); notifyMatch(false); lastUrl = location.href; return; }

    var vehicle = Normalise.fromAutoScout24(details);
    if (!vehicle) { Badge.remove(); notifyMatch(false); lastUrl = location.href; return; }
    // CO2 missing from the data blob but a combustion/hybrid car: read it from the
    // rendered spec row so the engine never falls back to the EV exemption branch.
    if ((vehicle.co2 == null || vehicle.co2 <= 0) && vehicle.fuel !== "electric" && vehicle.fuel !== "hydrogen") {
      var domCo2 = readCo2FromSpecs();
      if (domCo2 != null && domCo2 > 0) vehicle.co2 = domCo2;
    }
    lastUrl = location.href;

    Promise.all([loadTariffs(), getRegion()]).then(function (arr) {
      var tariffs = arr[0], region = arr[1];
      try {
        var engine = Tax.createTaxEngine(tariffs);
        var all = engine.computeAll(vehicle, region);
        Badge.render(all, vehicle, region);
        notifyMatch(true);
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

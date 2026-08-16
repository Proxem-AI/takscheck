/*
 * mobile.de detail-page content script.
 * Reads the page (JSON-LD schema.org Car first, labelled Technische Daten table
 * as fallback), then feeds the SAME shared pipeline as AutoScout24:
 *   BivNormalise.fromMobileDe -> BelgianCarTax engine -> BivBadge.render.
 * Only the extraction here is site-specific; normalisation, tax math and the
 * badge are shared and not duplicated.
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
        chrome.storage.sync.get({ region: "flanders" }, function (cfg) {
          resolve((cfg && cfg.region) || "flanders");
        });
      } catch (e) { resolve("flanders"); }
    });
  }

  // Collect schema.org Car/Vehicle/Product JSON-LD blocks. Returns the actual
  // vehicle node (or null). A block may carry an @graph whose entries are mostly
  // non-vehicle (Organization, BreadcrumbList): we must NOT return that wrapper
  // just because it has an @graph, we must dig for the real vehicle node.
  function isVehicleNode(o) {
    if (!o || typeof o !== "object") return false;
    var type = String(o["@type"] || "");
    return /car|vehicle|product/i.test(type) || !!o.vehicleEngine || !!o.dateVehicleFirstRegistered;
  }
  function readJsonLd() {
    var nodes = document.querySelectorAll('script[type="application/ld+json"]');
    for (var i = 0; i < nodes.length; i++) {
      var data;
      try { data = JSON.parse(nodes[i].textContent); } catch (e) { continue; }
      var arr = Array.isArray(data) ? data : [data];
      for (var k = 0; k < arr.length; k++) {
        var o = arr[k];
        if (!o || typeof o !== "object") continue;
        if (isVehicleNode(o)) return o;
        if (o["@graph"] && Array.isArray(o["@graph"])) {
          for (var g = 0; g < o["@graph"].length; g++) {
            if (isVehicleNode(o["@graph"][g])) return o["@graph"][g];
          }
        }
      }
    }
    return null;
  }

  // Build a { canonicalLabel: valueString } map from the labelled Technische Daten.
  // German labels are stable; class names are not. The real labels carry suffixes
  // and footnotes ("CO₂-Emissionen (kombiniert)*", "Kraftstoffart") so matching is
  // by stem, not exact string, and every hit is stored under the canonical key that
  // BivNormalise.fromMobileDe looks up.
  // mobile.de serves the same detail page in the user's chosen UI language, so the
  // spec labels arrive in German OR English (or another locale). Each stem matches
  // both spellings and stores the hit under the same canonical key, so the
  // normaliser downstream stays language agnostic.
  var LABEL_STEMS = [
    { key: "erstzulassung", re: /^(erstzulassung|first registration|first reg)/ },
    { key: "kraftstoffart", re: /^(kraftstoff|fuel)/ },
    { key: "leistung", re: /^(leistung|power)/ },
    { key: "hubraum", re: /^(hubraum|cubic capacity|displacement|engine size)/ },
    { key: "co2-emissionen", re: /^co[\s.₂2-]*emission/ },
    { key: "schadstoffklasse", re: /^schadstoffklasse/ },
    { key: "emissionsklasse", re: /^(emissionsklasse|emission class|emission standard)/ },
    { key: "zul. gesamtgewicht", re: /^(zul.*gesamtgewicht|gross.*weight|permissible.*weight)/ },
    { key: "gesamtgewicht", re: /^gesamtgewicht/ },
    { key: "leergewicht", re: /^(leergewicht|kerb.*weight|curb.*weight|unladen)/ },
    { key: "preis", re: /^(preis|price)/ }
  ];
  function norm(s) { return (s || "").replace(/\s+/g, " ").trim().toLowerCase().replace(/:$/, ""); }
  function canonLabel(raw) {
    var k = norm(raw).replace(/[*†‡\s]+$/, "").trim();
    if (!k || k.length > 48) return null;
    for (var i = 0; i < LABEL_STEMS.length; i++) if (LABEL_STEMS[i].re.test(k)) return LABEL_STEMS[i].key;
    return null;
  }
  function cleanVal(s) { return (s || "").replace(/\s+/g, " ").trim(); }

  // Case-insensitive copies of the label stems, matched against the ORIGINAL text
  // (not lowercased), so we can strip the leading label off an inline "label value"
  // string and keep the value in its real casing.
  var STEM_CI = {};
  for (var _si = 0; _si < LABEL_STEMS.length; _si++) {
    STEM_CI[LABEL_STEMS[_si].key] = new RegExp(LABEL_STEMS[_si].re.source, "i");
  }
  // Given an element's text and the canonical key it matched, return the value that
  // follows the label inline ("Leistung: 140 kW" -> "140 kW", "First registration
  // 05/2020" -> "05/2020"). Returns "" when the text is label-only or has no tail.
  function valueAfterLabel(rawText, canon) {
    var s = cleanVal(rawText);
    // Preferred: an explicit "Label: value" colon separator ("Leistung: 140 kW",
    // "Kraftstoffart: Diesel"). Take everything after the first colon.
    var ci = s.indexOf(":");
    if (ci > -1) {
      var afterColon = s.slice(ci + 1).trim();
      return afterColon.length && afterColon.length <= 64 ? afterColon : "";
    }
    // No colon: only accept when the label is a whole word immediately followed by
    // whitespace and then a digit ("First registration 05/2020", "Leistung 140 kW").
    // This deliberately rejects partial-word stem matches (e.g. "CO2-Emissionen",
    // where the stem matches "CO2-Emission" and the trailing "en" is not a value).
    var re = STEM_CI[canon];
    if (!re) return "";
    var m = s.match(re);
    if (!m) return "";
    var next = s.charAt(m.index + m[0].length);
    if (next !== "" && !/\s/.test(next)) return "";
    var rest = s.slice(m.index + m[0].length).trim();
    if (!/^\d/.test(rest)) return "";
    return rest.length && rest.length <= 64 ? rest : "";
  }

  function readTechData() {
    var map = {};
    function put(canon, val) {
      val = cleanVal(val);
      if (canon && val && map[canon] == null) map[canon] = val;
    }
    // dl / dt-dd
    var dts = document.querySelectorAll("dt");
    for (var i = 0; i < dts.length; i++) {
      var dd = dts[i].nextElementSibling;
      if (dd && dd.tagName === "DD") put(canonLabel(dts[i].textContent), dd.textContent);
    }
    // table rows (th/td or two tds)
    var rows = document.querySelectorAll("tr");
    for (var r = 0; r < rows.length; r++) {
      var cells = rows[r].children;
      if (cells.length >= 2) put(canonLabel(cells[0].textContent), cells[1].textContent);
    }
    // generic label -> value: a leaf element whose text is a known label, value in
    // the next sibling. Covers mobile.de's div-pair spec layout with hashed class
    // names. No element-count cap: the spec block can sit late in the document.
    var all = document.querySelectorAll("div, span, p, li, th, td, dt");
    for (var a = 0; a < all.length; a++) {
      var el = all[a];
      if (el.children.length) continue;
      var canon = canonLabel(el.textContent);
      if (!canon || map[canon] != null) continue;
      // (1) value inline in the SAME element after the label ("Leistung: 140 kW").
      var inlineV = valueAfterLabel(el.textContent, canon);
      if (inlineV) put(canon, inlineV);
      // (2) value in the next sibling element.
      var sib = el.nextElementSibling;
      if (map[canon] == null && sib) put(canon, sib.textContent);
      // (3) label and value split across two wrapper divs (label is the sole child):
      // take the label wrapper's next sibling.
      if (map[canon] == null && el.parentElement && el.parentElement.children.length === 1) {
        var pv = el.parentElement.nextElementSibling;
        if (pv && cleanVal(pv.textContent).length <= 64) put(canon, pv.textContent);
      }
    }
    // (4) row/container pairing: a wrapper with exactly two element children where
    // the first is a known label and the second is the value. Covers redesigns that
    // nest the label and value in sibling wrappers under a shared row (hashed class
    // names), which the leaf pass above does not always reach.
    var rowsC = document.querySelectorAll("li, div, tr, dl");
    for (var c = 0; c < rowsC.length; c++) {
      var kids = rowsC[c].children;
      if (kids.length === 2) {
        var canonPair = canonLabel(kids[0].textContent);
        if (canonPair && map[canonPair] == null) {
          var vtext = cleanVal(kids[1].textContent);
          if (vtext && vtext.length <= 64) put(canonPair, vtext);
        }
      } else if (kids.length === 1) {
        // (5) label is the container's own leading text, value is a single child
        // element ("<div>Leistung <b>140 kW</b></div>").
        var ownText = "";
        var cn = rowsC[c].childNodes;
        for (var n = 0; n < cn.length; n++) if (cn[n].nodeType === 3) ownText += cn[n].textContent;
        var canonOwn = canonLabel(ownText);
        if (canonOwn && map[canonOwn] == null) {
          var cvtext = cleanVal(kids[0].textContent);
          if (cvtext && cvtext.length <= 64) put(canonOwn, cvtext);
        }
      }
    }
    return map;
  }

  function isDetailPage(jsonld) {
    var path = location.pathname;
    var qs   = location.search || "";
    // mobile.de ad detail URLs, old format, e.g. /auto-inserat/<slug>/<id>.html
    if (/\/(auto-inserat|fahrzeuge\/details|inserat)\//i.test(path)) return true;
    if (/\/\d{6,}\.html/i.test(path)) return true;
    // Current format: /fahrzeuge/details.html?id=<digits> (the ad id lives in the
    // query string, not the path). Accept the details path ending in .html or a
    // slash together with a numeric id query param.
    if (/\/fahrzeuge\/details(\.html)?\/?$/i.test(path) && /[?&]id=\d{6,}/i.test(qs)) return true;
    // fallback: a Car JSON-LD with a first-registration date is a strong detail signal
    return !!(jsonld && (jsonld.dateVehicleFirstRegistered || jsonld.vehicleEngine));
  }

  // URL for which the badge has been drawn. Set only on a successful extraction so
  // a later mutation at the same URL cannot cause a redundant redraw.
  var lastRenderedUrl = null;
  // Bounded retry window per URL, to catch SPA content (JSON-LD, spec table) that
  // renders after document_idle without a URL change. Keyed by URL so a soft nav
  // to a new ad gets a fresh window. No infinite loop: retries stop after the time
  // budget, and only run while we are on a detail page whose data is not yet ready.
  var RETRY_WINDOW_MS = 6000;
  var RETRY_INTERVAL_MS = 600;
  var windowStart = {};
  var retryTimer = null;

  function run() {
    var url = location.href;
    if (url === lastRenderedUrl) return;

    var jsonld = readJsonLd();
    var detail = isDetailPage(jsonld);
    var vehicle = null;
    if (detail) {
      var tech = readTechData();
      vehicle = Normalise.fromMobileDe({ jsonld: jsonld, tech: tech });
    }
    var hasData = !!(vehicle && (vehicle.firstRegistration != null || vehicle.co2 != null || vehicle.powerKw != null));

    if (hasData) {
      lastRenderedUrl = url;
      delete windowStart[url];
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      Promise.all([loadTariffs(), getRegion()]).then(function (arr) {
        var tariffs = arr[0], region = arr[1];
        try {
          var engine = Tax.createTaxEngine(tariffs);
          var all = engine.computeAll(vehicle, region);
          Badge.render(all, vehicle, region);
          notifyMatch(true);
          console.debug("[BIV+Rijtaks] mobile.de", region, vehicle, all);
        } catch (e) {
          console.warn("[BIV+Rijtaks] mobile.de compute failed", e);
        }
      });
      return;
    }

    // No usable data yet. Remove any stale badge and report no match.
    Badge.remove();
    notifyMatch(false);

    // Retry only while we appear to be on a detail page (data may still be loading).
    // A page that is not a detail page will never become one, so we do not retry it.
    if (!detail) return;
    if (windowStart[url] == null) windowStart[url] = Date.now();
    if (Date.now() - windowStart[url] < RETRY_WINDOW_MS && !retryTimer) {
      retryTimer = setTimeout(function () {
        retryTimer = null;
        if (location.href === url) run();
      }, RETRY_INTERVAL_MS);
    }
  }

  function debounce(fn, ms) {
    var timer = null;
    return function () { clearTimeout(timer); timer = setTimeout(fn, ms); };
  }
  var scheduled = debounce(run, 300);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scheduled);
  } else {
    scheduled();
  }

  // SPA / soft navigation handling.
  ["pushState", "replaceState"].forEach(function (m) {
    var orig = history[m];
    history[m] = function () {
      var res = orig.apply(this, arguments);
      window.dispatchEvent(new Event("biv:locationchange"));
      return res;
    };
  });
  window.addEventListener("popstate", function () { window.dispatchEvent(new Event("biv:locationchange")); });
  window.addEventListener("biv:locationchange", function () { scheduled(); });

  var obs = new MutationObserver(debounce(function () {
    if (location.href !== lastRenderedUrl) scheduled();
  }, 500));
  obs.observe(document.documentElement, { childList: true, subtree: true });

  // Test-only hook: expose the pure gate and DOM readers to the Node fixture
  // harness. Guarded by a flag that only the harness sets, so it is completely
  // inert in the browser (the global does not exist there).
  if (typeof globalThis !== "undefined" && globalThis.__TC_EXPORT_FOR_TEST__) {
    globalThis.__tcTest = {
      isDetailPage: isDetailPage,
      readTechData: readTechData,
      readJsonLd: readJsonLd
    };
  }
})();

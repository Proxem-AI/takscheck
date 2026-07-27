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

  // Collect schema.org Car/Vehicle/Product JSON-LD blocks.
  function readJsonLd() {
    var nodes = document.querySelectorAll('script[type="application/ld+json"]');
    for (var i = 0; i < nodes.length; i++) {
      var data;
      try { data = JSON.parse(nodes[i].textContent); } catch (e) { continue; }
      var arr = Array.isArray(data) ? data : [data];
      for (var k = 0; k < arr.length; k++) {
        var o = arr[k];
        if (!o || typeof o !== "object") continue;
        if (o["@graph"]) return o;
        var type = String(o["@type"] || "");
        if (/car|vehicle|product/i.test(type) || o.vehicleEngine || o.dateVehicleFirstRegistered) return o;
      }
    }
    return null;
  }

  // Build a { labelLower: valueString } map from the labelled Technische Daten.
  // German labels are stable; class names are not. Handle dl/dt-dd, table rows,
  // and generic label/value element pairs.
  var LABELS = [
    "erstzulassung", "ez", "kraftstoff", "kraftstoffart", "leistung", "hubraum",
    "co2-emissionen", "co₂-emissionen", "co2-emission", "schadstoffklasse",
    "emissionsklasse", "zul. gesamtgewicht", "gesamtgewicht", "leergewicht", "preis"
  ];
  function norm(s) { return (s || "").replace(/\s+/g, " ").trim().toLowerCase().replace(/:$/, ""); }

  function readTechData() {
    var map = {};
    // dl / dt-dd
    var dts = document.querySelectorAll("dt");
    for (var i = 0; i < dts.length; i++) {
      var key = norm(dts[i].textContent);
      var dd = dts[i].nextElementSibling;
      if (dd && dd.tagName === "DD" && LABELS.indexOf(key) !== -1 && map[key] == null) {
        map[key] = dd.textContent.replace(/\s+/g, " ").trim();
      }
    }
    // table rows (th/td or two tds)
    var rows = document.querySelectorAll("tr");
    for (var r = 0; r < rows.length; r++) {
      var cells = rows[r].children;
      if (cells.length >= 2) {
        var k2 = norm(cells[0].textContent);
        if (LABELS.indexOf(k2) !== -1 && map[k2] == null) {
          map[k2] = cells[1].textContent.replace(/\s+/g, " ").trim();
        }
      }
    }
    // generic: an element whose exact text is a label, value in the next sibling
    if (Object.keys(map).length < 3) {
      var all = document.querySelectorAll("span,div,p,li");
      for (var a = 0; a < all.length && a < 6000; a++) {
        var el = all[a];
        if (el.children.length) continue;
        var k3 = norm(el.textContent);
        if (LABELS.indexOf(k3) !== -1 && map[k3] == null) {
          var sib = el.nextElementSibling;
          if (sib && !sib.children.length) map[k3] = sib.textContent.replace(/\s+/g, " ").trim();
        }
      }
    }
    return map;
  }

  function isDetailPage(jsonld) {
    // mobile.de ad detail URLs, e.g. /auto-inserat/<slug>/<id>.html
    if (/\/(auto-inserat|fahrzeuge\/details|inserat)\//i.test(location.pathname)) return true;
    if (/\/\d{6,}\.html/i.test(location.pathname)) return true;
    // fallback: a Car JSON-LD with a first-registration date is a strong detail signal
    return !!(jsonld && (jsonld.dateVehicleFirstRegistered || jsonld.vehicleEngine));
  }

  var lastUrl = null;

  function run() {
    if (location.href === lastUrl) return;
    var jsonld = readJsonLd();
    if (!isDetailPage(jsonld)) { Badge.remove(); lastUrl = location.href; return; }

    var tech = readTechData();
    var vehicle = Normalise.fromMobileDe({ jsonld: jsonld, tech: tech });
    if (!vehicle || (vehicle.firstRegistration == null && vehicle.co2 == null && vehicle.powerKw == null)) {
      Badge.remove(); lastUrl = location.href; return;
    }
    lastUrl = location.href;

    Promise.all([loadTariffs(), getRegion()]).then(function (arr) {
      var tariffs = arr[0], region = arr[1];
      try {
        var engine = Tax.createTaxEngine(tariffs);
        var all = engine.computeAll(vehicle, region);
        Badge.render(all, vehicle, region);
        console.debug("[BIV+Rijtaks] mobile.de", region, vehicle, all);
      } catch (e) {
        console.warn("[BIV+Rijtaks] mobile.de compute failed", e);
      }
    });
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
  window.addEventListener("biv:locationchange", function () { lastUrl = null; scheduled(); });

  var obs = new MutationObserver(debounce(function () {
    if (location.href !== lastUrl) scheduled();
  }, 500));
  obs.observe(document.documentElement, { childList: true, subtree: true });
})();

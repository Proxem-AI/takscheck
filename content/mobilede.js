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
  var LABEL_STEMS = [
    { key: "erstzulassung", re: /^erstzulassung/ },
    { key: "kraftstoffart", re: /^kraftstoff/ },
    { key: "leistung", re: /^leistung/ },
    { key: "hubraum", re: /^hubraum/ },
    { key: "co2-emissionen", re: /^co[\s.₂2-]*emission/ },
    { key: "schadstoffklasse", re: /^schadstoffklasse/ },
    { key: "emissionsklasse", re: /^emissionsklasse/ },
    { key: "zul. gesamtgewicht", re: /^zul.*gesamtgewicht/ },
    { key: "gesamtgewicht", re: /^gesamtgewicht/ },
    { key: "leergewicht", re: /^leergewicht/ },
    { key: "preis", re: /^preis/ }
  ];
  function norm(s) { return (s || "").replace(/\s+/g, " ").trim().toLowerCase().replace(/:$/, ""); }
  function canonLabel(raw) {
    var k = norm(raw).replace(/[*†‡\s]+$/, "").trim();
    if (!k || k.length > 48) return null;
    for (var i = 0; i < LABEL_STEMS.length; i++) if (LABEL_STEMS[i].re.test(k)) return LABEL_STEMS[i].key;
    return null;
  }
  function cleanVal(s) { return (s || "").replace(/\s+/g, " ").trim(); }

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
      var sib = el.nextElementSibling;
      if (sib) put(canon, sib.textContent);
      // label and value split across two wrapper divs (label is the sole child).
      if (map[canon] == null && el.parentElement && el.parentElement.children.length === 1) {
        var pv = el.parentElement.nextElementSibling;
        if (pv && cleanVal(pv.textContent).length <= 48) put(canon, pv.textContent);
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

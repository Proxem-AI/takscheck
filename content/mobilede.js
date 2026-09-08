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
        chrome.storage.local.get({ region: "flanders" }, function (cfg) {
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
  // Every alternative below was harvested from the LIVE site on 2026-09-08, one
  // locale at a time, on the same advert (id 447034521), so each is a literal
  // string mobile.de actually printed rather than a plausible translation. A
  // translated guess that is not the literal string fails silently, which is the
  // whole reason this defect existed.
  //   NL  Eerste registratie | Brandstof | Vermogen | Inhoud | CO2-emissies (kam.)2 | Emissieklasse
  //   FR  Date immatriculation | Carburant | Puissance | Cylindree | Emissions de CO2 (peigne)2 | Norme antipollution
  var LABEL_STEMS = [
    { key: "erstzulassung", re: /^(erstzulassung|first registration|first reg|eerste (registratie|inschrijving)|date\s*(de\s*)?(premiere\s*)?immatriculation|mise en circulation)/ },
    // Fuel TYPE, not fuel consumption and not fuel price. Every language mobile.de
    // serves puts a consumption row next to the fuel row and names it with the same
    // opening word, so an anchored stem alone matches both:
    //   DE  Kraftstoffart      vs  Kraftstoffverbrauch2   (both start "kraftstoff")
    //   EN  Fuel               vs  Fuel consumption2      (both start "fuel")
    //   NL  Brandstof          vs  Brandstofverbruik2, Brandstofprijs
    //   FR  Carburant          vs  Prix du carburant
    // readTechData keeps the FIRST hit per key, so on every advert captured on
    // 2026-09-08 the right row happened to come first and the wrong one was never
    // reached. That is row order on their side, not a guarantee, and one reordering
    // would have made the fuel type read as "8,5 l/100km". The consumption, price
    // and tank wording is therefore rejected outright rather than out-raced.
    { key: "kraftstoffart", re: /^(?!.*(verbrauch|verbruik|consumption|consommation|consumo|tank|prijs|prix|price|preis|kosten|cout))(kraftstoff|fuel|brandstof|carburant)/ },
    { key: "leistung", re: /^(leistung|power|vermogen|puissance)/ },
    { key: "hubraum", re: /^(hubraum|cubic capacity|displacement|engine size|inhoud|cilinderinhoud|cylindree)/ },
    // The CO2 emission figure. Three things this has to survive, all observed live:
    //   1. the "2" is a subscript U+2082 in the rendered label but a plain 2 in
    //      other markup, so [₂2] accepts either and neither form is bet on;
    //   2. French puts the CO2 token LAST ("Emissions de CO2"), so this cannot be
    //      anchored on "co" the way the German-only stem was;
    //   3. the adjacent "CO2-klasse" / "Classe CO2" and CO2 cost rows carry a CO2
    //      token too, and readTechData keeps the FIRST hit per key, so a class row
    //      matching here would poison the figure with prose. Hence the reject.
    { key: "co2-emissionen", re: /^(?!.*(klass|classe|kosten|cout|cost|prijs|prix|price|steuer|belasting|taxe))(?=.*co[\s.]*[₂2])(?=.*(emissi|uitstoot|ausstoss))/ },
    { key: "schadstoffklasse", re: /^schadstoffklasse/ },
    { key: "emissionsklasse", re: /^(emissionsklasse|emission class|emission standard|emissieklasse|norme antipollution)/ },
    { key: "zul. gesamtgewicht", re: /^(zul.*gesamtgewicht|gross.*weight|permissible.*weight)/ },
    { key: "gesamtgewicht", re: /^gesamtgewicht/ },
    { key: "leergewicht", re: /^(leergewicht|kerb.*weight|curb.*weight|unladen)/ },
    { key: "preis", re: /^(preis|price)/ }
  ];
  // Fold accents before matching, so the French "Emissions" and "Cylindree" reach
  // the stems in the spelling written above. NFD splits a letter from its combining
  // accent; stripping the combining range leaves the bare letter. The subscript two
  // is NOT a combining mark and survives this untouched, which is why the stems
  // still have to accept it explicitly.
  function norm(s) {
    return (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ").trim().toLowerCase().replace(/:$/, "");
  }
  function canonLabel(raw) {
    var k = norm(raw).replace(/[*†‡\s]+$/, "").trim();
    if (!k || k.length > 48) return null;
    for (var i = 0; i < LABEL_STEMS.length; i++) if (LABEL_STEMS[i].re.test(k)) return LABEL_STEMS[i].key;
    return null;
  }
  function cleanVal(s) { return (s || "").replace(/\s+/g, " ").trim(); }

  // Identify a field from the shape of its VALUE rather than its label.
  // mobile.de translates its labels but NOT its units: "ccm", "g/km", "kW" and
  // "Euro6d" printed identically in German, Dutch, French and English on the live
  // site (2026-09-08, same advert). So this is the locale-proof half of the
  // extraction, and it is what stops an unseen locale (Italian, Spanish, Polish)
  // degrading to a completely blank badge instead of a partial one.
  // It is deliberately a FALLBACK, filling only keys the label pass left empty, so
  // it can add data but never overwrite a correctly labelled value.
  // Deliberately NOT covered: first registration and fuel. A date and a free-text
  // word are not self-identifying, so those two still need a label stem per
  // locale. That is the known limit, see the note in the readTechData comment.
  function unitFallback(text) {
    var s = cleanVal(text);
    if (!s || s.length > 40) return null;
    // kW, never kWh: battery capacity ("81 kWh") and electricity consumption
    // ("16,6 kWh/100km") are kWh rows and must not be read as engine power.
    if (/^\d[\d.,\s]*\s*kw(?!h)\b/i.test(s)) return "leistung";
    if (/^\d[\d.,\s]*\s*(ccm|cm3|cm\u00b3)\b/i.test(s)) return "hubraum";
    if (/^\d[\d.,\s]*\s*g\s*\/\s*km\b/i.test(s)) return "co2-emissionen";
    if (/^euro\s*[0-6][a-z+\s-]*$/i.test(s)) return "emissionsklasse";
    return null;
  }

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
    // (6) unit pass: whatever the label said, a value of "2.993 ccm" is a cylinder
    // capacity and "142 g/km" is a CO2 figure in every language mobile.de serves.
    // Runs last and fills only what is still missing, so a locale we have never
    // seen yields a partial badge instead of nothing. First registration and fuel
    // are not recoverable this way and remain label-bound per locale.
    var vals = document.querySelectorAll("dd, td, span, div, li, p");
    for (var u = 0; u < vals.length; u++) {
      if (vals[u].children.length) continue;
      var canonU = unitFallback(vals[u].textContent);
      if (canonU && map[canonU] == null) put(canonU, vals[u].textContent);
    }
    return map;
  }

  function isDetailPage(jsonld) {
    var path = location.pathname;
    var qs   = location.search || "";
    // mobile.de ad detail URLs, old format, e.g. /auto-inserat/<slug>/<id>.html
    if (/\/(auto-inserat|fahrzeuge\/details|inserat)\//i.test(path)) return true;
    if (/\/\d{6,}\.html/i.test(path)) return true;
    // Current format: the ad id lives in the query string, not the path. mobile.de
    // serves the SAME detail page under a per-locale path, and it translates the
    // path noun as well as the copy. Two shapes confirmed against the live site on
    // 2026-09-08, both for the same advert id:
    //   German  suchen.mobile.de/fahrzeuge/details.html?id=<digits>
    //   Dutch   www.mobile.de/nl/voertuigen/details.html?id=<digits>
    // A Belgian user browsing in Dutch is served the /nl/ form for every advert, so
    // matching the German noun by name meant no badge at all for the user this
    // extension is built for. The noun is therefore deliberately NOT named here:
    // an optional two-letter locale prefix, one path segment in any language, then
    // details(.html). The numeric ad id in the query string is what keeps this from
    // matching a search or listing page, so it stays mandatory.
    if (/^\/(?:[a-z]{2}\/)?[^/]+\/details(?:\.html)?\/?$/i.test(path) && /[?&]id=\d{6,}/i.test(qs)) return true;
    // Fallback: a Car JSON-LD carrying a first-registration date is a strong detail
    // signal. Read this before assuming the gate has two layers of defence.
    //
    // AS OF 2026-09-08 THIS FALLBACK IS INERT. Twelve distinct live mobile.de
    // detail pages were inspected that day, across four UI languages and both
    // confirmed detail paths, and not one carried a schema.org Car, Vehicle or
    // Product node. Every page carried exactly one Organization node and nothing
    // else, so readJsonLd returns null and this line always returns false. The
    // evidence is in test/site-payload-mobilede-2026-09.json under findings.
    //
    // The practical consequence is that the URL patterns above are currently
    // carrying the gate on their own. That is the opposite of how this function
    // reads, and it is why a Belgian user on the /nl/ path got no badge at all
    // until the patterns were made locale agnostic: there was no second layer to
    // catch it.
    //
    // Keep this branch. It is neither dead code nor load-bearing: it costs nothing
    // and returns false today, and it starts doing real work again the moment
    // mobile.de re-adds vehicle structured data, which sites do routinely for SEO.
    // Deleting it because it looks unused would remove the only non-URL evidence
    // the gate has. If you widen the sample and find a Car node, say so in the
    // fixture rather than here.
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

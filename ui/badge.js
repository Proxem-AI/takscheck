/*
 * TaksCheck on-ad badge renderer. Implements Iris's approved identity
 * (2026-07-27, light header) inside a style-isolated Shadow DOM overlay.
 * Driven by the shared engine result:
 *   { region, tariffVersion, biv:{...}, rijtaks:{...} }
 *
 * Identity: white panel, light header (#F1F4F8), ink + ruby "TaksCheck"
 * wordmark, the Belgian-plate mark with a soft drop-shadow, euro figures in
 * tabular mono, region plate tag in the footer, and a single-hue ruby
 * verdict (low = neutral, medium = pale ruby tint, high = full ruby fill).
 * One blue #1B54C7, one ruby #841922, plus neutrals. No green, no amber.
 *
 * Bilingual: auto-detects NL / FR (default NL), with a manual toggle in the
 * header persisted to chrome.storage.sync. The key label sits in a fixed
 * two-line slot so the longer French wording never reflows the euro columns.
 *
 * Keeps the public contract: root.BivBadge.render(all, vehicle, region).
 */
(function (root) {
  "use strict";

  var HOST_ID = "takscheck-host";
  var STORE = null;
  try {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.sync) STORE = chrome.storage.sync;
  } catch (e) { STORE = null; }

  // --- language state (module-scoped, survives re-render) ------------------
  var LANG = null;               // "nl" | "fr", resolved lazily
  var LAST = null;               // last render args, so the toggle can re-render
  var PREF_LOADED = false;       // guards the one-time async storage read

  var I18N = {
    nl: {
      biv: { t: "BIV", s: "eenmalig" },
      rij: { t: "Rijtaks", s: "per jaar" },
      region: { flanders: "VLAANDEREN", brussels: "BRUSSEL", wallonia: "WALLONIË" },
      verdict: { low: "Laag", medium: "Gemiddeld", high: "Hoog" },
      approx: "ca.",
      estimated: "Sommige waarden zijn geschat. Het echte bedrag kan afwijken; controleer de officiële simulator.",
      sim: "Officiële simulator",
      nodata: "Onvoldoende gegevens",
      needs: function (tax, token) { return tax + " vereist " + token + ", niet vermeld in deze advertentie."; },
      disclaimer: "Schatting, geen officiële aanslag.",
      changeRegion: "Wijzig regio",
      co2na: "CO2 onbekend",
      tokens: { co2: "de CO2-waarde", power: "het vermogen (kW)", cc: "de cilinderinhoud (cc)", data: "meer gegevens" }
    },
    fr: {
      biv: { t: "TMC", s: "taxe de mise en circulation" },
      rij: { t: "Taxe de circulation", s: "par an" },
      region: { flanders: "FLANDRE", brussels: "BRUXELLES", wallonia: "WALLONIE" },
      verdict: { low: "Bas", medium: "Moyen", high: "Élevé" },
      approx: "env.",
      estimated: "Certaines valeurs sont estimées. Le montant réel peut différer; vérifiez le simulateur officiel.",
      sim: "Simulateur officiel",
      nodata: "Données insuffisantes",
      needs: function (tax, token) { return tax + " nécessite " + token + ", absent de cette annonce."; },
      disclaimer: "Estimation, pas un avis d'imposition officiel.",
      changeRegion: "Changer de région",
      co2na: "CO2 inconnu",
      tokens: { co2: "la valeur CO2", power: "la puissance (kW)", cc: "la cylindrée (cc)", data: "plus de données" }
    }
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // Belgian convention: dot as thousands separator, whole euros. 1847 -> "1.847".
  function group(n) {
    n = Math.round(Number(n) || 0);
    var neg = n < 0;
    var s = String(Math.abs(n));
    var out = "";
    for (var i = 0; i < s.length; i++) {
      if (i > 0 && (s.length - i) % 3 === 0) out += ".";
      out += s[i];
    }
    return (neg ? "-" : "") + out;
  }

  // Euro glyph, non-breaking space, grouped amount: "€ 495".
  function euro(n) { return "€ " + group(n); }

  // Auto-detect page language. Order: <html lang>, URL path segment (/fr/, /nl/),
  // then navigator.language. Belgium defaults to NL when nothing says FR.
  function detectLang() {
    var d = "";
    try { d = (document.documentElement.lang || "").toLowerCase(); } catch (e) {}
    if (d.indexOf("fr") === 0) return "fr";
    if (d.indexOf("nl") === 0) return "nl";
    var p = "";
    try { p = (location.pathname || "").toLowerCase(); } catch (e) {}
    if (/(^|\/)fr(\/|$|-)/.test(p)) return "fr";
    if (/(^|\/)nl(\/|$|-)/.test(p)) return "nl";
    var n = "";
    try { n = (navigator.language || "").toLowerCase(); } catch (e) {}
    if (n.indexOf("fr") === 0) return "fr";
    return "nl";
  }

  function lang() { return LANG || (LANG = detectLang()); }
  function L() { return I18N[lang()] || I18N.nl; }

  function optionsHref() {
    try { if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL) return chrome.runtime.getURL("options.html"); }
    catch (e) {}
    return "#";
  }

  var EXT = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M3 1h6v6M9 1 1 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  // The plate mark, exactly Iris's wordmark-lockup glyph (34x24 viewBox).
  var PLATE =
    '<svg class="tc-mark" viewBox="0 0 34 24" aria-hidden="true">' +
      '<rect x="1" y="1" width="32" height="22" rx="4.5" fill="#1B54C7"/>' +
      '<path d="M9.1 2.8 H28.5 A2.7 2.7 0 0 1 31.2 5.5 V18.5 A2.7 2.7 0 0 1 28.5 21.2 H9.1 Z" fill="#fff"/>' +
      '<path d="M12.4 12 L16.4 16 L25 6" fill="none" stroke="#841922" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>' +
    "</svg>";

  // Name the missing input from the engine's English reason, localised.
  function missingToken(reason) {
    var r = String(reason || ""), tk = L().tokens;
    if (/co2/i.test(r)) return tk.co2;
    if (/power|kw/i.test(r)) return tk.power;
    if (/fiscal hp|cc|displacement/i.test(r)) return tk.cc;
    return tk.data;
  }

  // Verdict tier from the one-off tax (BIV / TMC), the figure a buyer weighs.
  // Presentation-only thresholds (do NOT touch the tax engine). Bands, in EUR:
  //   low <= 250, medium <= 2000, high > 2000. Calibrated so a typical modern
  //   petrol/diesel reads "medium" and an EV flat (61.50) reads "low".
  //   Falls back to the annual figure if the one-off is unavailable.
  function verdictTier(all) {
    var b = all.biv;
    if (b && b.amount != null) {
      if (b.amount <= 250) return "low";
      if (b.amount <= 2000) return "medium";
      return "high";
    }
    var r = all.rijtaks;
    if (r && r.amount != null) {
      if (r.amount <= 150) return "low";
      if (r.amount <= 500) return "medium";
      return "high";
    }
    return null;
  }

  // One value cell: euro figure in mono, or the "not enough data" tag.
  function valueCell(res) {
    if (!res || res.needsMoreData || res.amount == null) {
      return '<span class="tc-v tc-nd">' + esc(L().nodata) + "</span>";
    }
    var approx = res.confidence !== "high" ? '<span class="tc-approx">' + esc(L().approx) + "</span> " : "";
    return '<span class="tc-v">' + approx + esc(euro(res.amount)) + "</span>";
  }

  function keyCell(key) {
    return '<span class="tc-k"><b>' + esc(key.t) + "</b>" + esc(key.s) + "</span>";
  }

  function vehicleLine(v) {
    var parts = [];
    if (v.title) parts.push('<span class="tc-veh-name">' + esc(v.title) + "</span>");
    var fuel = v.fuelRaw || v.fuel;
    if (fuel) parts.push("<span>" + esc(fuel) + "</span>");
    if (v.powerKw != null) parts.push("<span>" + esc(v.powerKw) + " kW</span>");
    parts.push("<span>" + (v.co2 != null ? esc(v.co2) + " g CO2" : esc(L().co2na)) + "</span>");
    if (v.firstRegistration) parts.push("<span>" + esc(v.firstRegistration) + "</span>");
    return parts.join('<span class="tc-sep">&middot;</span>');
  }

  // Region plate tag for the footer (B band + region name), Iris's supporting mark.
  function plateTag(region) {
    var name = L().region[region] || String(region).toUpperCase();
    return '<span class="tc-plate"><span class="tc-eu">B</span><span class="tc-reg">' + esc(name) + "</span></span>";
  }

  var CSS =
    ":host{all:initial}" +
    ".tc-overlay{position:fixed;right:16px;bottom:16px;z-index:2147483000;max-width:calc(100vw - 24px)}" +
    ".tc-panel{" +
      "--blue:#1B54C7;--ruby:#841922;--ink:#101720;--slate:#5A6472;--line:#E1E5EA;" +
      "--mist:#EEF1F4;--mist2:#F1F4F8;--white:#ffffff;" +
      "width:320px;max-width:calc(100vw - 24px);background:var(--white);color:var(--ink);" +
      'font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;' +
      "border:1px solid var(--line);border-radius:14px;overflow:hidden;font-size:14px;line-height:1.5;" +
      "box-shadow:0 1px 2px rgba(16,24,40,.05),0 16px 40px -18px rgba(16,24,40,.28)}" +
    // header (light)
    ".tc-head{display:flex;align-items:center;gap:9px;padding:9px 11px;background:var(--mist2);" +
      "border-bottom:1px solid var(--line);cursor:pointer}" +
    ".tc-mark{width:26px;height:18px;flex:none;filter:drop-shadow(0 1px 1.5px rgba(16,24,40,.22))}" +
    ".tc-name{font-weight:800;font-size:14px;letter-spacing:-.02em;color:var(--ink)}" +
    ".tc-name .c{color:var(--ruby)}" +
    ".tc-toggle{margin-left:auto;display:inline-flex;border:1px solid var(--line);border-radius:7px;overflow:hidden}" +
    ".tc-toggle button{border:0;background:transparent;color:var(--slate);padding:3px 10px;cursor:pointer;" +
      "font-weight:750;font-family:inherit;font-size:11px;line-height:1.4}" +
    ".tc-toggle button.on{background:var(--blue);color:#fff}" +
    // vehicle
    ".tc-vehicle{padding:8px 12px;background:var(--mist);border-bottom:1px solid var(--line);" +
      "font-size:12px;color:var(--slate);display:flex;flex-wrap:wrap;align-items:center;gap:5px;line-height:1.4}" +
    ".tc-veh-name{color:var(--ink);font-weight:700}" +
    ".tc-sep{opacity:.5}" +
    // value rows (reflow-proof two-line key slot)
    ".tc-rows{display:flex}" +
    ".tc-row{flex:1;min-width:0;padding:11px 12px}" +
    ".tc-row + .tc-row{border-left:1px solid var(--line)}" +
    ".tc-k{display:block;color:var(--slate);font-size:10.5px;line-height:1.3;min-height:40px}" +
    ".tc-k b{display:block;color:var(--ink);font-size:11px;font-weight:800;letter-spacing:.01em;margin-bottom:1px}" +
    ".tc-v{display:block;font-weight:750;font-size:17px;letter-spacing:-.02em;color:var(--ink);" +
      'font-family:"IBM Plex Mono",ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-variant-numeric:tabular-nums}' +
    ".tc-approx{font-family:inherit;font-size:11px;font-weight:600;color:var(--slate);letter-spacing:0}" +
    ".tc-v.tc-nd{font-family:inherit;font-size:12px;font-weight:700;color:var(--slate);letter-spacing:0}" +
    // notes
    ".tc-notes{padding:0 12px 2px}" +
    ".tc-note{font-size:12px;line-height:1.45;color:var(--slate);margin:8px 0 0}" +
    ".tc-note b{color:var(--ink);font-weight:700}" +
    ".tc-sim{display:inline-flex;align-items:center;gap:5px;margin:10px 12px 2px;font-size:12px;" +
      "font-weight:700;color:var(--blue);text-decoration:none}" +
    ".tc-sim:hover{text-decoration:underline}" +
    // footer: region plate + verdict
    ".tc-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;" +
      "padding:9px 12px;background:var(--mist2);border-top:1px solid var(--line);margin-top:10px}" +
    ".tc-plate{display:inline-flex;align-items:stretch;height:20px;border:1px solid #b9c1cb;border-radius:5px;" +
      "overflow:hidden;background:#fff}" +
    ".tc-eu{background:var(--blue);color:#fff;font-size:9px;font-weight:800;" +
      'font-family:"IBM Plex Mono",ui-monospace,"SF Mono",Menlo,monospace;display:flex;align-items:center;justify-content:center;width:14px}' +
    ".tc-reg{padding:0 8px;color:var(--ink);font-weight:800;font-size:10.5px;letter-spacing:.05em;" +
      'display:flex;align-items:center;font-family:"IBM Plex Mono",ui-monospace,"SF Mono",Menlo,monospace}' +
    ".tc-verdict{font-size:11.5px;font-weight:800;letter-spacing:.02em;padding:4px 11px;border-radius:7px;white-space:nowrap}" +
    ".tc-verdict.low{background:#EDF0F4;color:var(--ink);border:1px solid #ccd3db}" +
    ".tc-verdict.medium{background:#F3DADE;color:var(--ruby)}" +
    ".tc-verdict.high{background:var(--ruby);color:#fff}" +
    // disclaimer
    ".tc-disc{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;" +
      "padding:8px 12px 10px;font-size:11px;line-height:1.4;color:var(--slate)}" +
    ".tc-opt{color:var(--blue);font-weight:700;text-decoration:none;white-space:nowrap}" +
    ".tc-opt:hover{text-decoration:underline}" +
    // collapsed
    ".tc-panel.tc-collapsed .tc-vehicle,.tc-panel.tc-collapsed .tc-rows," +
    ".tc-panel.tc-collapsed .tc-notes,.tc-panel.tc-collapsed .tc-sim," +
    ".tc-panel.tc-collapsed .tc-foot,.tc-panel.tc-collapsed .tc-disc{display:none}";

  function buildNotes(all) {
    var out = [];
    var anyEstimated = ["biv", "rijtaks"].some(function (k) {
      var r = all[k];
      return r && !r.needsMoreData && r.amount != null && r.confidence !== "high";
    });
    if (anyEstimated) out.push('<p class="tc-note">' + esc(L().estimated) + "</p>");
    [["biv", L().biv.t], ["rijtaks", L().rij.t]].forEach(function (pair) {
      var r = all[pair[0]];
      if (r && (r.needsMoreData || r.amount == null)) {
        out.push('<p class="tc-note">' + esc(L().needs(pair[1], missingToken(r.reason))) + "</p>");
      }
    });
    return out.length ? '<div class="tc-notes">' + out.join("") + "</div>" : "";
  }

  function render(all, vehicle, region) {
    LAST = { all: all, vehicle: vehicle, region: region };

    var host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement("div");
      host.id = HOST_ID;
      document.documentElement.appendChild(host);
      host.attachShadow({ mode: "open" });
    }
    var shadow = host.shadowRoot;
    var lg = lang();

    var simUrl = (all.biv && all.biv.simulatorUrl) || (all.rijtaks && all.rijtaks.simulatorUrl) || "";
    var tier = verdictTier(all);
    var verdictHtml = tier
      ? '<span class="tc-verdict ' + tier + '">' + esc(L().verdict[tier]) + "</span>"
      : "<span></span>";

    shadow.innerHTML =
      "<style>" + CSS + "</style>" +
      '<div class="tc-overlay">' +
        '<div class="tc-panel">' +
          '<div class="tc-head">' +
            PLATE +
            '<span class="tc-name">Taks<span class="c">Check</span></span>' +
            '<span class="tc-toggle">' +
              '<button type="button" data-lang="nl" class="' + (lg === "nl" ? "on" : "") + '">NL</button>' +
              '<button type="button" data-lang="fr" class="' + (lg === "fr" ? "on" : "") + '">FR</button>' +
            "</span>" +
          "</div>" +
          '<div class="tc-vehicle">' + vehicleLine(vehicle) + "</div>" +
          '<div class="tc-rows">' +
            '<div class="tc-row">' + keyCell(L().biv) + valueCell(all.biv) + "</div>" +
            '<div class="tc-row">' + keyCell(L().rij) + valueCell(all.rijtaks) + "</div>" +
          "</div>" +
          buildNotes(all) +
          (simUrl ? '<a class="tc-sim" href="' + esc(simUrl) + '" target="_blank" rel="noopener">' + esc(L().sim) + " " + EXT + "</a>" : "") +
          '<div class="tc-foot">' + plateTag(region) + verdictHtml + "</div>" +
          '<div class="tc-disc"><span>' + esc(L().disclaimer) + "</span>" +
            '<a class="tc-opt" href="' + esc(optionsHref()) + '" target="_blank" rel="noopener">' + esc(L().changeRegion) + "</a>" +
          "</div>" +
        "</div>" +
      "</div>";

    wireToggle(shadow);
    wireCollapse(shadow);
    loadPrefOnce();
  }

  // Language toggle: set + persist, then re-render from LAST (never touches the
  // engine; numbers stay in their fixed mono columns).
  function wireToggle(shadow) {
    var buttons = shadow.querySelectorAll(".tc-toggle button");
    Array.prototype.forEach.call(buttons, function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        var next = b.getAttribute("data-lang");
        if (next === LANG) return;
        LANG = next;
        try { if (STORE) STORE.set({ lang: next }); } catch (err) {}
        if (LAST) render(LAST.all, LAST.vehicle, LAST.region);
      });
    });
  }

  // Collapse on header click, but not when a control or link is the target.
  function wireCollapse(shadow) {
    var head = shadow.querySelector(".tc-head");
    var panel = shadow.querySelector(".tc-panel");
    if (!head || !panel) return;
    head.addEventListener("click", function (e) {
      if (e.target.closest && e.target.closest("button, a")) return;
      panel.classList.toggle("tc-collapsed");
    });
  }

  // One-time async read of the saved language preference; overrides auto-detect.
  function loadPrefOnce() {
    if (PREF_LOADED || !STORE) return;
    PREF_LOADED = true;
    try {
      STORE.get({ lang: null }, function (cfg) {
        var saved = cfg && cfg.lang;
        if (saved && saved !== LANG) {
          LANG = saved;
          if (LAST) render(LAST.all, LAST.vehicle, LAST.region);
        }
      });
    } catch (e) {}
  }

  function remove() {
    var host = document.getElementById(HOST_ID);
    if (host) host.remove();
  }

  root.BivBadge = { render: render, remove: remove };
})(typeof globalThis !== "undefined" ? globalThis : this);

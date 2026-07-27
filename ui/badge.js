/*
 * Badge renderer. Implements Iris's approved panel design (2026-07-27) inside a
 * style-isolated Shadow DOM overlay. Driven by the shared engine's result:
 *   { region, tariffVersion, biv:{...}, rijtaks:{...} }
 * Per-result confidence and three states (full / low / not-enough-data).
 * Currency: euro glyph + dot thousands separator (Belgian convention), so an
 * amount renders as the euro glyph then e.g. "1.847". Sets globalThis.BivBadge.
 */
(function (root) {
  "use strict";

  var HOST_ID = "biv-rijtaks-estimator-host";
  var REGION_LABEL = { flanders: "Flanders", brussels: "Brussels", wallonia: "Wallonia" };

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

  function prefersDark() {
    try { return !!(root.matchMedia && root.matchMedia("(prefers-color-scheme: dark)").matches); }
    catch (e) { return false; }
  }

  function optionsHref() {
    try { if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL) return chrome.runtime.getURL("options.html"); }
    catch (e) {}
    return "#";
  }

  // --- inline SVG glyphs (from Iris's mockup) ---
  var CHEV = '<svg class="chev" width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M3 1.5 6.5 5 3 8.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var EXT = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M3 1h6v6M9 1 1 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var INFO = '<svg width="13" height="13" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6" stroke="currentColor" stroke-width="1.4"/><path d="M7 4v3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="7" cy="10" r=".9" fill="currentColor"/></svg>';

  function confClass(conf) { return conf === "high" ? "conf-hi" : "conf-lo"; }
  function confLabel(conf) {
    return conf === "high" ? "High confidence" : conf === "medium" ? "Medium confidence" : "Low confidence";
  }

  // Name the guessed inputs from the engine's assumptions, for the plain sentence.
  function guessedInputs(assumptions) {
    var out = [], seen = {};
    function add(x) { if (!seen[x]) { seen[x] = 1; out.push(x); } }
    (assumptions || []).forEach(function (a) {
      if (/euro\s*\d?.*inferred|air component defaulted/i.test(a)) add("the Euro emission norm");
      if (/cc \/ 200|fiscal HP .*estimated|estimated from kW/i.test(a)) add("the fiscal horsepower");
      if (/MMA/i.test(a)) add("the vehicle mass");
      if (/NEDC|WLTP assumed|transition/i.test(a)) add("the CO2 cycle (WLTP vs NEDC)");
      if (/representative fiscal-HP scale/i.test(a)) add("an approximate annual tariff");
      if (/assuming a new car|no first-registration/i.test(a)) add("the age (assumed new)");
    });
    return out;
  }

  function missingInput(reason) {
    var r = String(reason || "");
    if (/co2/i.test(r)) return { token: "CO2 value", hint: "You will find CO2 on the registration certificate (field V.7) or on the official simulator. Enter it there for an exact figure." };
    if (/power|kw/i.test(r)) return { token: "engine power (kW)", hint: "The power in kW is on the registration certificate and usually in the listing." };
    if (/fiscal hp|cc|displacement/i.test(r)) return { token: "engine displacement (cc)", hint: "Displacement (cc) is on the registration certificate; enter it on the official simulator." };
    return { token: "required data", hint: "Check the official simulator with the vehicle details from the registration certificate." };
  }

  function assumptionsBlock(res) {
    var items = (res.assumptions || []).map(function (a) { return "<li>" + esc(a) + "</li>"; }).join("");
    if (!items) return '<span class="foot-hint">Computed from listing data</span>';
    return '<details class="assump"><summary>' + CHEV + "Assumptions</summary>" +
      '<div class="assump-body"><ul>' + items + "</ul></div></details>";
  }

  function simLink(url) {
    return '<a class="sim-link" href="' + esc(url) + '" target="_blank" rel="noopener">Official simulator ' + EXT + "</a>";
  }

  // One result block: state A (full), B (low), or C (not enough data).
  function resultBlock(label, res) {
    if (!res) return "";
    var taxWord = label.split(" ")[0]; // "BIV" or "Rijtaks"

    // State C: not enough data.
    if (res.needsMoreData || res.amount == null) {
      var miss = missingInput(res.reason);
      return "" +
        '<div class="result nodata">' +
          '<div class="nodata-head"><div class="grow">' +
            '<div class="result-label">' + esc(label) + "</div>" +
            '<span class="nodata-badge">' + INFO + " Not enough data</span>" +
          "</div></div>" +
          '<p class="nodata-msg">' + esc(taxWord) + ' needs the <span class="nodata-em">' + esc(miss.token) + "</span>, which this listing does not include.</p>" +
          '<p class="nodata-hint">' + esc(miss.hint) + "</p>" +
          '<div class="result-foot"><span class="foot-hint">Cannot estimate safely</span>' + simLink(res.simulatorUrl) + "</div>" +
        "</div>";
    }

    var conf = res.confidence || "high";
    var isHigh = conf === "high";
    var isRijtaks = /rijtaks/i.test(label) || /annual/i.test(res.basis || "");

    var per = [];
    if (isRijtaks) per.push("/ year");
    if (!isHigh) per.push("approx.");
    var perHtml = per.length ? '<span class="per">' + esc(per.join(" ")) + "</span>" : "";

    var note = "";
    if (!isHigh) {
      var gi = guessedInputs(res.assumptions);
      var lead = gi.length ? "This estimate relies on " + gi.join(", ") + ". " : "Some inputs had to be estimated. ";
      note = '<p class="conf-note">' + esc(lead) + "The real figure may differ; check the official simulator to confirm.</p>";
    }

    return "" +
      '<div class="result">' +
        '<div class="result-top">' +
          '<div class="grow">' +
            '<div class="result-label">' + esc(label) + "</div>" +
            '<div class="amount"><span class="cur">&euro;</span>' + esc(group(res.amount)) + perHtml + "</div>" +
          "</div>" +
          '<span class="conf ' + confClass(conf) + '"><span class="cdot"></span>' + confLabel(conf) + "</span>" +
        "</div>" +
        note +
        '<div class="result-foot">' + assumptionsBlock(res) + simLink(res.simulatorUrl) + "</div>" +
      "</div>";
  }

  function vehicleLine(v) {
    var parts = [];
    if (v.title) parts.push('<span class="veh-name">' + esc(v.title) + "</span>");
    var fuel = v.fuelRaw || v.fuel;
    if (fuel) parts.push("<span>" + esc(fuel) + "</span>");
    if (v.powerKw != null) parts.push("<span>" + esc(v.powerKw) + " kW</span>");
    parts.push("<span>" + (v.co2 != null ? esc(v.co2) + " g CO2" : "CO2 n/a") + "</span>");
    if (v.firstRegistration) parts.push("<span>" + esc(v.firstRegistration) + "</span>");
    return parts.join('<span class="sep">-</span>');
  }

  var CSS =
    ':host{all:initial}' +
    '.biv-overlay{position:fixed;right:16px;bottom:16px;z-index:2147483000;max-width:calc(100vw - 24px)}' +
    '.biv-panel{' +
      '--p-bg:#ffffff;--p-ink:#141a17;--p-strong:#0d1512;--p-mut:#54606a;--p-line:#e4e7ea;--p-line-soft:#eef0f2;' +
      '--p-block:#f7f8f9;--p-sage:#41604f;--p-sage-ink:#2c4636;--p-sage-tint:#e7efe9;' +
      '--p-conf-hi-bg:#e4efe7;--p-conf-hi-ink:#2c4a37;--p-conf-lo-bg:#fbeedd;--p-conf-lo-ink:#7a4d12;' +
      '--p-nodata-bg:#eef1f3;--p-nodata-ink:#3d4753;' +
      'width:344px;max-width:calc(100vw - 24px);background:var(--p-bg);color:var(--p-ink);' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;' +
      'border:1px solid var(--p-line);border-radius:14px;' +
      'box-shadow:0 6px 22px rgba(18,24,33,.14),0 1px 0 rgba(255,255,255,.6) inset;overflow:hidden;font-size:14px;line-height:1.5}' +
    '.biv-panel[data-theme="dark"]{' +
      '--p-bg:#1b2027;--p-ink:#eef1f4;--p-strong:#ffffff;--p-mut:#aab4bf;--p-line:#333b45;--p-line-soft:#2a323b;' +
      '--p-block:#222932;--p-sage:#8fc0a5;--p-sage-ink:#a9d2bc;--p-sage-tint:#26332c;' +
      '--p-conf-hi-bg:#26352b;--p-conf-hi-ink:#a6d5b8;--p-conf-lo-bg:#3a3020;--p-conf-lo-ink:#f0c885;' +
      '--p-nodata-bg:#262d36;--p-nodata-ink:#c2cbd5;border-color:#333b45;box-shadow:0 10px 30px rgba(0,0,0,.5)}' +
    '.biv-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--p-line);cursor:pointer}' +
    '.biv-mark{width:26px;height:26px;border-radius:7px;flex:none;background:var(--p-sage-tint);display:flex;align-items:center;justify-content:center;color:var(--p-sage-ink);font-weight:800;font-size:13px;letter-spacing:-.02em}' +
    '.biv-title{font-weight:750;letter-spacing:-.01em;font-size:14px;color:var(--p-ink);line-height:1.1}' +
    '.biv-head .spacer{flex:1}' +
    '.pill{font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;padding:3px 8px;border-radius:999px;line-height:1.4;white-space:nowrap}' +
    '.pill-est{background:var(--p-sage-tint);color:var(--p-sage-ink)}' +
    '.region{display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:650;color:var(--p-ink);padding:3px 8px;border-radius:999px;border:1px solid var(--p-line)}' +
    '.region .dot{width:6px;height:6px;border-radius:50%;background:var(--p-sage)}' +
    '.biv-vehicle{padding:9px 14px;background:var(--p-block);border-bottom:1px solid var(--p-line);font-size:12.5px;color:var(--p-mut);display:flex;flex-wrap:wrap;align-items:center;gap:6px;line-height:1.4}' +
    '.biv-vehicle .veh-name{color:var(--p-ink);font-weight:700}' +
    '.biv-vehicle .sep{opacity:.5}' +
    '.biv-body{padding:12px 14px 6px}' +
    '.result{border:1px solid var(--p-line);border-radius:11px;padding:12px 13px;margin-bottom:11px;background:var(--p-bg)}' +
    '.result-top{display:flex;align-items:flex-start;gap:10px}' +
    '.result-label{font-size:12px;font-weight:700;letter-spacing:.02em;text-transform:uppercase;color:var(--p-mut);margin:1px 0 3px}' +
    '.amount{font-size:30px;line-height:1.05;font-weight:800;letter-spacing:-.02em;color:var(--p-strong);font-variant-numeric:tabular-nums;display:flex;align-items:baseline;gap:4px;flex-wrap:wrap}' +
    '.amount .cur{font-size:19px;font-weight:750;color:var(--p-strong)}' +
    '.amount .per{font-size:13px;font-weight:600;color:var(--p-mut);letter-spacing:0}' +
    '.result-top .grow{flex:1;min-width:0}' +
    '.conf{flex:none;align-self:flex-start;margin-top:2px;display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:700;letter-spacing:.01em;padding:4px 8px;border-radius:999px;white-space:nowrap}' +
    '.conf .cdot{width:7px;height:7px;border-radius:50%;flex:none}' +
    '.conf-hi{background:var(--p-conf-hi-bg);color:var(--p-conf-hi-ink)}.conf-hi .cdot{background:#3f9e6a}' +
    '.conf-lo{background:var(--p-conf-lo-bg);color:var(--p-conf-lo-ink)}.conf-lo .cdot{background:#d98a1f}' +
    '.conf-note{margin:8px 0 0;font-size:12px;line-height:1.45;color:var(--p-mut)}' +
    '.result-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:9px;padding-top:9px;border-top:1px solid var(--p-line-soft)}' +
    '.foot-hint{font-size:12px;color:var(--p-mut);font-weight:600}' +
    'details.assump{flex:1;min-width:0}' +
    'details.assump summary{list-style:none;cursor:pointer;display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:650;color:var(--p-ink);user-select:none}' +
    'details.assump summary::-webkit-details-marker{display:none}' +
    '.chev{transition:transform .15s ease;flex:none}details[open] .chev{transform:rotate(90deg)}' +
    '.assump-body{margin-top:8px;font-size:12px;line-height:1.5;color:var(--p-mut)}' +
    '.assump-body ul{margin:0;padding-left:15px}.assump-body li{margin:2px 0}.assump-body b{color:var(--p-ink);font-weight:650}' +
    '.sim-link{flex:none;display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:700;color:var(--p-sage-ink);text-decoration:none;white-space:nowrap}' +
    '.sim-link:hover{text-decoration:underline}' +
    '.result.nodata{background:var(--p-nodata-bg);border-style:dashed;border-color:var(--p-line)}' +
    '.nodata-head{display:flex;align-items:center;gap:8px}' +
    '.nodata-badge{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:var(--p-nodata-ink)}' +
    '.nodata-badge svg{flex:none}' +
    '.nodata-msg{margin:7px 0 0;font-size:13px;line-height:1.5;color:var(--p-ink);font-weight:600}' +
    '.nodata-hint{margin:5px 0 0;font-size:12px;line-height:1.5;color:var(--p-mut)}' +
    '.nodata-em{color:var(--p-strong);font-weight:750}' +
    '.biv-foot{padding:10px 14px 12px;border-top:1px solid var(--p-line);background:var(--p-block);font-size:11px;line-height:1.5;color:var(--p-mut)}' +
    '.biv-foot .foot-row{display:flex;flex-wrap:wrap;gap:4px 6px;align-items:center}' +
    '.biv-foot b{color:var(--p-ink);font-weight:700}.biv-foot .fdot{opacity:.5}' +
    '.biv-foot .foot-meta{margin-top:5px;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}' +
    '.biv-foot .tariff{font-variant-numeric:tabular-nums;color:var(--p-mut);font-weight:600}' +
    '.biv-foot a.opt{color:var(--p-sage-ink);font-weight:700;text-decoration:none}.biv-foot a.opt:hover{text-decoration:underline}' +
    '.biv-panel.collapsed .biv-vehicle,.biv-panel.collapsed .biv-body,.biv-panel.collapsed .biv-foot{display:none}';

  function render(all, vehicle, region) {
    var host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement("div");
      host.id = HOST_ID;
      document.documentElement.appendChild(host);
      host.attachShadow({ mode: "open" });
    }
    var shadow = host.shadowRoot;
    var theme = prefersDark() ? "dark" : "light";
    var regionLabel = REGION_LABEL[region] || region;

    shadow.innerHTML =
      "<style>" + CSS + "</style>" +
      '<div class="biv-overlay">' +
        '<div class="biv-panel" data-theme="' + theme + '">' +
          '<div class="biv-head">' +
            '<div class="biv-mark">B</div>' +
            '<div class="biv-title">BIV + Rijtaks</div>' +
            '<span class="spacer"></span>' +
            '<span class="pill pill-est">Estimate</span>' +
            '<span class="region"><span class="dot"></span>' + esc(regionLabel) + "</span>" +
          "</div>" +
          '<div class="biv-vehicle">' + vehicleLine(vehicle) + "</div>" +
          '<div class="biv-body">' +
            resultBlock("BIV (one-off)", all.biv) +
            resultBlock("Rijtaks (annual)", all.rijtaks) +
          "</div>" +
          '<div class="biv-foot">' +
            '<div class="foot-row"><b>Estimate only</b> <span class="fdot">-</span> not an official assessment</div>' +
            '<div class="foot-meta">' +
              '<span class="tariff">Tariff v' + esc(all.tariffVersion) + " - " + esc(regionLabel) + "</span>" +
              '<a class="opt" href="' + esc(optionsHref()) + '" target="_blank" rel="noopener">Change region in options</a>' +
            "</div>" +
          "</div>" +
        "</div>" +
      "</div>";

    // Collapse on header click (does not alter the open appearance vs the mockup).
    var head = shadow.querySelector(".biv-head");
    var panel = shadow.querySelector(".biv-panel");
    head.addEventListener("click", function (e) {
      if (e.target.closest && e.target.closest("a")) return;
      panel.classList.toggle("collapsed");
    });

    // Keep the panel theme in sync if the OS scheme changes while it is open.
    if (!host.__themeWired) {
      host.__themeWired = true;
      try {
        var mq = root.matchMedia("(prefers-color-scheme: dark)");
        var onChange = function () {
          var p = host.shadowRoot && host.shadowRoot.querySelector(".biv-panel");
          if (p) p.setAttribute("data-theme", mq.matches ? "dark" : "light");
        };
        if (mq.addEventListener) mq.addEventListener("change", onChange);
        else if (mq.addListener) mq.addListener(onChange);
      } catch (e) {}
    }
  }

  function remove() {
    var host = document.getElementById(HOST_ID);
    if (host) host.remove();
  }

  root.BivBadge = { render: render, remove: remove };
})(typeof globalThis !== "undefined" ? globalThis : this);

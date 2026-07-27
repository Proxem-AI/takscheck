/*
 * Badge renderer. Draws two style-isolated badges (BIV + Rijtaks) inside a
 * Shadow DOM host so the site CSS cannot touch them and ours cannot touch the
 * site. Clearly labelled as an estimate, never styled to look native.
 * Sets globalThis.BivBadge.
 */
(function (root) {
  "use strict";

  var HOST_ID = "biv-rijtaks-estimator-host";
  var REGION_LABEL = { flanders: "Flanders", brussels: "Brussels", wallonia: "Wallonia" };
  var CONF_LABEL = { high: "high confidence", medium: "medium confidence", low: "low confidence", none: "insufficient data" };
  var CONF_COLOR = { high: "#1a7f4b", medium: "#9a6a00", low: "#b23b3b", none: "#6b7280" };

  function euro(n) {
    return new Intl.NumberFormat("nl-BE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(Math.round(n));
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function taxCard(kind, res) {
    if (!res) return "";
    var conf = res.confidence || "none";
    if (res.needsMoreData || res.amount == null) {
      return '' +
        '<div class="card">' +
          '<div class="row"><span class="kind">' + esc(kind) + '</span>' +
            '<span class="dot" style="background:' + CONF_COLOR.none + '"></span></div>' +
          '<div class="amt na">not enough data</div>' +
          '<div class="reason">' + esc(res.reason || "missing input") + '</div>' +
          '<a class="sim" href="' + esc(res.simulatorUrl) + '" target="_blank" rel="noopener">official simulator &rarr;</a>' +
        '</div>';
    }
    var assum = (res.assumptions || []).map(function (a) { return "<li>" + esc(a) + "</li>"; }).join("");
    return '' +
      '<div class="card">' +
        '<div class="row"><span class="kind">' + esc(kind) + '</span>' +
          '<span class="dot" title="' + esc(CONF_LABEL[conf]) + '" style="background:' + CONF_COLOR[conf] + '"></span></div>' +
        '<div class="amt">' + esc(euro(res.amount)) + '</div>' +
        '<div class="basis">' + esc(res.basis) + '</div>' +
        '<div class="conf ' + esc(conf) + '">' + esc(CONF_LABEL[conf]) + '</div>' +
        (assum ? '<details class="assum"><summary>assumptions</summary><ul>' + assum + '</ul></details>' : '') +
        '<a class="sim" href="' + esc(res.simulatorUrl) + '" target="_blank" rel="noopener">official simulator &rarr;</a>' +
      '</div>';
  }

  // Light theme is the base. The dark-mode override block is placed LAST so its
  // rules win in source order (equal specificity, later-wins). Text colours are
  // explicit (no opacity-based muting) so contrast is predictable and WCAG AA.
  var CSS = '' +
    ':host{all:initial}' +
    '.panel{position:fixed;right:16px;bottom:16px;z-index:2147483000;width:300px;max-width:calc(100vw - 32px);' +
      'font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:#1a1d24;' +
      'background:#fff;border:1px solid #e2e6ec;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.18);overflow:hidden}' +
    '.head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:#eef1f5;cursor:pointer}' +
    '.head b{font-size:13px;color:#12151b}.head .reg{font-size:11px;color:#4b5563;font-weight:600}' +
    '.body{padding:10px 12px;display:grid;gap:10px}' +
    '.card{border:1px solid #e2e6ec;border-radius:10px;padding:10px 12px;background:#fafbfc}' +
    '.row{display:flex;align-items:center;justify-content:space-between}' +
    '.kind{font-size:11px;text-transform:uppercase;letter-spacing:.06em;font-weight:700;color:#374151}' +
    '.dot{width:9px;height:9px;border-radius:50%;display:inline-block;flex:0 0 auto}' +
    '.amt{font-size:24px;font-weight:800;margin:4px 0 2px;color:#12151b}.amt.na{font-size:15px;color:#b23b3b}' +
    '.basis,.reason{font-size:11px;color:#4b5563}.conf{font-size:11px;font-weight:700;margin-top:2px}' +
    '.conf.high{color:#1a7f4b}.conf.medium{color:#8a5a00}.conf.low{color:#b23b3b}.conf.none{color:#5b6472}' +
    '.assum{margin:6px 0 2px}.assum summary{font-size:11px;cursor:pointer;color:#4b5563}' +
    '.assum ul{margin:6px 0 0;padding-left:16px}.assum li{font-size:11px;margin:2px 0;color:#4b5563}' +
    '.sim{display:inline-block;margin-top:8px;font-size:11px;color:#1e5aa8;text-decoration:none;font-weight:600}' +
    '.sim:hover{text-decoration:underline}' +
    '.foot{padding:8px 12px;font-size:10.5px;color:#5b6472;border-top:1px solid #e2e6ec}' +
    '.vehicle{font-size:11px;color:#4b5563;margin-bottom:2px}' +
    '.min{display:none}.panel.collapsed .body,.panel.collapsed .foot{display:none}' +
    '.tag{font-size:10px;font-weight:700;color:#8a5a00;background:#fdf3dd;border-radius:20px;padding:1px 7px}' +
    '@media (prefers-color-scheme:dark){' +
      '.panel{background:#171b21;color:#e7ebf0;border-color:#2a3038}' +
      '.head{background:#0f1318}.head b{color:#f2f5f8}.head .reg{color:#aab4c2}' +
      '.card{background:#1e242c;border-color:#333b45}' +
      '.kind{color:#cbd3de}.amt{color:#f4f7fa}' +
      '.basis,.reason,.vehicle,.assum summary,.assum li{color:#a9b3c0}' +
      '.conf.high{color:#4ec98a}.conf.medium{color:#e0b34d}.conf.low{color:#f08a8a}.conf.none{color:#9aa4b2}' +
      '.sim{color:#7bb4ec}.foot{color:#98a2b0;border-top-color:#2a3038}' +
      '.tag{color:#f0d68a;background:#3a2f12}}';

  function render(all, vehicle, region) {
    var host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement("div");
      host.id = HOST_ID;
      document.documentElement.appendChild(host);
      host.attachShadow({ mode: "open" });
    }
    var shadow = host.shadowRoot;
    var vLine = [vehicle.title, vehicle.fuelRaw, vehicle.powerKw ? vehicle.powerKw + " kW" : null,
      vehicle.co2 != null ? vehicle.co2 + " g/km" : "CO2 n/a", vehicle.firstRegistration]
      .filter(Boolean).join(" &middot; ");

    shadow.innerHTML =
      '<style>' + CSS + '</style>' +
      '<div class="panel" part="panel">' +
        '<div class="head" id="hd"><b>BIV + Rijtaks <span class="tag">estimate</span></b>' +
          '<span class="reg">' + esc(REGION_LABEL[region] || region) + '</span></div>' +
        '<div class="body">' +
          '<div class="vehicle">' + vLine + '</div>' +
          taxCard("BIV (one-off)", all.biv) +
          taxCard("Rijtaks (annual)", all.rijtaks) +
        '</div>' +
        '<div class="foot">Estimate only, not an official assessment. The regional tax office sets the binding amount from the certificate of conformity. Tariffs v' + esc(all.tariffVersion) + '. Change region in the extension options.</div>' +
      '</div>';

    var head = shadow.getElementById("hd");
    var panel = shadow.querySelector(".panel");
    head.addEventListener("click", function () { panel.classList.toggle("collapsed"); });
  }

  function remove() {
    var host = document.getElementById(HOST_ID);
    if (host) host.remove();
  }

  root.BivBadge = { render: render, remove: remove };
})(typeof globalThis !== "undefined" ? globalThis : this);

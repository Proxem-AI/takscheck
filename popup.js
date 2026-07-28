/*
 * Toolbar popup logic (Iris QA D1). Status line reads the per-tab match state
 * from the action badge text (set by sw.js when a car ad is detected). The
 * region switcher writes to the same chrome.storage.sync key as the options page
 * and the content scripts; the plate tag and the simulator link follow it. The
 * chrome labels stay English as mocked; the region name and language value are
 * localised NL / FR to match the badge.
 */
(function () {
  "use strict";

  var PLATE = {
    nl: { flanders: "VLAANDEREN", brussels: "BRUSSEL", wallonia: "WALLONIË" },
    fr: { flanders: "FLANDRE", brussels: "BRUXELLES", wallonia: "WALLONIE" }
  };

  var STORE = null;
  try {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.sync) STORE = chrome.storage.sync;
  } catch (e) { STORE = null; }

  var lang = "nl";
  var region = "flanders";
  var tariffs = null;

  var el = {
    stat: document.getElementById("stat"),
    statText: document.getElementById("statText"),
    plateReg: document.getElementById("plateReg"),
    regionSwitch: document.getElementById("regionSwitch"),
    langVal: document.getElementById("langVal"),
    settingsLink: document.getElementById("settingsLink"),
    simLink: document.getElementById("simLink")
  };

  function detectLang() {
    var n = "";
    try { n = (navigator.language || "").toLowerCase(); } catch (e) {}
    return n.indexOf("fr") === 0 ? "fr" : "nl";
  }

  function plateName() {
    return (PLATE[lang] || PLATE.nl)[region] || String(region).toUpperCase();
  }

  function simUrl() {
    if (tariffs && tariffs.simulatorUrls && tariffs.simulatorUrls[region]) return tariffs.simulatorUrls[region];
    return "";
  }

  function paint() {
    el.plateReg.textContent = plateName();
    el.regionSwitch.value = region;
    el.langVal.textContent = lang.toUpperCase();
    var url = simUrl();
    if (url) { el.simLink.href = url; el.simLink.removeAttribute("aria-disabled"); }
    else { el.simLink.href = "#"; }
  }

  function setStatus(matched) {
    if (matched) {
      el.stat.classList.remove("off");
      el.statText.textContent = "Active on this ad";
    } else {
      el.stat.classList.add("off");
      el.statText.textContent = "No car ad detected";
    }
  }

  // Options page URL for the settings link.
  try {
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL) {
      el.settingsLink.href = chrome.runtime.getURL("options.html");
    }
  } catch (e) {}
  el.settingsLink.addEventListener("click", function (e) {
    e.preventDefault();
    try {
      if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
      else chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
    } catch (err) {}
    window.close();
  });

  el.regionSwitch.addEventListener("change", function () {
    region = el.regionSwitch.value;
    if (STORE) { try { STORE.set({ region: region }); } catch (err) {} }
    paint();
  });

  // Load the tariff table (for simulator URLs), then storage, then read the
  // per-tab match state off the action badge.
  function loadTariffs() {
    return new Promise(function (resolve) {
      try {
        fetch(chrome.runtime.getURL("core/tariffs.json"))
          .then(function (r) { return r.json(); })
          .then(function (j) { tariffs = j; resolve(); })
          .catch(function () { resolve(); });
      } catch (e) { resolve(); }
    });
  }

  function loadPrefs() {
    return new Promise(function (resolve) {
      if (!STORE) { lang = detectLang(); resolve(); return; }
      STORE.get({ region: "flanders", lang: null }, function (cfg) {
        region = (cfg && cfg.region) || "flanders";
        lang = (cfg && cfg.lang) || detectLang();
        resolve();
      });
    });
  }

  function readStatus() {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        var tab = tabs && tabs[0];
        if (!tab || tab.id == null || !chrome.action || !chrome.action.getBadgeText) { setStatus(false); return; }
        chrome.action.getBadgeText({ tabId: tab.id }, function (text) {
          setStatus(!!(text && text.length > 0));
        });
      });
    } catch (e) { setStatus(false); }
  }

  Promise.all([loadTariffs(), loadPrefs()]).then(function () {
    paint();
    readStatus();
  });
})();

/*
 * Toolbar popup logic (Iris branded switcher). The popup chrome is localised
 * NL / FR from one I18N map, auto-detected and toggle-overridable, sharing the
 * same chrome.storage.local "lang" key as the badge and options page. The region
 * segments are a role="radiogroup" of real buttons; selecting one persists to
 * the same "region" key the options page and content scripts read, and updates
 * the selected segment plus the simulator link live. The status line reads the
 * per-tab match state off the action badge text set by sw.js.
 */
(function () {
  "use strict";

  // Iris switcher region codes map to the shared storage region values.
  var REG_TO_STORE = { vl: "flanders", br: "brussels", wa: "wallonia" };
  var STORE_TO_REG = { flanders: "vl", brussels: "br", wallonia: "wa" };

  var I18N = {
    nl: {
      status_on: "Actief op deze advertentie",
      status_off: "Open een auto-advertentie",
      region: "Regio",
      language: "Taal",
      settings: "Instellingen",
      simulator: "Officiële simulator",
      reg: { vl: "VLAANDEREN", br: "BRUSSEL", wa: "WALLONIË" },
      unval: "Voor deze regio toont TaksCheck geen bedragen: de berekening is nog niet getoetst aan een officiële bron.",
      note: [
        "TaksCheck schat de BIV en de jaarlijkse verkeersbelasting op basis van de gegevens in de advertentie. Het is geen officiële aanslag en geen fiscaal advies. Advertenties zijn soms onvolledig, en de tarieven worden elk jaar op 1 juli geïndexeerd. Wat u werkelijk betaalt, bepaalt de Vlaamse Belastingdienst op basis van het gelijkvormigheidsattest van het voertuig. Controleer de officiële simulator voordat u koopt.",
        "TaksCheck is een onafhankelijk hulpmiddel van Proxem AI, zonder band met de Vlaamse Belastingdienst, AutoScout24 of mobile.de."
      ]
    },
    fr: {
      status_on: "Actif sur cette annonce",
      status_off: "Ouvrez une annonce auto",
      region: "Région",
      language: "Langue",
      settings: "Paramètres",
      simulator: "Simulateur officiel",
      reg: { vl: "FLANDRE", br: "BRUXELLES", wa: "WALLONIE" },
      unval: "Pour cette région, TaksCheck n'affiche pas de montants: le calcul n'a pas encore été confronté à une source officielle.",
      note: [
        "TaksCheck estime la taxe de mise en circulation et la taxe de circulation annuelle à partir des données de l'annonce. Ce n'est pas un avis d'imposition officiel ni un conseil fiscal. Les annonces sont parfois incomplètes, et les tarifs sont indexés chaque année au 1er juillet. Le montant réellement dû est fixé par l'administration fiscale flamande (Vlaamse Belastingdienst) sur la base du certificat de conformité du véhicule. Vérifiez le simulateur officiel avant d'acheter.",
        "TaksCheck est un outil indépendant de Proxem AI, sans lien avec le Vlaamse Belastingdienst, AutoScout24 ou mobile.de."
      ]
    }
  };

  var STORE = null;
  try {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) STORE = chrome.storage.local;
  } catch (e) { STORE = null; }

  var lang = "nl";
  var reg = "vl";
  var matched = false;
  var tariffs = null;

  var pop = document.querySelector(".pop");
  var el = {
    stat: document.getElementById("stat"),
    rsw: document.getElementById("rsw"),
    segs: Array.prototype.slice.call(document.querySelectorAll(".seg")),
    langBtns: Array.prototype.slice.call(document.querySelectorAll("[data-set-lang]")),
    settingsLink: document.getElementById("settingsLink"),
    simLink: document.getElementById("simLink"),
    note: document.getElementById("note"),
    unval: document.getElementById("unval")
  };

  // Which regions v1 stands behind, read from core/tariffs.json so the popup and
  // the engine cannot disagree about it.
  function isValidated(code) {
    var list = tariffs && tariffs.scope && tariffs.scope.validatedRegions;
    if (!list) return true;
    return list.indexOf(REG_TO_STORE[code]) !== -1;
  }

  function L() { return I18N[lang] || I18N.nl; }

  function detectLang() {
    var n = "";
    try { n = (navigator.language || "").toLowerCase(); } catch (e) {}
    return n.indexOf("fr") === 0 ? "fr" : "nl";
  }

  function simUrl() {
    var store = REG_TO_STORE[reg];
    if (tariffs && tariffs.simulatorUrls && tariffs.simulatorUrls[store]) return tariffs.simulatorUrls[store];
    return "";
  }

  function localise() {
    var t = L();
    pop.setAttribute("data-lang", lang);
    document.documentElement.lang = lang;
    pop.querySelectorAll("[data-i18n]").forEach(function (node) {
      var k = node.getAttribute("data-i18n");
      if (k === "status") { node.textContent = matched ? t.status_on : t.status_off; }
      else { node.textContent = t[k]; }
    });
    el.segs.forEach(function (s) { s.textContent = t.reg[s.getAttribute("data-reg")]; });
    el.rsw.setAttribute("aria-label", t.region);
    el.note.innerHTML = "";
    t.note.forEach(function (para) {
      var node = document.createElement("p");
      node.textContent = para;
      el.note.appendChild(node);
    });
    el.unval.textContent = t.unval;
    el.langBtns.forEach(function (b) { b.classList.toggle("on", b.getAttribute("data-set-lang") === lang); });
  }

  function paintRegion() {
    pop.setAttribute("data-region", reg);
    el.segs.forEach(function (s) {
      var code = s.getAttribute("data-reg");
      var on = code === reg;
      s.classList.toggle("sel", on);
      s.classList.toggle("unval", !isValidated(code));
      s.setAttribute("aria-checked", on ? "true" : "false");
    });
    el.unval.hidden = isValidated(reg);
    var url = simUrl();
    if (url) { el.simLink.href = url; el.simLink.removeAttribute("aria-disabled"); }
    else { el.simLink.href = "#"; }
  }

  function setStatus(on) {
    matched = !!on;
    el.stat.classList.toggle("on", matched);
    el.stat.classList.toggle("off", !matched);
    localise();
  }

  // Settings link opens the options page.
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

  // Region segments: select, persist to the shared storage key, update live.
  el.segs.forEach(function (s) {
    s.addEventListener("click", function () {
      reg = s.getAttribute("data-reg");
      if (STORE) { try { STORE.set({ region: REG_TO_STORE[reg] }); } catch (err) {} }
      paintRegion();
    });
  });

  // Language toggle: sticks to the same storage key as the badge.
  el.langBtns.forEach(function (b) {
    b.addEventListener("click", function () {
      var next = b.getAttribute("data-set-lang");
      if (next === lang) return;
      lang = next;
      if (STORE) { try { STORE.set({ lang: lang }); } catch (err) {} }
      localise();
    });
  });

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
        var storeReg = (cfg && cfg.region) || "flanders";
        reg = STORE_TO_REG[storeReg] || "vl";
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
    localise();
    paintRegion();
    readStatus();
  });
})();

/*
 * Options page logic. Region selection persists to chrome.storage.sync (shared
 * with the content scripts), and the page is localised NL / FR with the same
 * auto-detect-plus-toggle model as the on-ad badge (the lang preference is the
 * same chrome.storage key the badge writes). Region plate tags reuse the badge's
 * plate motif so the setting reads as connected to what shows on the ad.
 */
(function () {
  "use strict";

  var REGIONS = ["flanders", "brussels", "wallonia"];

  var I18N = {
    nl: {
      title: "TaksCheck - Instellingen",
      sub: "Schattingen van de Belgische autobelasting op auto-advertenties van AutoScout24 en mobile.de.",
      regionHeading: "Belastingregio",
      regionNote: "De Belgische autobelasting wordt bepaald door het officiële adres van de houder, niet door waar de auto verkocht wordt. Kies je regio.",
      regions: {
        flanders: { name: "Vlaanderen", desc: "CO2-formule (BIV, gevalideerd). Standaard.", plate: "VLAANDEREN" },
        brussels: { name: "Brussel", desc: "Klassieke tabel fiscale pk / kW. Geen CO2.", plate: "BRUSSEL" },
        wallonia: { name: "Wallonië", desc: "Hervormd 2025: kW x CO2 x massa x energie.", plate: "WALLONIË" }
      },
      saved: "Opgeslagen. Herlaad de advertentie om bij te werken.",
      unvalidated: "Nog niet gevalideerd",
      unvalidatedNote: "Voor deze regio toont TaksCheck geen bedragen: de berekening is nog niet getoetst aan een officiële bron. Je krijgt een link naar de officiële simulator van de regio.",
      disc: [
        "TaksCheck schat de BIV en de jaarlijkse verkeersbelasting op basis van de gegevens in de advertentie. Het is geen officiële aanslag en geen fiscaal advies. Advertenties zijn soms onvolledig, en de tarieven worden elk jaar op 1 juli geïndexeerd. Wat u werkelijk betaalt, bepaalt de Vlaamse Belastingdienst op basis van het gelijkvormigheidsattest van het voertuig. Controleer de officiële simulator voordat u koopt.",
        "TaksCheck is een onafhankelijk hulpmiddel van Proxem AI, zonder band met de Vlaamse Belastingdienst, AutoScout24 of mobile.de."
      ]
    },
    fr: {
      title: "TaksCheck - Paramètres",
      sub: "Estimations de la taxe automobile belge sur les annonces AutoScout24 et mobile.de.",
      regionHeading: "Région fiscale",
      regionNote: "La taxe automobile belge est déterminée par l'adresse officielle du titulaire, pas par le lieu de vente. Choisissez votre région.",
      regions: {
        flanders: { name: "Flandre", desc: "Formule CO2 (TMC, validée). Par défaut.", plate: "FLANDRE" },
        brussels: { name: "Bruxelles", desc: "Table classique puissance fiscale / kW. Sans CO2.", plate: "BRUXELLES" },
        wallonia: { name: "Wallonie", desc: "Réformée 2025: kW x CO2 x masse x énergie.", plate: "WALLONIE" }
      },
      saved: "Enregistré. Rechargez l'annonce pour mettre à jour.",
      unvalidated: "Pas encore validé",
      unvalidatedNote: "Pour cette région, TaksCheck n'affiche pas de montants: le calcul n'a pas encore été confronté à une source officielle. Vous recevez un lien vers le simulateur officiel de la région.",
      disc: [
        "TaksCheck estime la taxe de mise en circulation et la taxe de circulation annuelle à partir des données de l'annonce. Ce n'est pas un avis d'imposition officiel ni un conseil fiscal. Les annonces sont parfois incomplètes, et les tarifs sont indexés chaque année au 1er juillet. Le montant réellement dû est fixé par l'administration fiscale flamande (Vlaamse Belastingdienst) sur la base du certificat de conformité du véhicule. Vérifiez le simulateur officiel avant d'acheter.",
        "TaksCheck est un outil indépendant de Proxem AI, sans lien avec le Vlaamse Belastingdienst, AutoScout24 ou mobile.de."
      ]
    }
  };

  var STORE = null;
  try {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.sync) STORE = chrome.storage.sync;
  } catch (e) { STORE = null; }

  var lang = "nl";
  var region = "flanders";
  var savedTimer = null;
  // Which regions v1 stands behind. Read from core/tariffs.json rather than
  // repeated here, so this page and the engine can never disagree about it.
  var validated = null;

  function isValidated(key) {
    return !validated || validated.indexOf(key) !== -1;
  }

  function detectLang() {
    var n = "";
    try { n = (navigator.language || "").toLowerCase(); } catch (e) {}
    return n.indexOf("fr") === 0 ? "fr" : "nl";
  }

  function L() { return I18N[lang] || I18N.nl; }

  var el = {
    title: document.getElementById("pgTitle"),
    sub: document.getElementById("sub"),
    regionHeading: document.getElementById("regionHeading"),
    regionNote: document.getElementById("regionNote"),
    regions: document.getElementById("regions"),
    saved: document.getElementById("saved"),
    disc: document.getElementById("disc"),
    toggle: document.getElementById("langToggle")
  };

  function plate(name) {
    return '<span class="fplate"><span class="eu">B</span><span class="rg">' + name + "</span></span>";
  }

  function renderRegions() {
    var t = L();
    var html = REGIONS.map(function (key) {
      var r = t.regions[key];
      var sel = key === region ? " sel" : "";
      var checked = key === region ? " checked" : "";
      var ok = isValidated(key);
      var tag = ok ? "" : '<span class="funval">' + t.unvalidated + "</span>";
      return '<label class="frow' + sel + (ok ? "" : " unval") + '" data-region="' + key + '">' +
        '<input type="radio" name="region" value="' + key + '"' + checked + '>' +
        '<span class="ftext"><b>' + r.name + tag + '</b><span class="rs">' +
          (ok ? r.desc : t.unvalidatedNote) + "</span></span>" +
        plate(r.plate) +
      "</label>";
    }).join("");
    el.regions.innerHTML = html;

    Array.prototype.forEach.call(el.regions.querySelectorAll('input[name="region"]'), function (input) {
      input.addEventListener("change", function () {
        if (!input.checked) return;
        region = input.value;
        updateSelected();
        if (STORE) {
          STORE.set({ region: region }, function () { showSaved(); });
        } else { showSaved(); }
      });
    });
  }

  function updateSelected() {
    Array.prototype.forEach.call(el.regions.querySelectorAll(".frow"), function (row) {
      var on = row.getAttribute("data-region") === region;
      row.classList.toggle("sel", on);
      var input = row.querySelector("input");
      if (input) input.checked = on;
    });
  }

  function showSaved() {
    el.saved.textContent = L().saved;
    el.saved.hidden = false;
    if (savedTimer) clearTimeout(savedTimer);
    savedTimer = setTimeout(function () { el.saved.hidden = true; }, 2600);
  }

  function render() {
    var t = L();
    document.documentElement.lang = lang;
    el.title.textContent = t.title;
    el.sub.textContent = t.sub;
    el.regionHeading.textContent = t.regionHeading;
    el.regionNote.textContent = t.regionNote;
    el.disc.innerHTML = "";
    t.disc.forEach(function (para) {
      var pEl = document.createElement("p");
      pEl.textContent = para;
      el.disc.appendChild(pEl);
    });
    el.saved.hidden = true;
    Array.prototype.forEach.call(el.toggle.querySelectorAll("button"), function (b) {
      b.classList.toggle("on", b.getAttribute("data-lang") === lang);
    });
    renderRegions();
  }

  el.toggle.addEventListener("click", function (e) {
    var b = e.target.closest("button[data-lang]");
    if (!b) return;
    var next = b.getAttribute("data-lang");
    if (next === lang) return;
    lang = next;
    if (STORE) { try { STORE.set({ lang: lang }); } catch (err) {} }
    render();
  });

  function loadScope() {
    return new Promise(function (resolve) {
      try {
        fetch(chrome.runtime.getURL("core/tariffs.json"))
          .then(function (r) { return r.json(); })
          .then(function (j) { validated = (j && j.scope && j.scope.validatedRegions) || null; resolve(); })
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

  Promise.all([loadScope(), loadPrefs()]).then(render);
})();

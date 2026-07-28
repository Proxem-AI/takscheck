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
      disc: "De bedragen zijn informatieve schattingen, geen officiële aanslagen. Het bindende bedrag wordt bepaald door de gewestelijke belastingdienst op basis van het gelijkvormigheidsattest van het voertuig."
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
      disc: "Les montants sont des estimations informatives, pas des avis d'imposition officiels. Le montant contraignant est fixé par l'administration fiscale régionale sur la base du certificat de conformité du véhicule."
    }
  };

  var STORE = null;
  try {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.sync) STORE = chrome.storage.sync;
  } catch (e) { STORE = null; }

  var lang = "nl";
  var region = "flanders";
  var savedTimer = null;

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
      return '<label class="frow' + sel + '" data-region="' + key + '">' +
        '<input type="radio" name="region" value="' + key + '"' + checked + '>' +
        '<span class="ftext"><b>' + r.name + '</b><span class="rs">' + r.desc + "</span></span>" +
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
    el.disc.textContent = t.disc;
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

  // Load persisted region + language, then paint.
  if (STORE) {
    STORE.get({ region: "flanders", lang: null }, function (cfg) {
      region = (cfg && cfg.region) || "flanders";
      lang = (cfg && cfg.lang) || detectLang();
      render();
    });
  } else {
    lang = detectLang();
    render();
  }
})();

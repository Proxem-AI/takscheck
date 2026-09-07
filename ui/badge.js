/*
 * TaksCheck on-ad badge renderer. Implements Iris's approved identity
 * (2026-07-27, light header) inside a style-isolated Shadow DOM overlay.
 * Driven by the shared engine result:
 *   { region, tariffVersion, biv:{...}, rijtaks:{...} }
 *
 * Identity: white panel, light header (#F1F4F8), ink + ruby "TaksCheck"
 * wordmark, the Belgian-plate mark with a soft drop-shadow, euro figures in
 * tabular mono, region plate tag in the footer, and a traffic-light verdict
 * pill (low = green, medium = amber, high = red) that carries its own status
 * colour. Brand marks stay blue #1B54C7 + ruby #841922, plus neutrals; the
 * verdict red is a brighter status red, kept distinct from the brand ruby.
 *
 * Bilingual: auto-detects NL / FR (default NL), with a manual toggle in the
 * header persisted to chrome.storage.local. The key label sits in a fixed
 * two-line slot so the longer French wording never reflows the euro columns.
 *
 * Keeps the public contract: root.BivBadge.render(all, vehicle, region).
 */
(function (root) {
  "use strict";

  var HOST_ID = "takscheck-host";
  var STORE = null;
  try {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) STORE = chrome.storage.local;
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
      estimated: "Sommige waarden zijn geschat. Het werkelijke bedrag kan afwijken; controleer de officiële simulator.",
      sim: "Officiële simulator",
      nodata: "Onvoldoende gegevens",
      needs: function (tax, token) { return tax + " heeft " + token + " nodig, niet vermeld in deze advertentie."; },
      disclaimer: "Schatting op basis van deze advertentie. Geen officiële aanslag.",
      vintage: function (d) { return "Tarieven van " + d + "."; },
      stale: function (d) { return "Let op: deze tarieven zijn van " + d + " en zijn sindsdien geïndexeerd. Het werkelijke bedrag is daardoor waarschijnlijk hoger. Controleer de officiële simulator voor het actuele bedrag."; },
      expired: function (d) { return "TaksCheck toont geen bedragen meer: de tarieven van " + d + " zijn te oud. Gebruik de officiële simulator."; },
      notValidated: "Nog niet gevalideerd voor deze regio. Gebruik de officiële simulator van deze regio.",
      novalidation: "Niet gevalideerd",
      noamount: "Niet meer getoond",
      changeRegion: "Regio wijzigen",
      co2na: "CO2 onbekend",
      months: ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"],
      tokens: { co2: "de CO2-waarde", power: "het vermogen (kW)", cc: "de cilinderinhoud (cc)", data: "meer gegevens" },
      // Caption per Lex's pre-publication review, 2026-09-06. The meter measures
      // how complete the ADVERT was, which is all it can measure; "Nauwkeurigheid"
      // turned that into a claim about how close the figure is to the right
      // answer, which is the one thing it cannot know. On 2 September the advert
      // was complete, the meter correctly read complete, and the caption turned
      // that into "accuracy: high" beside a figure that was 42 per cent wrong.
      // Wording about the input can never vouch for a number it cannot check.
      conf: {
        caption: "Gegevens uit de advertentie",
        tier: { high: "volledig", medium: "deels geschat", low: "grotendeels geschat" },
        aria: {
          high: "Gegevens uit de advertentie: volledig",
          medium: "Gegevens uit de advertentie: deels geschat",
          low: "Gegevens uit de advertentie: grotendeels geschat"
        }
      },
      expander: {
        label: "Waarom dit bedrag?",
        intro: "Deze schatting steunt op enkele aannames:",
        src: { biv: "BIV", rij: "Rijtaks" }
      },
      genericReason: "Enkele waarden zijn geschat"
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
      needs: function (tax, token) { return tax + " nécessite " + token + ", que cette annonce ne mentionne pas."; },
      disclaimer: "Estimation basée sur cette annonce. Pas un avis d'imposition officiel.",
      vintage: function (d) { return "Tarifs du " + d + "."; },
      stale: function (d) { return "Attention: ces tarifs datent du " + d + " et ont été indexés depuis. Le montant réel est donc probablement plus élevé. Vérifiez le simulateur officiel pour le montant actuel."; },
      expired: function (d) { return "TaksCheck n'affiche plus de montants: les tarifs du " + d + " sont trop anciens. Utilisez le simulateur officiel."; },
      notValidated: "Pas encore validé pour cette région. Utilisez le simulateur officiel de cette région.",
      novalidation: "Non validé",
      noamount: "Plus affiché",
      changeRegion: "Changer de région",
      co2na: "CO2 inconnu",
      months: ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"],
      tokens: { co2: "la valeur CO2", power: "la puissance (kW)", cc: "la cylindrée (cc)", data: "plus de données" },
      conf: {
        caption: "Données de l'annonce",
        tier: { high: "complètes", medium: "partiellement estimées", low: "largement estimées" },
        aria: {
          high: "Données de l'annonce: complètes",
          medium: "Données de l'annonce: partiellement estimées",
          low: "Données de l'annonce: largement estimées"
        }
      },
      expander: {
        label: "Pourquoi ce montant?",
        intro: "Cette estimation repose sur quelques hypothèses:",
        src: { biv: "TMC", rij: "Circ." }
      },
      genericReason: "Certaines valeurs sont estimées"
    }
  };

  // Presentation-layer localisation of the engine's English assumption strings.
  // The engine (core/tax.js) is never touched; every assumption it can push is
  // matched here (interpolated values captured by the regex) and rendered as a
  // short, plain NL / FR reason. Anything unmatched falls back to genericReason.
  var ASSUMPTION_RULES = [
    // --- fiscal HP (deriveFiscalHp) ---
    { re: /^fiscal HP taken from the ad/,
      nl: "Fiscale pk uit de advertentie", fr: "Puissance fiscale reprise de l'annonce" },
    { re: /^EV fiscal HP estimated from kW/,
      nl: "Fiscale pk geschat uit kW (benaderende tabel)", fr: "Puissance fiscale estimée d'après les kW (table approximative)" },
    { re: /^fiscal HP derived from cc/,
      nl: "Fiscale pk afgeleid uit de cilinderinhoud", fr: "Puissance fiscale déduite de la cylindrée" },
    { re: /^fiscal HP roughly estimated from kW/,
      nl: "Fiscale pk ruw geschat uit kW (cilinderinhoud ontbreekt)", fr: "Puissance fiscale estimée grossièrement d'après les kW (cylindrée absente)" },
    { re: /^no displacement or fiscal HP/,
      nl: "Geen cilinderinhoud of fiscale pk beschikbaar", fr: "Ni cylindrée ni puissance fiscale disponibles" },
    // --- MMA (defaultMma) ---
    { re: /^MMA taken from the ad/,
      nl: "Maximale massa uit de advertentie", fr: "Masse maximale reprise de l'annonce" },
    { re: /^MMA approximated as kerb weight \+ (\d+) kg/,
      nl: function (m) { return "Maximale massa geschat als leeggewicht + " + m[1] + " kg lading"; },
      fr: function (m) { return "Masse maximale estimée: poids à vide + " + m[1] + " kg de charge"; } },
    { re: /^MMA defaulted from body type/,
      nl: "Maximale massa afgeleid uit het carrosserietype", fr: "Masse maximale déduite du type de carrosserie" },
    // --- Flanders BIV (bivFlanders) ---
    { re: /^EV\/hydrogen first registered before (\d+)/,
      nl: function (m) { return "Elektrisch/waterstof van voor " + m[1] + ": historische BIV-vrijstelling"; },
      fr: function (m) { return "Électrique/hydrogène immatriculé avant " + m[1] + ": exonération TMC historique"; } },
    { re: /^new EV\/hydrogen: flat BIV since 1 Jan (\d+)/,
      nl: function (m) { return "Nieuwe EV/waterstof: forfaitaire BIV sinds 1 jan " + m[1]; },
      fr: function (m) { return "Électrique/hydrogène neuf: TMC forfaitaire depuis le 1 jan " + m[1]; } },
    { re: /^unknown fuel, using fuel factor/,
      nl: "Onbekende brandstof, standaard brandstoffactor gebruikt", fr: "Carburant inconnu, facteur carburant par défaut" },
    { re: /^Euro (\d+) inferred from (?:the )?first-registration date/,
      nl: function (m) { return "Euronorm " + m[1] + " afgeleid uit de eerste inschrijving"; },
      fr: function (m) { return "Norme Euro " + m[1] + " déduite de la première immatriculation"; } },
    { re: /^pre-2018 car: CO2 treated as NEDC/,
      nl: "Auto van voor 2018: CO2 als NEDC gebruikt", fr: "Voiture d'avant 2018: CO2 traité comme NEDC" },
    { re: /^2018 transition-window registration/,
      nl: "Inschrijving in de overgangsperiode 2018: WLTP aangenomen voor CO2", fr: "Immatriculation dans la fenêtre de transition 2018: WLTP supposé pour le CO2" },
    { re: /^air component defaulted to Euro 6/,
      nl: "Luchtcomponent standaard op Euro 6", fr: "Composante air par défaut sur Euro 6" },
    { re: /^PHEV taxed by the CO2 formula/,
      nl: "Plug-inhybride belast op de CO2 zoals een benzinewagen", fr: "Hybride rechargeable taxé sur le CO2 comme une essence" },
    // --- no first-registration date (BIV / Brussels / Wallonia) ---
    { re: /^no first-registration date: assuming/,
      nl: "Geen datum eerste inschrijving: nieuwe auto aangenomen", fr: "Date de première immatriculation absente: voiture neuve supposée" },
    // --- Brussels TMC (tmcBrussels) ---
    { re: /^electric\/hydrogen: flat TMC/,
      nl: "Elektrisch/waterstof: forfaitaire BIV", fr: "Électrique/hydrogène: TMC forfaitaire" },
    // --- Wallonia TMC (tmcWallonia) ---
    { re: /^2018 transition window: WLTP divisor/,
      nl: "Overgangsperiode 2018: WLTP-deler aangenomen", fr: "Fenêtre de transition 2018: diviseur WLTP supposé" },
    { re: /^(WLTP|NEDC) CO2 assumed, divisor X/,
      nl: function (m) { return m[1] + "-CO2 aangenomen"; },
      fr: function (m) { return "CO2 " + m[1] + " supposé"; } },
    // --- Flanders road tax (roadTaxFlandersModel) ---
    { re: /^LPG: reduced base road tax \+ AVB supplement/,
      nl: "LPG: verlaagde basis + AVB-supplement", fr: "LPG: base réduite + supplément" },
    { re: /^validated Flemish model:/,
      nl: "Berekend met het gevalideerde Vlaamse model", fr: "Calculé avec le modèle flamand validé" },
    // --- road tax EV / oldtimer / region modifiers (roadTax) ---
    { re: /^electric\/hydrogen: exempt from Brussels road tax/,
      nl: "Elektrisch/waterstof: vrijgesteld van Brusselse rijtaks", fr: "Électrique/hydrogène: exonéré de la taxe de circulation bruxelloise" },
    { re: /^EV first registered before (\d+)/,
      nl: function (m) { return "EV van voor " + m[1] + ": rijtaksvrijstelling behouden"; },
      fr: function (m) { return "Électrique immatriculé avant " + m[1] + ": exonération de circulation maintenue"; } },
    { re: /^new EV: flat Flemish road tax/,
      nl: "Nieuwe EV: forfaitaire Vlaamse rijtaks", fr: "Électrique neuf: taxe de circulation flamande forfaitaire" },
    { re: /^EV: reduced Walloon forfait/,
      nl: "EV: verlaagd Waals forfait", fr: "Électrique: forfait wallon réduit" },
    { re: /^oldtimer \((\d+)y\+\): flat Flemish rate/,
      nl: function (m) { return "Oldtimer (" + m[1] + " jaar+): vast Vlaams tarief"; },
      fr: function (m) { return "Ancêtre (" + m[1] + " ans+): tarif flamand forfaitaire"; } },
    { re: /^oldtimer \((\d+)y\+\): flat Walloon rate/,
      nl: function (m) { return "Oldtimer (" + m[1] + " jaar+): vast Waals tarief"; },
      fr: function (m) { return "Ancêtre (" + m[1] + " ans+): tarif wallon forfaitaire"; } },
    { re: /^Walloon diesel surcharge \+(\d+)%/,
      nl: function (m) { return "Waalse dieseltoeslag +" + m[1] + "%"; },
      fr: function (m) { return "Surtaxe diesel wallonne +" + m[1] + "%"; } },
    { re: /^Brussels LPG supplement \+(\S+)/,
      nl: function (m) { return "Brusselse LPG-toeslag +" + m[1]; },
      fr: function (m) { return "Supplément LPG bruxellois +" + m[1]; } },
    { re: /^representative fiscal-HP scale/,
      nl: "Indicatieve fiscale-pk-schaal, alles inbegrepen", fr: "Barème indicatif de puissance fiscale, tout compris" }
  ];

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

  // "2026-07-01" -> "1 juli 2026" / "1er juillet 2026". Always derived from the
  // window the engine selected, never hardcoded: a hardcoded label would keep
  // reading "1 juli 2026" after the JSON was updated, which is the same class of
  // defect one layer up.
  function longDate(iso) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
    var y = iso.slice(0, 4), m = +iso.slice(5, 7), d = +iso.slice(8, 10);
    var name = (L().months || [])[m - 1] || String(m);
    if (lang() === "fr") return (d === 1 ? "1er" : d) + " " + name + " " + y;
    return d + " " + name + " " + y;
  }

  // One vintage for the whole panel. computeAll aggregates it; a caller that
  // passes a bare result set still gets a sensible answer from the figures.
  function panelVintage(all) {
    if (all && all.dataVintage) return all.dataVintage;
    var rank = { current: 0, stale: 1, expired: 2 };
    var worst = null;
    ["biv", "rijtaks"].forEach(function (k) {
      var v = all && all[k] && all[k].dataVintage;
      if (!v) return;
      if (!worst || rank[v.status] > rank[worst.status]) worst = v;
    });
    return worst;
  }

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

  // Inject the bundled IBM Plex Mono faces once into the page document so the
  // Shadow DOM can match the family by name (@font-face is document-scoped and
  // resolvable from inside the shadow tree). font-display:swap keeps the euro
  // figures visible in the SF Mono fallback until the woff2 loads. Files ship
  // under fonts/ and are listed in the manifest web_accessible_resources. Plex
  // Mono is a static family, so only the real cuts are declared: 600 SemiBold
  // (euro amount) and 700 Bold (plate + source tag).
  var FONTS_INJECTED = false;
  function ensureFonts() {
    if (FONTS_INJECTED) return;
    FONTS_INJECTED = true;
    try {
      if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.getURL) return;
      var semibold = chrome.runtime.getURL("fonts/IBMPlexMono-SemiBold.woff2");
      var bold = chrome.runtime.getURL("fonts/IBMPlexMono-Bold.woff2");
      var css =
        '@font-face{font-family:"IBM Plex Mono";font-style:normal;font-weight:600;' +
        'src:url("' + semibold + '") format("woff2");font-display:swap}' +
        '@font-face{font-family:"IBM Plex Mono";font-style:normal;font-weight:700;' +
        'src:url("' + bold + '") format("woff2");font-display:swap}';
      var style = document.createElement("style");
      style.id = "takscheck-fonts";
      style.textContent = css;
      (document.head || document.documentElement).appendChild(style);
    } catch (e) {}
  }

  var EXT = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M3 1h6v6M9 1 1 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  // The plate mark, exactly Iris's wordmark-lockup glyph (34x24 viewBox).
  var PLATE =
    '<svg class="tc-mark" viewBox="0 0 34 24" aria-hidden="true">' +
      '<rect x="1" y="1" width="32" height="22" rx="4.5" fill="#1B54C7"/>' +
      '<path d="M9.1 2.8 H28.5 A2.7 2.7 0 0 1 31.2 5.5 V18.5 A2.7 2.7 0 0 1 28.5 21.2 H9.1 Z" fill="#fff"/>' +
      '<path d="M12.4 12 L16.4 16 L25 6" fill="none" stroke="#841922" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>' +
    "</svg>";

  // Assumptions expander icons (Iris's question mark + chevron).
  var QIC = '<svg class="tc-qic" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M9.4 9.2a2.6 2.6 0 1 1 3.6 2.4c-.7.3-1 .8-1 1.6v.3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="17" r="1.15" fill="currentColor"/></svg>';
  var CHEV = '<svg class="tc-chev" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // Localise one engine assumption string to the current language, or fall back.
  function translateAssumption(str) {
    var s = String(str == null ? "" : str), lg = lang();
    for (var i = 0; i < ASSUMPTION_RULES.length; i++) {
      var m = s.match(ASSUMPTION_RULES[i].re);
      if (m) {
        var v = ASSUMPTION_RULES[i][lg];
        if (v == null) v = ASSUMPTION_RULES[i].nl;
        return typeof v === "function" ? v(m) : v;
      }
    }
    return L().genericReason;
  }

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
  //   low <= 250, medium <= 1500, high > 1500. Calibrated so a typical modern
  //   petrol/diesel reads "medium" and an EV flat (61.50) reads "low".
  //   Falls back to the annual figure if the one-off is unavailable.
  function verdictTier(all) {
    var b = all.biv;
    if (b && b.amount != null) {
      if (b.amount <= 250) return "low";
      if (b.amount <= 1500) return "medium";
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
    // Three different reasons for showing no figure, and they are not the same
    // thing to a reader: the advert was short of a field, the region has not
    // been validated, or the rate table is too old to stand behind.
    if (res && res.unvalidatedRegion) {
      return '<span class="tc-v tc-nd">' + esc(L().novalidation) + "</span>";
    }
    if (res && res.expired) {
      return '<span class="tc-v tc-nd">' + esc(L().noamount) + "</span>";
    }
    if (!res || res.needsMoreData || res.amount == null) {
      return '<span class="tc-v tc-nd">' + esc(L().nodata) + "</span>";
    }
    var approx = res.confidence !== "high" ? '<span class="tc-approx">' + esc(L().approx) + "</span> " : "";
    return '<span class="tc-v">' + approx + esc(euro(res.amount)) + "</span>";
  }

  // Per-result confidence tier for the meter. Only meaningful when a euro
  // figure is shown (needsMoreData / no amount -> no meter). Maps the engine's
  // tier to Iris's three-tier meter; anything unexpected reads as "low".
  function confTier(res) {
    if (!res || res.needsMoreData || res.amount == null) return null;
    var c = res.confidence;
    return c === "high" || c === "medium" || c === "low" ? c : "low";
  }

  // Iris's ascending blue signal meter + caption + tier word, one per figure.
  function confCell(res) {
    var tier = confTier(res);
    if (!tier) return "";
    var cf = L().conf;
    return '<span class="tc-conf" data-tier="' + tier + '" role="img" aria-label="' + esc(cf.aria[tier]) + '">' +
      '<span class="tc-cmeter"><i></i><i></i><i></i></span>' +
      '<span class="tc-clab"><small>' + esc(cf.caption) + "</small>" + esc(cf.tier[tier]) + "</span>" +
    "</span>";
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
    ".tc-mark{width:26px;height:18.4px;flex:none;filter:drop-shadow(0 1px 1.5px rgba(16,24,40,.22))}" +
    ".tc-name{font-weight:800;font-size:13px;letter-spacing:-.01em;color:var(--ink)}" +
    ".tc-name .c{color:var(--ruby)}" +
    ".tc-toggle{margin-left:auto;display:inline-flex;border:1px solid var(--line);border-radius:7px;overflow:hidden}" +
    ".tc-toggle button{border:0;background:transparent;color:var(--slate);padding:3px 9px;cursor:pointer;" +
      "font-weight:750;font-family:inherit;font-size:10.5px;line-height:1.4}" +
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
    ".tc-v{display:block;font-weight:600;font-size:17px;letter-spacing:-.01em;color:var(--ink);" +
      'font-family:"IBM Plex Mono",ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-variant-numeric:tabular-nums}' +
    ".tc-approx{font-family:inherit;font-size:11px;font-weight:600;color:var(--slate);letter-spacing:0}" +
    // The "not enough data" tag wraps to two lines in Dutch but one in French;
    // reserve the two-line height so the no-data card stays the same height in
    // both languages (no vertical shift on toggle), matching the euro-figure rows.
    ".tc-v.tc-nd{font-family:inherit;font-size:12px;font-weight:700;color:var(--slate);letter-spacing:0;" +
      "display:flex;align-items:center;min-height:36px}" +
    // notes
    ".tc-notes{padding:0 12px 2px}" +
    ".tc-note{font-size:12px;line-height:1.45;color:var(--slate);margin:8px 0 0}" +
    ".tc-note b{color:var(--ink);font-weight:700}" +
    ".tc-sim{display:inline-flex;align-items:center;gap:5px;margin:10px 12px 10px;font-size:12px;" +
      "font-weight:700;color:var(--blue);text-decoration:none}" +
    ".tc-sim:hover{text-decoration:underline}" +
    ".tc-sim.tc-sim-lead{background:#EFF3FC;border:1px solid rgba(27,84,199,.24);border-radius:8px;" +
      "padding:7px 10px;font-size:12.5px}" +
    // footer: region plate + verdict
    ".tc-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;" +
      "padding:9px 12px;background:var(--mist2);border-top:1px solid var(--line);margin-top:0}" +
    ".tc-plate{display:inline-flex;align-items:stretch;height:21px;border:1px solid #b9c1cb;border-radius:5px;" +
      "overflow:hidden;background:#fff;box-shadow:0 1px 0 rgba(0,0,0,.04)}" +
    ".tc-eu{background:var(--blue);color:#fff;font-size:9px;font-weight:700;" +
      'font-family:"IBM Plex Mono",ui-monospace,"SF Mono",Menlo,monospace;display:flex;align-items:center;justify-content:center;width:14px}' +
    ".tc-reg{padding:0 9px;color:var(--ink);font-weight:700;font-size:11px;letter-spacing:.06em;" +
      'display:flex;align-items:center;font-family:"IBM Plex Mono",ui-monospace,"SF Mono",Menlo,monospace}' +
    // Traffic-light verdict, Iris's soft treatment (2026-07-28): a pale tinted
    // pill + a coloured round dot + darker coloured text (not a solid filled
    // pill). Hexes verbatim from Iris's confidence-assumptions document, each
    // pairing AA-confirmed: green tx #14572E on bg #E3F1E8 (6.9:1), amber tx
    // #7A4E00 on bg #FBEBCF (6.1:1), red tx #841922 on bg #F3DADE (7.4:1). Dot
    // is decorative (word beside it carries the meaning), never colour-alone.
    ".tc-verdict{font-size:11px;font-weight:800;letter-spacing:.02em;padding:3px 9px 3px 8px;border-radius:6px;" +
      "white-space:nowrap;display:inline-flex;align-items:center;gap:6px}" +
    ".tc-verdict .tc-tldot{width:8px;height:8px;border-radius:50%;flex:none}" +
    ".tc-verdict.low{background:#E3F1E8;color:#14572E}" +
    ".tc-verdict.low .tc-tldot{background:#1E7A46}" +
    ".tc-verdict.medium{background:#FBEBCF;color:#7A4E00}" +
    ".tc-verdict.medium .tc-tldot{background:#C77700}" +
    ".tc-verdict.high{background:#F3DADE;color:#841922}" +
    ".tc-verdict.high .tc-tldot{background:#C0202C}" +
    // Per-figure confidence meter (Iris): ascending blue signal bars + caption +
    // tier word, blue and neutral only, never the verdict's green/amber/red, so
    // reliability is never read as tax heaviness. Fill #1B54C7 on #FFFFFF = 6.7:1.
    ".tc-conf{display:flex;align-items:flex-start;gap:5px;margin-top:6px}" +
    ".tc-cmeter{display:inline-flex;align-items:flex-end;gap:1.5px;height:11px;flex:none;margin-top:1px}" +
    ".tc-cmeter i{width:3px;border-radius:1px;background:#ccd3db}" +
    ".tc-cmeter i:nth-child(1){height:5px}" +
    ".tc-cmeter i:nth-child(2){height:8px}" +
    ".tc-cmeter i:nth-child(3){height:11px}" +
    '.tc-conf[data-tier="high"] .tc-cmeter i{background:var(--blue)}' +
    '.tc-conf[data-tier="medium"] .tc-cmeter i:nth-child(1),' +
    '.tc-conf[data-tier="medium"] .tc-cmeter i:nth-child(2){background:var(--blue)}' +
    '.tc-conf[data-tier="low"] .tc-cmeter i:nth-child(1){background:var(--blue)}' +
    // The caption wraps. "Gegevens uit de advertentie" does not fit a 159px
    // column on one line the way "Nauwkeurigheid" did, and the caption is not
    // negotiable: it is the claim the meter can actually support.
    ".tc-clab{font-size:10px;font-weight:700;color:var(--ink);letter-spacing:.005em;line-height:1.2;min-width:0}" +
    ".tc-clab small{display:block;font-size:8.5px;font-weight:600;color:var(--slate);" +
      "letter-spacing:.05em;text-transform:uppercase;line-height:1.15;margin-bottom:2px}" +
    // Assumptions expander: quiet disclosure row above the footer, closed by
    // default. Sits below the value rows so opening it never moves the figures.
    ".tc-expander-wrap{background:var(--white);border-top:1px solid var(--line)}" +
    ".tc-expander{width:100%;border:0;background:transparent;cursor:pointer;font-family:inherit;" +
      "display:flex;align-items:center;gap:8px;padding:8px 12px;color:var(--slate);" +
      "font-size:11.5px;font-weight:700;text-align:left}" +
    ".tc-expander:hover{color:var(--ink)}" +
    ".tc-qic{width:14px;height:14px;flex:none;color:var(--blue)}" +
    ".tc-chev{margin-left:auto;width:12px;height:12px;flex:none;transition:transform .18s ease}" +
    '.tc-expander[aria-expanded="true"] .tc-chev{transform:rotate(180deg)}' +
    ".tc-ex-panel{display:none;padding:2px 12px 12px}" +
    ".tc-expander-wrap.open .tc-ex-panel{display:block}" +
    ".tc-ex-intro{margin:0 0 8px;font-size:11px;color:var(--slate)}" +
    ".tc-ex-list{margin:0;padding:0;list-style:none;max-height:104px;overflow-y:auto}" +
    ".tc-ex-list li{display:flex;align-items:flex-start;gap:8px;padding:6px 0;font-size:11.5px;" +
      "color:var(--ink);line-height:1.4;border-top:1px solid var(--line)}" +
    ".tc-ex-list li:first-child{border-top:0}" +
    ".tc-ex-src{flex:none;font-family:\"IBM Plex Mono\",ui-monospace,\"SF Mono\",Menlo,Consolas,monospace;" +
      "font-size:9px;font-weight:700;letter-spacing:.03em;color:var(--slate);background:var(--mist);" +
      "border:1px solid var(--line);border-radius:5px;padding:2px 5px;margin-top:1px;min-width:34px;text-align:center}" +
    ".tc-ex-list li .tc-rz{flex:1}" +
    // disclaimer: stacked (text line, then the link line) so the taller French
    // wording lays out in the same two-line shape as Dutch. This keeps the panel
    // height language-invariant and stops the ~25px vertical shift on NL/FR
    // toggle (was a space-between row where only French wrapped the link).
    ".tc-disc{display:flex;flex-direction:column;align-items:flex-start;gap:4px;" +
      "padding:8px 12px 10px;font-size:11px;line-height:1.4;color:var(--slate)}" +
    ".tc-disc-warn{background:#FBEBCF;color:#7A4E00;border-top:1px solid #EBD6AE;font-weight:600}" +
    ".tc-opt{color:var(--blue);font-weight:700;text-decoration:none;white-space:nowrap}" +
    ".tc-opt:hover{text-decoration:underline}" +
    // collapsed
    ".tc-panel.tc-collapsed .tc-vehicle,.tc-panel.tc-collapsed .tc-rows," +
    ".tc-panel.tc-collapsed .tc-notes,.tc-panel.tc-collapsed .tc-sim," +
    ".tc-panel.tc-collapsed .tc-expander-wrap," +
    ".tc-panel.tc-collapsed .tc-foot,.tc-panel.tc-collapsed .tc-disc{display:none}";

  // The badge line is the only notice that reaches the point of reliance: the
  // person acting on the figure is looking at a car advert, not at the README.
  // Wording is Lex's, verbatim, 2026-09-06. The vintage clause is generated from
  // the window the engine selected.
  function buildDisclaimer(all) {
    var v = panelVintage(all);
    var t = L();
    var date = v && v.from ? longDate(v.from) : "";
    var status = v ? v.status : "current";
    var cls = "tc-disc";
    var text;
    if (status === "expired" && date) { text = t.expired(date); cls += " tc-disc-warn"; }
    else if (status === "stale" && date) { text = t.stale(date); cls += " tc-disc-warn"; }
    else { text = date ? t.disclaimer + " " + t.vintage(date) : t.disclaimer; }
    return '<div class="' + cls + '"><span>' + esc(text) + "</span>" +
      '<a class="tc-opt" href="' + esc(optionsHref()) + '" target="_blank" rel="noopener">' + esc(t.changeRegion) + "</a>" +
    "</div>";
  }

  function buildNotes(all) {
    var out = [];
    var anyEstimated = ["biv", "rijtaks"].some(function (k) {
      var r = all[k];
      return r && !r.needsMoreData && r.amount != null && r.confidence !== "high";
    });
    if (anyEstimated) out.push('<p class="tc-note">' + esc(L().estimated) + "</p>");
    // Both figures are blocked by the same region, so the note is rendered once.
    if (["biv", "rijtaks"].some(function (k) { return all[k] && all[k].unvalidatedRegion; })) {
      out.push('<p class="tc-note">' + esc(L().notValidated) + "</p>");
    }
    [["biv", L().biv.t], ["rijtaks", L().rij.t]].forEach(function (pair) {
      var r = all[pair[0]];
      if (!r || r.unvalidatedRegion || r.expired) return;
      if (r.needsMoreData || r.amount == null) {
        out.push('<p class="tc-note">' + esc(L().needs(pair[1], missingToken(r.reason))) + "</p>");
      }
    });
    return out.length ? '<div class="tc-notes">' + out.join("") + "</div>" : "";
  }

  // Collapsed assumptions disclosure. Gathers the localised assumption reasons
  // from each shown figure, tags them with the figure they affect, and orders
  // the lowest-confidence figure first (so a low BIV surfaces its reasons above
  // a high Rijtaks). Closed by default; the open list is capped and scrolls.
  function buildExpander(all) {
    var exp = L().expander;
    var order = { none: 0, low: 1, medium: 2, high: 3 };
    var figures = [
      { res: all.biv, src: exp.src.biv },
      { res: all.rijtaks, src: exp.src.rij }
    ].filter(function (fig) {
      return fig.res && !fig.res.needsMoreData && fig.res.amount != null;
    });
    figures.sort(function (a, b) {
      var ca = order[a.res.confidence] != null ? order[a.res.confidence] : 1;
      var cb = order[b.res.confidence] != null ? order[b.res.confidence] : 1;
      return ca - cb;
    });

    var lis = [];
    figures.forEach(function (fig) {
      (fig.res.assumptions || []).forEach(function (str) {
        lis.push('<li><span class="tc-ex-src">' + esc(fig.src) + '</span>' +
          '<span class="tc-rz">' + esc(translateAssumption(str)) + "</span></li>");
      });
    });
    if (!lis.length) return "";

    return '<div class="tc-expander-wrap">' +
      '<button class="tc-expander" type="button" aria-expanded="false">' + QIC + esc(exp.label) + CHEV + "</button>" +
      '<div class="tc-ex-panel">' +
        '<p class="tc-ex-intro">' + esc(exp.intro) + "</p>" +
        '<ul class="tc-ex-list">' + lis.join("") + "</ul>" +
      "</div>" +
    "</div>";
  }

  function render(all, vehicle, region) {
    LAST = { all: all, vehicle: vehicle, region: region };
    ensureFonts();

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
    // Once the rates are out of date, or the region was never validated, the
    // authoritative source stops being a footnote and becomes the main thing on
    // offer. It is the one click that gets the user the right number.
    var pv = panelVintage(all);
    var promoteSim = !!((pv && pv.status !== "current") ||
      ["biv", "rijtaks"].some(function (k) { return all[k] && all[k].unvalidatedRegion; }));
    var tier = verdictTier(all);
    var verdictHtml = tier
      ? '<span class="tc-verdict ' + tier + '"><span class="tc-tldot"></span>' + esc(L().verdict[tier]) + "</span>"
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
            '<div class="tc-row">' + keyCell(L().biv) + valueCell(all.biv) + confCell(all.biv) + "</div>" +
            '<div class="tc-row">' + keyCell(L().rij) + valueCell(all.rijtaks) + confCell(all.rijtaks) + "</div>" +
          "</div>" +
          buildNotes(all) +
          (simUrl ? '<a class="tc-sim' + (promoteSim ? " tc-sim-lead" : "") + '" href="' + esc(simUrl) +
            '" target="_blank" rel="noopener">' + esc(L().sim) + " " + EXT + "</a>" : "") +
          buildExpander(all) +
          '<div class="tc-foot">' + plateTag(region) + verdictHtml + "</div>" +
          buildDisclaimer(all) +
        "</div>" +
      "</div>";

    wireToggle(shadow);
    wireCollapse(shadow);
    wireExpander(shadow);
    loadPrefOnce();
  }

  // Assumptions disclosure: open/close on click, keep aria-expanded in sync.
  // Sits below the value rows, so opening it never shifts the euro figures.
  function wireExpander(shadow) {
    var btn = shadow.querySelector(".tc-expander");
    if (!btn) return;
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var wrap = btn.closest(".tc-expander-wrap");
      var open = wrap.classList.toggle("open");
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    });
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

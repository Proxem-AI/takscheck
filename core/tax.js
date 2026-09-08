/*
 * Belgian car tax engine. Pure, framework free, no DOM, no network.
 * Encodes BIV / TMC (one off registration tax) and Rijtaks / TC (annual road tax)
 * for Flanders, Brussels and Wallonia, driven by an updateable tariff table.
 *
 * Constants come from 2026-07-27 research, calibrated against the official
 * Vlaamse Belastingdienst simulator. Flanders BIV is the validated priority.
 *
 * Loadable both as a classic browser script (sets globalThis.BelgianCarTax)
 * and as a CommonJS module (module.exports) for the Node regression harness.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.BelgianCarTax = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var FUEL_CLASSES = ["petrol", "diesel", "lpg", "cng", "electric", "hydrogen", "hybrid", "phev"];

  // ---- small helpers -------------------------------------------------------

  function round2(n) {
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }

  // Parse a first-registration value into { year, month }. Accepts Date,
  // "YYYY-MM", "YYYY-MM-DD", "MM/YYYY", "MM-YYYY", or a plain year.
  function parseFirstReg(value) {
    if (value == null) return null;
    if (value instanceof Date && !isNaN(value)) {
      return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1 };
    }
    var s = String(value).trim();
    var m;
    if ((m = s.match(/^(\d{4})[-/.](\d{1,2})(?:[-/.]\d{1,2})?$/))) {
      return { year: +m[1], month: Math.min(12, Math.max(1, +m[2])) };
    }
    if ((m = s.match(/^(\d{1,2})[-/.](\d{4})$/))) {
      return { year: +m[2], month: Math.min(12, Math.max(1, +m[1])) };
    }
    if ((m = s.match(/^(\d{4})$/))) {
      return { year: +m[1], month: 1 };
    }
    var d = new Date(s);
    if (!isNaN(d)) return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
    return null;
  }

  // Whole months elapsed between a first-registration and a reference date.
  function ageInMonths(firstReg, refDate) {
    var fr = parseFirstReg(firstReg);
    if (!fr) return null;
    var ref = refDate ? new Date(refDate) : new Date();
    var months = (ref.getUTCFullYear() - fr.year) * 12 + (ref.getUTCMonth() + 1 - fr.month);
    return Math.max(0, months);
  }

  function completedYears(firstReg, refDate) {
    var m = ageInMonths(firstReg, refDate);
    return m == null ? null : Math.floor(m / 12);
  }

  function ymKey(year, month) {
    return String(year).padStart(4, "0") + "-" + String(month).padStart(2, "0");
  }

  // ---- indexation windows --------------------------------------------------

  // Flemish BIV and road tax amounts are re-indexed every 1 July, and the BIV q
  // coefficient moves separately every 1 January, so a tariff block carries two
  // window series: indexWindows for the amounts and qWindows for q. Each entry
  // is an override set with an explicit from and until, newest first. The
  // applicable window is chosen by the date the tax is assessed (registration
  // date for the BIV, assessment period start for the road tax), which is why a
  // car registered 15/01/2026 and one registered 15/09/2026 are billed off
  // different tables for identical inputs.
  //
  // BOTH BOUNDS ARE READ. Until 2026-09-07 the selection tested "from" alone,
  // which serves an expired table forever with no signal anywhere in the output:
  // on 1 July 2027 the key "2027-07-01" still satisfies >= "2026-07-01". The
  // data knew when it stopped being true and the code never asked. pickWindow
  // now returns the window it chose alongside the merged values, so the caller
  // can render the vintage and detect staleness.
  //
  // Past the until date the answer is to disclose and degrade, never to refuse:
  // the newest table we hold is still the best available answer, indexation has
  // only ever moved upward, and turning a small labelled error into a total loss
  // of function pushes the user back to guessing. Amounts are withdrawn only
  // after a further twelve months, which is two missed indexations.
  var STALE_GRACE_MONTHS = 12;

  function isoDay(refDate) {
    var d = refDate ? new Date(refDate) : new Date();
    if (isNaN(d)) d = new Date();
    return d.toISOString().slice(0, 10);
  }

  function pad(n, w) { return String(n).padStart(w, "0"); }

  // Add whole months to a "YYYY-MM-DD" string, clamping to the last day of the
  // target month. Pure string arithmetic, no timezone to get wrong.
  function addMonths(iso, n) {
    var y = +iso.slice(0, 4), m = +iso.slice(5, 7), d = +iso.slice(8, 10);
    var t = y * 12 + (m - 1) + n;
    var ny = Math.floor(t / 12), nm = (t % 12) + 1;
    var last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
    if (d > last) d = last;
    return pad(ny, 4) + "-" + pad(nm, 2) + "-" + pad(d, 2);
  }

  // "current" | "stale" | "expired" for one window against the reference date.
  function vintageOf(win, key) {
    var from = win && win.from ? win.from : null;
    var until = win && win.until ? win.until : null;
    var status = "current";
    if (until && key > until) {
      status = key > addMonths(until, STALE_GRACE_MONTHS) ? "expired" : "stale";
    }
    return { from: from, until: until, status: status, asOf: key };
  }

  // Combine two vintages into the one the user is shown: the later "from",
  // because that is the tariff set actually in play, the earlier "until",
  // because that is the first thing to go out of date, and the worse status.
  var VINTAGE_RANK = { current: 0, stale: 1, expired: 2 };
  function worseVintage(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    return {
      from: (a.from && b.from) ? (a.from > b.from ? a.from : b.from) : (a.from || b.from),
      until: (a.until && b.until) ? (a.until < b.until ? a.until : b.until) : (a.until || b.until),
      status: VINTAGE_RANK[a.status] >= VINTAGE_RANK[b.status] ? a.status : b.status,
      asOf: a.asOf || b.asOf
    };
  }

  function mergeWindow(cfg, win) {
    var merged = {}, k;
    for (k in cfg) if (Object.prototype.hasOwnProperty.call(cfg, k)) merged[k] = cfg[k];
    for (k in win) if (Object.prototype.hasOwnProperty.call(win, k)) merged[k] = win[k];
    return merged;
  }

  // Returns { values, vintage }. listKey is "indexWindows" or "qWindows".
  function pickWindow(cfg, refDate, listKey) {
    var key = isoDay(refDate);
    var windows = cfg && cfg[listKey];
    if (!windows || !windows.length) return { values: cfg, vintage: vintageOf(cfg, key) };

    // A window whose range contains the reference date wins outright.
    for (var i = 0; i < windows.length; i++) {
      if (key >= windows[i].from && (!windows[i].until || key <= windows[i].until)) {
        return { values: mergeWindow(cfg, windows[i]), vintage: vintageOf(windows[i], key) };
      }
    }
    // Past the newest window: keep its values, which are the best the file has,
    // and let the vintage say how far out of date they are.
    if (windows[0].until && key > windows[0].until) {
      return { values: mergeWindow(cfg, windows[0]), vintage: vintageOf(windows[0], key) };
    }
    // Before the oldest window: the base block is the older data.
    return { values: cfg, vintage: vintageOf(cfg, key) };
  }

  // The BIV q coefficient lives in its own 1 January series. Falling back to a
  // bare constant is what created the 1 January 2027 failure in the first place,
  // so there is no bare constant to fall back to: if no window covers the date
  // the oldest one is used and the vintage is marked, which is visible, rather
  // than returning NaN, which is not.
  function pickQ(bivCfg, refDate) {
    var picked = pickWindow(bivCfg, refDate, "qWindows");
    if (picked.values && picked.values.q != null) return picked;
    var list = (bivCfg && bivCfg.qWindows) || [];
    var oldest = list[list.length - 1];
    if (!oldest) return { values: picked.values, vintage: picked.vintage };
    var v = vintageOf(oldest, isoDay(refDate));
    v.status = v.status === "current" ? "stale" : v.status;
    return { values: mergeWindow(bivCfg, oldest), vintage: v };
  }

  // ---- fuel normalisation --------------------------------------------------

  function mapFuel(raw) {
    if (!raw) return null;
    var s = String(raw).toLowerCase();
    // Independent token detection: a label can carry both an electric and a
    // combustion token (e.g. "Elektrisch/Benzine" = plug-in hybrid). Only a
    // label with an electric token and NO combustion token is a real BEV.
    var hasElectric = /(electric|elektr|\bbev\b|\bev\b)/.test(s);
    var hasCombustion = /(petrol|gasoline|benzin|benzine|essence|super|diesel|gazole|mazout|lpg|autogas|gpl|cng|aardgas|gnc|methane|hybrid|hev|phev|plug.?in)/.test(s);
    // Plug-in / any electric+combustion mix: taxed on CO2 like a petrol car.
    if (/(plug.?in|phev)/.test(s)) return "phev";
    if (hasElectric && hasCombustion) return "phev";
    if (/(hybrid|hev|full.?hybrid|mild.?hybrid)/.test(s)) return "hybrid";
    if (/(hydrogen|waterstof|h2|fuel.?cell)/.test(s)) return "hydrogen";
    if (hasElectric) return "electric";
    if (/(diesel|gazole|mazout)/.test(s)) return "diesel";
    if (/(lpg|autogas|gpl)/.test(s)) return "lpg";
    if (/(cng|aardgas|gnc|natural.?gas|methane)/.test(s)) return "cng";
    if (/(petrol|gasoline|benzin|essence|benzine|super)/.test(s)) return "petrol";
    return null;
  }

  function isElectricLike(fuel) {
    return fuel === "electric" || fuel === "hydrogen";
  }

  // True zero-emission vehicle: an electric/hydrogen fuel token with NO sign of
  // a combustion engine. The CO2 and cc guards mean a mislabelled plug-in hybrid
  // (electric token but real CO2 / cylinder capacity) never wins the EV exemption.
  function isZeroEmission(vehicle) {
    if (!isElectricLike(vehicle.fuel)) return false;
    if (vehicle.co2 != null && vehicle.co2 > 0) return false;
    if (vehicle.displacementCc != null && vehicle.displacementCc > 0) return false;
    return true;
  }

  // Which air-component column a fuel uses in the Flemish BIV.
  function airColumn(fuel) {
    return fuel === "diesel" ? "diesel" : "petrol";
  }

  // ---- inference (Euro norm, CO2 cycle, fiscal HP, MMA) --------------------

  function inferEuroNorm(firstReg, table) {
    var fr = parseFirstReg(firstReg);
    if (!fr) return null;
    var key = ymKey(fr.year, fr.month);
    for (var i = 0; i < table.length; i++) {
      if (key >= table[i].fromYearMonth) return table[i].euroNorm;
    }
    return 0;
  }

  function inferCo2Cycle(firstReg, table) {
    var fr = parseFirstReg(firstReg);
    if (!fr) return { cycle: "wltp", confidence: "low" };
    var key = ymKey(fr.year, fr.month);
    for (var i = 0; i < table.length; i++) {
      if (key >= table[i].fromYearMonth) {
        return { cycle: table[i].cycle, confidence: table[i].confidence };
      }
    }
    return { cycle: "nedc", confidence: "high" };
  }

  function lookupByKw(list, kw, valueKey) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].kwMax == null || kw <= list[i].kwMax) return list[i][valueKey];
    }
    return list[list.length - 1][valueKey];
  }

  // Cylinder capacity to fiscal PK. Stepped, not a division (the old cc / 200
  // shortcut understated by a full bracket for most modern engines). Above the
  // table it rises about +1 PK per fiscalPkAbove4050PerCc cc, per the simulator
  // sweep (research section 12.2).
  //
  // THIS TABLE IS NOT A TRANSCRIPTION OF A STATUTE. It used to be described here
  // as the "Official Belgian belastbare-kracht table" and that claim did not
  // survive being checked. Pax searched the VCF, its Besluit van 20 december
  // 2013, the Belgisch Staatsblad publication, Fisconetplus and the federal
  // WIGB / KB 1970 lineage on 2026-09-09 and found no cc-to-pk lookup table
  // anywhere in Flemish or Belgian tax law. The statutory definition for a
  // combustion engine is VCF art. 2.2.3.0.1 and 2.2.3.0.2:
  //     pk = k x d^2 x c x n
  // with d the cylinder bore in metres, c the piston stroke in metres, n the
  // cylinder count, and k looked up by bore diameter. Cylinder capacity re-enters
  // the law only as a CEILING on that result, never as an alternative basis.
  // What this table is, therefore, is a practical approximation of that formula
  // for typical production engines. It is a good one and the simulator sweep
  // backs it, but it is an approximation and the next person to read this should
  // know that rather than assume the law is behind every band. See the
  // inference.fiscalPkByCc provenance entry in core/tariffs.json, and note that
  // the pk16 band is flagged there as suspect pending a primary source.
  function ccToFiscalPk(cc, inf) {
    var table = inf.fiscalPkByCc;
    for (var i = 0; i < table.length; i++) {
      if (cc <= table[i].ccMax) return table[i].pk;
    }
    var last = table[table.length - 1];
    return last.pk + Math.ceil((cc - last.ccMax) / inf.fiscalPkAbove4050PerCc);
  }

  // Returns { value, confidence, assumption } for fiscal HP.
  function deriveFiscalHp(vehicle, inf) {
    if (vehicle.fiscalHp != null && vehicle.fiscalHp > 0) {
      return { value: vehicle.fiscalHp, confidence: "high", assumption: "fiscal HP taken from the ad" };
    }
    if (isElectricLike(vehicle.fuel) && vehicle.powerKw != null) {
      var cv = lookupByKw(inf.evFiscalHpByKw, vehicle.powerKw, "cv");
      return { value: cv, confidence: "low", assumption: "EV fiscal HP estimated from kW (approximate table)" };
    }
    if (vehicle.displacementCc != null && vehicle.displacementCc > 0) {
      var v = Math.max(inf.fiscalHpMin, ccToFiscalPk(vehicle.displacementCc, inf));
      return { value: v, confidence: "medium", assumption: "fiscal HP derived from cc via the belastbare-kracht approximation table" };
    }
    if (vehicle.powerKw != null) {
      // NO FIGURE IS RETURNED HERE ON PURPOSE. Do not put a divisor back.
      //
      // This branch used to answer Math.round(powerKw / 5.5) when an advert listed
      // power but no cylinder capacity. It was labelled a rough estimate. It was
      // not an estimate, it was wrong: measured against the cc table on 16 real
      // captured adverts it disagreed on every single one, by 7 to 49 fiscal pk
      // steps, which is a road tax overstated by 241 to 563 per cent. It also
      // contradicted this file's own EV table, which puts 100 kW at 10 CV where
      // the divisor gave 18.
      //
      // The reason no corrected divisor replaced it is that there is nothing to
      // correct it to. Pax read the law on 2026-09-09: Belgian fiscal PK for a
      // combustion engine is defined by VCF art. 2.2.3.0.1 and 2.2.3.0.2 on
      // cylinder bore, stroke and cylinder count. Power output is not an input
      // anywhere, and cylinder capacity appears only as a ceiling on the result.
      // The single power-based formula in the VCF, art. 2.2.3.0.4, is scoped to
      // electric motors and takes element count, voltage and current, not kW. So
      // any divisor here would be a number with no statutory basis, dressed up as
      // a derivation. Observed ratios on real cars ran from 10.6 to 20.6 kW per
      // fiscal pk and rose with engine size, so no single divisor fits anyway.
      //
      // Returning null rather than deleting the branch keeps the reason
      // expressible: both callers already guard on a null value and return their
      // own needsMoreData descriptor, so the user is told the road tax needs a
      // cylinder capacity that this advert did not list. That wording already
      // exists and already ships. Exposure is nil either way: of the 16 adverts
      // captured on 2026-09-08, every one listed a cylinder capacity.
      //
      // The assumption text keeps the "no displacement or fiscal HP" prefix so
      // ui/badge.js localises it with the existing, accurate NL and FR copy.
      return { value: null, confidence: "none",
        assumption: "no displacement or fiscal HP available; engine power alone is not a lawful basis for a combustion engine" };
    }
    return { value: null, confidence: "none", assumption: "no displacement or fiscal HP available" };
  }

  function defaultMma(vehicle, inf) {
    if (vehicle.mma != null && vehicle.mma > 0) {
      return { value: vehicle.mma, confidence: "high", assumption: "MMA taken from the ad" };
    }
    if (vehicle.kerbWeight != null && vehicle.kerbWeight > 0) {
      return {
        value: vehicle.kerbWeight + inf.kerbToMmaPayload,
        confidence: "medium",
        assumption: "MMA approximated as kerb weight + " + inf.kerbToMmaPayload + " kg payload"
      };
    }
    var body = (vehicle.bodyType || "default").toLowerCase();
    var table = inf.defaultMmaByBody;
    var val = table[body] != null ? table[body] : table.default;
    return { value: val, confidence: "low", assumption: "MMA defaulted from body type (" + body + ")" };
  }

  // ---- Flanders BIV --------------------------------------------------------

  function bivFlanders(vehicle, t, inf, refDate) {
    var picked = pickWindow(t.flanders.biv, refDate, "indexWindows");
    var cfg = picked.values;
    // q moves on 1 January, the amounts move on 1 July, so the two series are
    // picked separately. q is folded into the reported vintage only on the WLTP
    // branch, because that is the only branch it appears in: an NEDC car uses
    // CO2 x f + nedcCo2Offset and is not affected by q going out of date.
    var qPick = pickQ(t.flanders.biv, refDate);
    var q = qPick.values.q;
    var vintage = picked.vintage;
    var assumptions = [];
    var confidence = "high";

    function lower(c) {
      var order = { high: 3, medium: 2, low: 1, none: 0 };
      if (order[c] < order[confidence]) confidence = c;
    }

    // Electric / hydrogen: flat minimum for new EVs, historic exemption before 2026.
    // isZeroEmission guards against a plug-in hybrid mislabelled as electric: if
    // CO2 or a cylinder capacity is present the car is taxed, never exempted.
    if (isZeroEmission(vehicle)) {
      var fr = parseFirstReg(vehicle.firstRegistration);
      if (fr && fr.year < cfg.evExemptBeforeYear) {
        return result(0, "high", ["EV/hydrogen first registered before " + cfg.evExemptBeforeYear + ", historic BIV exemption applies"], "EV exemption");
      }
      return result(cfg.evFlat, "high", ["new EV/hydrogen: flat BIV since 1 Jan " + cfg.evExemptBeforeYear], "EV flat minimum");
    }

    var fuelForFactor = vehicle.fuel;
    // PHEV / hybrid (and any electric-token car that reached here because it has
    // CO2 or a combustion engine) are taxed on their CO2 like a petrol car.
    if (fuelForFactor === "phev" || fuelForFactor === "hybrid" || fuelForFactor === "electric" || fuelForFactor === "hydrogen") fuelForFactor = "petrol";
    var f = cfg.fuelFactor[fuelForFactor];
    if (f == null) { f = cfg.fuelFactor.other; assumptions.push("unknown fuel, using fuel factor f = " + f); lower("medium"); }

    if (vehicle.co2 == null) {
      return {
        amount: null,
        needsMoreData: true,
        reason: "CO2 not listed; Flemish BIV cannot be computed precisely (official practice falls back to a power-based calculation).",
        confidence: "none",
        basis: "Flanders CO2 formula",
        assumptions: assumptions,
        dataVintage: vintage,
        simulatorUrl: t.simulatorUrls.flanders
      };
    }

    // Euro norm: use ad value, otherwise infer from first registration.
    var euro = vehicle.euroNorm;
    if (euro == null) {
      euro = inferEuroNorm(vehicle.firstRegistration, inf.euroNormByFirstReg);
      if (euro == null) euro = 6;
      assumptions.push("Euro " + euro + " inferred from first-registration date");
      lower("medium");
    }

    // CO2 measurement cycle. This selects a BRANCH, not a nuance: the official
    // simulator asks for the NEDC CO2 value below first registration 01/01/2021
    // and the WLTP value from that date, and the two run through different
    // numerators. Source: Pax's 29 case capture of the official Vlaamse
    // Belastingdienst wizard, 2026-09-01, cases AGE-7Y / AGE-8Y / AGE-16Y and
    // NEDC-095 / NEDC-130 / NEDC-200 / NEDC-PET / NEDC-LPG, recorded in
    // test/simulator-comparison-2026-09.json and asserted by
    // test/simulator-comparison-harness.mjs --strict. Do NOT collapse this back
    // to a single WLTP formula from trade press: doing so under-quoted every
    // pre-2021 car by up to 236 percent. See tariffs.json
    // provenance.constants["flanders.biv.nedcCo2Offset"].
    var cycle = inferCo2Cycle(vehicle.firstRegistration, inf.co2CycleByFirstReg);
    if (cycle.cycle === "nedc") {
      assumptions.push("first registered before 1 Jan 2021: NEDC branch of the BIV formula (CO2 x f + " + cfg.nedcCo2Offset.toFixed(2) + ")");
      lower("medium");
    } else if (cycle.confidence === "low") {
      assumptions.push("registration close to the NEDC/WLTP boundary: WLTP assumed for CO2");
      lower("low");
    }

    // Diesel below Euro 5 carries a soot filter question the ad data does not
    // answer. With a filter the car is billed on the Euro 5 air component
    // (official EURO4-DPF 1001.19), without one on its own (EURO4-NODPF
    // 1011.87). Unknown is NOT treated as a free default: it is stated in the
    // assumptions and it lowers the confidence.
    var airEuro = euro;
    if (vehicle.fuel === "diesel" && euro < 5) {
      if (vehicle.sootFilter === true) {
        airEuro = 5;
        assumptions.push("diesel below Euro 5 with a soot filter: billed on the Euro 5 air component");
      } else if (vehicle.sootFilter === false) {
        assumptions.push("diesel below Euro 5 without a soot filter: billed on its own Euro " + euro + " air component");
      } else {
        assumptions.push("diesel below Euro 5: the soot filter is unknown and no ad exposes it, so the dearer no-filter column is used; a filter would lower this");
        lower("low");
      }
    }

    var col = airColumn(vehicle.fuel);
    var c = cfg.airComponent[col][String(airEuro)];
    if (c == null) { c = cfg.airComponent[col]["6"]; assumptions.push("air component defaulted to Euro 6"); lower("medium"); }

    // The NEDC additive sits AFTER the fuel factor, not before. The LPG case
    // settles the ordering: f = 0.88 applied to (CO2 + 63) gives a core term of
    // 487.00, applied to the CO2 alone it gives 632.89, and official NEDC-LPG
    // is 632.89 + 28.54 air, x 0.30 age = 198.43.
    var numerator;
    if (cycle.cycle === "nedc") {
      numerator = vehicle.co2 * f + cfg.nedcCo2Offset;
    } else {
      if (q == null) {
        return {
          amount: null,
          needsMoreData: true,
          reason: "no BIV q coefficient is on file for this assessment date",
          confidence: "none",
          basis: "Flanders CO2 formula",
          assumptions: assumptions,
          dataVintage: vintage,
          simulatorUrl: t.simulatorUrls.flanders
        };
      }
      vintage = worseVintage(vintage, qPick.vintage);
      numerator = vehicle.co2 * f * q;
    }
    var inner = numerator / cfg.divisor;
    var core = Math.pow(inner, cfg.exponent) * cfg.factor;
    var raw = core + c;

    // Age correction (leeftijdscorrectie).
    var years = completedYears(vehicle.firstRegistration, refDate);
    var lc = 1.0;
    if (years == null) {
      assumptions.push("no first-registration date: assuming a new car (LC = 100%)");
      lower("medium");
      years = 0;
    }
    var ac = cfg.ageCorrection;
    lc = Math.max(ac.floorPct, ac.startPct - ac.stepPerYear * years);

    var amount = raw * lc;
    amount = Math.min(cfg.max, Math.max(cfg.min, amount));

    if (vehicle.fuel === "phev") { assumptions.push("PHEV taxed by the CO2 formula on its WLTP CO2"); lower("medium"); }

    return {
      amount: round2(amount),
      needsMoreData: false,
      confidence: confidence,
      basis: "Flanders CO2 formula (" + cycle.cycle.toUpperCase() + " branch, Euro " + euro + ", LC=" + Math.round(lc * 100) + "%)",
      assumptions: assumptions,
      dataVintage: vintage,
      simulatorUrl: t.simulatorUrls.flanders
    };

    function result(a, conf, notes, basis) {
      return {
        amount: round2(a), needsMoreData: false, confidence: conf,
        basis: "Flanders " + basis, assumptions: notes, dataVintage: vintage,
        simulatorUrl: t.simulatorUrls.flanders
      };
    }
  }

  // ---- Brussels TMC (higher of CV vs kW axis, then age reduction) ----------

  function tmcBrussels(vehicle, t, inf, refDate) {
    var cfg = t.brussels.tmc;
    var assumptions = [];
    var confidence = "high";
    function lower(c) { var o = { high: 3, medium: 2, low: 1, none: 0 }; if (o[c] < o[confidence]) confidence = c; }

    if (isElectricLike(vehicle.fuel)) {
      return {
        amount: round2(cfg.evFlat), needsMoreData: false, confidence: "high",
        basis: "Brussels traditional TMC (EV flat)", assumptions: ["electric/hydrogen: flat TMC"],
        simulatorUrl: t.simulatorUrls.brussels
      };
    }

    if (vehicle.powerKw == null) {
      return needData("engine power (kW) not listed");
    }
    var fhp = deriveFiscalHp(vehicle, inf);
    if (fhp.value == null) return needData("cannot determine fiscal HP (no cc)");
    assumptions.push(fhp.assumption);
    lower(fhp.confidence);

    var isLpg = vehicle.fuel === "lpg";
    var valueKey = isLpg ? "lpg" : "petrolDiesel";

    // kW axis reading
    var kwAmount = 0;
    for (var i = 0; i < cfg.brackets.length; i++) {
      var b = cfg.brackets[i];
      if (b.kwMax == null || vehicle.powerKw <= b.kwMax) { kwAmount = b[valueKey]; break; }
    }
    // CV axis reading
    var cvAmount = 0;
    for (var j = 0; j < cfg.brackets.length; j++) {
      var b2 = cfg.brackets[j];
      if (b2.cvMax == null || fhp.value <= b2.cvMax) { cvAmount = b2[valueKey]; break; }
    }
    var base = Math.max(kwAmount, cvAmount);

    // Age reduction (15-year federal schedule).
    var years = completedYears(vehicle.firstRegistration, refDate);
    if (years == null) { years = 0; assumptions.push("no first-registration date: assuming new (100%)"); lower("medium"); }
    var reduced;
    if (years >= cfg.ageFloorFromYear) {
      reduced = cfg.min;
    } else {
      var pct = cfg.ageSchedule[Math.min(years, cfg.ageSchedule.length - 1)];
      reduced = Math.max(cfg.min, base * pct);
    }

    return {
      amount: round2(reduced), needsMoreData: false, confidence: confidence,
      basis: "Brussels traditional TMC (higher of kW/CV axis, age " + years + "y)",
      assumptions: assumptions, simulatorUrl: t.simulatorUrls.brussels
    };

    function needData(reason) {
      return { amount: null, needsMoreData: true, reason: reason, confidence: "none",
        basis: "Brussels traditional TMC", assumptions: assumptions, simulatorUrl: t.simulatorUrls.brussels };
    }
  }

  // ---- Wallonia TMC (reformed 1 Jul 2025: kW base x CO2 x mass x energy) ---

  function tmcWallonia(vehicle, t, inf, refDate) {
    var cfg = t.wallonia.tmc;
    var assumptions = [];
    var confidence = "high";
    function lower(c) { var o = { high: 3, medium: 2, low: 1, none: 0 }; if (o[c] < o[confidence]) confidence = c; }

    if (vehicle.powerKw == null) {
      return { amount: null, needsMoreData: true, reason: "engine power (kW) not listed", confidence: "none",
        basis: "Wallonia reformed TMC", assumptions: assumptions, simulatorUrl: t.simulatorUrls.wallonia };
    }

    // Base amount by kW, then age degressivity, floored at mbFloor.
    var mb = lookupByKw(cfg.baseByKw, vehicle.powerKw, "mb");
    var years = completedYears(vehicle.firstRegistration, refDate);
    if (years == null) { years = 0; assumptions.push("no first-registration date: assuming new (100%)"); lower("medium"); }
    var mbAfterAge;
    if (years >= cfg.ageFloorFromYear) {
      mbAfterAge = cfg.mbFloor;
    } else {
      var pct = cfg.ageSchedule[Math.min(years, cfg.ageSchedule.length - 1)];
      mbAfterAge = Math.max(cfg.mbFloor, mb * pct);
    }

    // CO2 / X term (1 for electric/hydrogen).
    var co2Term;
    if (isElectricLike(vehicle.fuel)) {
      co2Term = 1;
    } else {
      if (vehicle.co2 == null) {
        return { amount: null, needsMoreData: true, reason: "CO2 not listed; Wallonia TMC needs CO2", confidence: "none",
          basis: "Wallonia reformed TMC", assumptions: assumptions, simulatorUrl: t.simulatorUrls.wallonia };
      }
      var cycle = inferCo2Cycle(vehicle.firstRegistration, inf.co2CycleByFirstReg);
      var X = cfg.co2Divisor[cycle.cycle];
      if (cycle.confidence === "low") { assumptions.push("2018 transition window: WLTP divisor (" + X + ") assumed"); lower("low"); }
      else assumptions.push(cycle.cycle.toUpperCase() + " CO2 assumed, divisor X = " + X);
      co2Term = vehicle.co2 / X;
    }

    // Energy coefficient C.
    var C;
    if (isElectricLike(vehicle.fuel)) {
      C = lookupByKw(cfg.energyCoefficient.electricByKw, vehicle.powerKw, "c");
    } else if (vehicle.fuel === "hybrid" || vehicle.fuel === "phev") {
      C = cfg.energyCoefficient.hybrid;
    } else {
      C = cfg.energyCoefficient.combustion;
    }

    // Mass term.
    var mma = defaultMma(vehicle, inf);
    assumptions.push(mma.assumption);
    lower(mma.confidence);
    var massTerm = mma.value / cfg.massReference;

    var tmc = mbAfterAge * co2Term * massTerm * C;
    tmc = Math.min(cfg.max, Math.max(cfg.min, tmc));

    return {
      amount: round2(tmc), needsMoreData: false, confidence: confidence,
      basis: "Wallonia reformed TMC (MB " + Math.round(mbAfterAge) + " x CO2/X x MMA/" + cfg.massReference + " x C" + C + ")",
      assumptions: assumptions, simulatorUrl: t.simulatorUrls.wallonia
    };
  }

  // ---- Annual road tax (Rijtaks / TC) --------------------------------------

  function annualScaleAmount(fiscalHp, scale) {
    var hp = Math.max(scale.minFiscalHp, Math.round(fiscalHp));
    var table = scale.byFiscalHp;
    if (table[String(hp)] != null) return table[String(hp)];
    if (hp > 20) return table["20"] + (hp - 20) * scale.perExtraHpAbove20;
    // below the lowest key: use the minimum bracket
    return table[String(scale.minFiscalHp)];
  }

  // Flemish fiscal-PK reference bareme R(PK): the 2026 opdeciemen-and-index
  // inclusive road tax for petrol / CNG / hybrid-petrol at Euro 6, CO2 130 g.
  function baremeR(fiscalPk, rcfg) {
    var pk = Math.max(4, Math.round(fiscalPk));
    var table = rcfg.pkBareme;
    if (table[String(pk)] != null) return table[String(pk)];
    if (pk > 20) return table["20"] + (pk - 20) * rcfg.pkBaremeAbove20PerPk;
    return table["4"];
  }

  // Validated Flemish annual road tax (research section 12).
  //   verkeersbelasting = ( R(PK) / referenceDenominator ) x U , floored at min
  //   U = ecoBaseAt130(fuel, euro) + co2SlopePerGram x ( max(co2FloorGram, co2) - 130 )
  // Returns { amount, confidence, assumptions } or a needsMoreData descriptor.
  function roadTaxFlandersModel(vehicle, rcfg, inf, fhp, assumptions) {
    if (vehicle.co2 == null) {
      return { needsMoreData: true, reason: "CO2 not listed; the Flemish road tax needs CO2 for the eco modulation." };
    }

    // Euro norm: use the ad value, otherwise infer from first registration.
    var euro = vehicle.euroNorm;
    var euroKnown = euro != null;
    if (!euroKnown) {
      euro = inferEuroNorm(vehicle.firstRegistration, inf.euroNormByFirstReg);
      if (euro == null) euro = 6;
      assumptions.push("Euro " + euro + " inferred from the first-registration date");
    }

    // PHEV / hybrid-petrol / CNG ride the petrol eco scale on their own CO2;
    // only diesel carries the diesel base surcharge. There is no hybrid discount.
    var ecoFuel = vehicle.fuel === "diesel" ? "diesel" : "petrol";

    // Same soot filter rule as the BIV air component: a diesel below Euro 5
    // with a filter is billed on the Euro 5 eco base (official EURO4-DPF
    // 417.05 against EURO4-NODPF 445.03). Unknown is stated, not defaulted
    // silently. The confidence for the road tax is derived further down from
    // input quality, so the note carries the warning.
    var ecoEuro = euro;
    if (vehicle.fuel === "diesel" && euro < 5) {
      if (vehicle.sootFilter === true) {
        ecoEuro = 5;
        assumptions.push("diesel below Euro 5 with a soot filter: billed on the Euro 5 road tax base");
      } else if (vehicle.sootFilter !== false) {
        assumptions.push("diesel below Euro 5: soot filter unknown, billed on the dearer no-filter base");
      }
    }

    var baseTable = rcfg.ecoBaseAt130[ecoFuel];
    var ref130 = baseTable[String(ecoEuro)] != null ? baseTable[String(ecoEuro)] : baseTable["6"];

    // NEDC branch: the road tax carries a pure CO2 offset, a different
    // correction from the BIV numerator and not interchangeable with it.
    // 148 g NEDC behaves like 169.48 g WLTP for the BIV and like 175 g WLTP
    // here. Measured at exactly 27.00 g across eight independent observations
    // (three CO2 levels, three fuels, two PK steps) in
    // test/simulator-comparison-2026-09.json.
    var cycle = inferCo2Cycle(vehicle.firstRegistration, inf.co2CycleByFirstReg);
    var co2Offset = cycle.cycle === "nedc" ? (rcfg.nedcCo2OffsetGram || 0) : 0;
    if (co2Offset) assumptions.push("first registered before 1 Jan 2021: NEDC branch, CO2 read as " + (vehicle.co2 + co2Offset) + " g");

    var effCo2 = Math.max(rcfg.co2FloorGram, vehicle.co2 + co2Offset);
    var u = ref130 + rcfg.co2SlopePerGram * (effCo2 - 130);
    var rpk = baremeR(fhp.value, rcfg);
    var vb = (rpk / rcfg.referenceDenominator) * u;

    var billed;
    if (vehicle.fuel === "lpg") {
      // LPG pays a reduced base road tax plus an AVB supplement banded by PK.
      var reduced = Math.max(0, vb - rcfg.lpg.reduction);
      var avb = rcfg.lpg.avbByPk[rcfg.lpg.avbByPk.length - 1].avb;
      for (var i = 0; i < rcfg.lpg.avbByPk.length; i++) {
        var band = rcfg.lpg.avbByPk[i];
        if (band.pkMax == null || fhp.value <= band.pkMax) { avb = band.avb; break; }
      }
      billed = reduced + avb;
      assumptions.push("LPG: reduced base road tax + AVB supplement " + avb.toFixed(2));
    } else {
      billed = vb;
    }
    billed = Math.max(rcfg.min, billed);

    // Confidence from input quality (the model itself is simulator-validated).
    //   high   : fiscal PK on the ad, and CO2 + euronorm + fuel all known
    //   medium : PK cc-derived for a pure ICE (petrol / diesel / CNG)
    //   low    : PK cc-derived for a PHEV / hybrid (cc understates fiscal PK),
    //            or CO2 / euronorm had to be guessed
    var pkFromAd = vehicle.fiscalHp != null && vehicle.fiscalHp > 0;
    var isPhevLike = vehicle.fuel === "phev" || vehicle.fuel === "hybrid";
    var conf;
    if (!euroKnown) conf = "low";
    else if (pkFromAd) conf = "high";
    else if (isPhevLike) conf = "low";
    else conf = "medium";

    return { amount: billed, confidence: conf, assumptions: assumptions };
  }

  function roadTax(region, vehicle, t, inf, refDate) {
    var scale = t.annualScale;
    var assumptions = [];
    var confidence = "low"; // annual road tax is estimate-tier across the board (see tariffs note)
    var simUrl = t.simulatorUrls[region];

    var picked = pickWindow(t[region].roadTax, refDate, "indexWindows");
    var regCfg = picked.values;
    var vintage = picked.vintage;
    var fr = parseFirstReg(vehicle.firstRegistration);

    // Region-specific EV handling. isZeroEmission guards against a plug-in hybrid
    // mislabelled as electric (CO2 or cc present): such a car is taxed, not exempt.
    if (isZeroEmission(vehicle)) {
      if (region === "brussels") {
        return mk(0, "high", ["electric/hydrogen: exempt from Brussels road tax"]);
      }
      if (region === "flanders") {
        if (fr && fr.year < regCfg.evExemptBeforeYear) return mk(0, "high", ["EV first registered before " + regCfg.evExemptBeforeYear + ": road-tax exemption retained"]);
        return mk(regCfg.evFlat, "high", ["new EV: flat Flemish road tax (simulator-confirmed)"]);
      }
      if (region === "wallonia") {
        return mk(regCfg.evFlat, "medium", ["EV: reduced Walloon forfait"]);
      }
    }

    // Oldtimer flat rate.
    var years = completedYears(vehicle.firstRegistration, refDate);
    if (region === "flanders" && regCfg.oldtimerFlat && years != null && years >= regCfg.oldtimerAgeYears) {
      return mk(regCfg.oldtimerFlat, "medium", ["oldtimer (" + regCfg.oldtimerAgeYears + "y+): flat Flemish rate"]);
    }
    if (region === "wallonia" && regCfg.oldtimerFlat && years != null && years >= 30) {
      return mk(regCfg.oldtimerFlat, "medium", ["oldtimer (30y+): flat Walloon rate"]);
    }

    var fhp = deriveFiscalHp(vehicle, inf);
    if (fhp.value == null) {
      return { amount: null, needsMoreData: true, reason: "cannot determine fiscal HP (cc not listed)", confidence: "none",
        basis: region + " annual road tax", assumptions: assumptions, dataVintage: vintage, simulatorUrl: simUrl };
    }
    assumptions.push(fhp.assumption);

    // Flanders: the simulator-validated eco-modulated model (research section 12).
    // Brussels and Wallonia keep the representative fiscal-HP scale below.
    if (region === "flanders") {
      var fl = roadTaxFlandersModel(vehicle, regCfg, inf, fhp, assumptions);
      if (fl.needsMoreData) {
        return { amount: null, needsMoreData: true, reason: fl.reason, confidence: "none",
          basis: region + " annual road tax", assumptions: assumptions, dataVintage: vintage, simulatorUrl: simUrl };
      }
      fl.assumptions.push("validated Flemish model: (R(PK) / " + regCfg.referenceDenominator + ") x U(CO2, euro, fuel), floor " + regCfg.min);
      return mk(fl.amount, fl.confidence, fl.assumptions);
    }

    var amount = annualScaleAmount(fhp.value, scale);

    // Region modifiers.
    if (region === "wallonia" && vehicle.fuel === "diesel" && regCfg.dieselSurchargePct) {
      amount = amount * (1 + regCfg.dieselSurchargePct);
      assumptions.push("Walloon diesel surcharge +" + Math.round(regCfg.dieselSurchargePct * 100) + "%");
    }
    if (region === "brussels" && vehicle.fuel === "lpg" && regCfg.lpgSupplement) {
      for (var i = 0; i < regCfg.lpgSupplement.length; i++) {
        var band = regCfg.lpgSupplement[i];
        if (band.cvMax == null || fhp.value <= band.cvMax) { amount += band.amount; assumptions.push("Brussels LPG supplement +" + band.amount); break; }
      }
    }
    assumptions.push("representative fiscal-HP scale, all-in with decimes (estimate; per-region cents not yet pinned)");
    return mk(amount, confidence, assumptions);

    function mk(a, conf, notes) {
      return { amount: round2(a), needsMoreData: false, confidence: conf,
        basis: region + " annual road tax", assumptions: notes, dataVintage: vintage, simulatorUrl: simUrl };
    }
  }

  // ---- scope and staleness -------------------------------------------------

  var TIER_ORDER = ["none", "low", "medium", "high"];
  function lowerOneStep(c) {
    var i = TIER_ORDER.indexOf(c);
    return i > 0 ? TIER_ORDER[i - 1] : (i === 0 ? c : "low");
  }

  // A region outside tariffs.scope.validatedRegions returns a descriptor instead
  // of a figure. Rendering an unvalidated regional amount in the same typography
  // as a Flemish amount checked against 29 official simulator runs claims more
  // than the evidence supports, and our own tariff file marks the Walloon EV
  // road tax SUSPECT. Data driven on purpose: a region returns by being
  // validated and added to that list, not by an edit here.
  function scopeBlock(region, t, basis) {
    var allowed = t.scope && t.scope.validatedRegions;
    if (!allowed || allowed.indexOf(region) !== -1) return null;
    return {
      amount: null,
      needsMoreData: false,
      unvalidatedRegion: true,
      confidence: "none",
      reason: "region not validated against an official source for this version",
      basis: region + " " + basis,
      assumptions: [],
      dataVintage: null,
      simulatorUrl: t.simulatorUrls[region]
    };
  }

  // Disclose and degrade. Past its until date a figure still computes but drops
  // one input tier, because a rate table that has missed an indexation is a
  // weaker basis than a current one and the meter should say so. Only after a
  // further twelve months are the amounts withdrawn: the 1 July 2026 Belgisch
  // Staatsblad bericht was still not retrievable on 1 September 2026, so
  // refusing to compute at midnight on the day a rate changes would punish the
  // user for a document that does not exist yet.
  function applyStaleness(res) {
    var v = res && res.dataVintage;
    if (!v || v.status === "current") return res;
    if (v.status === "stale") {
      res.confidence = lowerOneStep(res.confidence);
      return res;
    }
    res.amount = null;
    res.expired = true;
    res.confidence = "none";
    res.reason = "rate table expired: the " + (v.from || "current") + " tariffs are more than " +
      STALE_GRACE_MONTHS + " months past their validity";
    return res;
  }

  // ---- public engine -------------------------------------------------------

  function createTaxEngine(tariffs) {
    if (!tariffs) throw new Error("createTaxEngine requires a tariff table");
    var inf = tariffs.inference;

    function computeBIV(vehicle, region, refDate) {
      var blocked = scopeBlock(region, tariffs, "registration tax");
      if (blocked) return blocked;
      if (region === "flanders") return applyStaleness(bivFlanders(vehicle, tariffs, inf, refDate));
      if (region === "brussels") return applyStaleness(tmcBrussels(vehicle, tariffs, inf, refDate));
      if (region === "wallonia") return applyStaleness(tmcWallonia(vehicle, tariffs, inf, refDate));
      throw new Error("unknown region: " + region);
    }

    function computeRijtaks(vehicle, region, refDate) {
      if (["flanders", "brussels", "wallonia"].indexOf(region) === -1) throw new Error("unknown region: " + region);
      var blocked = scopeBlock(region, tariffs, "annual road tax");
      if (blocked) return blocked;
      return applyStaleness(roadTax(region, vehicle, tariffs, inf, refDate));
    }

    function computeAll(vehicle, region, refDate) {
      var biv = computeBIV(vehicle, region, refDate);
      var rij = computeRijtaks(vehicle, region, refDate);
      // The two figures can expire on different dates: q lapses on 1 January and
      // only touches the BIV, the amounts lapse on 1 July and touch both. The
      // notice beside them is one sentence for the whole panel, and in the
      // expired state that sentence says no amounts are shown. So once anything
      // in the panel is expired, every figure in it is withdrawn. A panel is
      // only as current as its oldest input, and a notice that contradicts the
      // figure printed next to it is worse than either on its own.
      var panel = worseVintage(biv.dataVintage, rij.dataVintage);
      if (panel && panel.status === "expired") {
        [biv, rij].forEach(function (res) {
          if (res.dataVintage) res.dataVintage = panel;
          applyStaleness(res);
        });
      }
      return {
        region: region,
        tariffVersion: tariffs.version,
        // One vintage for the panel: the later effective date, the earlier
        // expiry, the worse status. Generated from the windows the engine
        // actually selected, never hardcoded in the interface, so updating the
        // JSON can never leave the label lying.
        dataVintage: panel,
        biv: biv,
        rijtaks: rij
      };
    }

    return { computeBIV: computeBIV, computeRijtaks: computeRijtaks, computeAll: computeAll, tariffs: tariffs };
  }

  return {
    createTaxEngine: createTaxEngine,
    mapFuel: mapFuel,
    parseFirstReg: parseFirstReg,
    ageInMonths: ageInMonths,
    completedYears: completedYears,
    inferEuroNorm: inferEuroNorm,
    inferCo2Cycle: inferCo2Cycle,
    deriveFiscalHp: deriveFiscalHp,
    pickWindow: pickWindow,
    vintageOf: vintageOf,
    addMonths: addMonths,
    STALE_GRACE_MONTHS: STALE_GRACE_MONTHS,
    defaultMma: defaultMma,
    FUEL_CLASSES: FUEL_CLASSES
  };
});

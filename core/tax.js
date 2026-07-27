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

  // Official Belgian belastbare-kracht table: cylinder capacity to fiscal PK.
  // Stepped, not a division (the old cc / 200 shortcut understated by a full
  // bracket for most modern engines). Above the table it rises about +1 PK per
  // fiscalPkAbove4050PerCc cc, per the simulator sweep (research section 12.2).
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
      return { value: v, confidence: "medium", assumption: "fiscal HP derived from cc via the official belastbare-kracht table" };
    }
    if (vehicle.powerKw != null) {
      // last-resort rough estimate when displacement is unavailable (list cards)
      var vv = Math.max(inf.fiscalHpMin, Math.round(vehicle.powerKw / 5.5));
      return { value: vv, confidence: "low", assumption: "fiscal HP roughly estimated from kW (cc not listed)" };
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
    var cfg = t.flanders.biv;
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

    // CO2 cycle: Flanders uses the published value as-is (assumes WLTP), but flag NEDC-era cars.
    var cycle = inferCo2Cycle(vehicle.firstRegistration, inf.co2CycleByFirstReg);
    if (cycle.cycle === "nedc") {
      assumptions.push("pre-2018 car: CO2 treated as NEDC and used as published (Flanders uses the certificate value)");
      lower("medium");
    } else if (cycle.confidence === "low") {
      assumptions.push("2018 transition-window registration: WLTP assumed for CO2");
      lower("low");
    }

    var col = airColumn(vehicle.fuel);
    var c = cfg.airComponent[col][String(euro)];
    if (c == null) { c = cfg.airComponent[col]["6"]; assumptions.push("air component defaulted to Euro 6"); lower("medium"); }

    var inner = (vehicle.co2 * f * cfg.q) / cfg.divisor;
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
      basis: "Flanders CO2 formula (q=" + cfg.q + ", Euro " + euro + ", LC=" + Math.round(lc * 100) + "%)",
      assumptions: assumptions,
      simulatorUrl: t.simulatorUrls.flanders
    };

    function result(a, conf, notes, basis) {
      return {
        amount: round2(a), needsMoreData: false, confidence: conf,
        basis: "Flanders " + basis, assumptions: notes, simulatorUrl: t.simulatorUrls.flanders
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
    var baseTable = rcfg.ecoBaseAt130[ecoFuel];
    var ref130 = baseTable[String(euro)] != null ? baseTable[String(euro)] : baseTable["6"];
    var effCo2 = Math.max(rcfg.co2FloorGram, vehicle.co2);
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

    var regCfg = t[region].roadTax;
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
        basis: region + " annual road tax", assumptions: assumptions, simulatorUrl: simUrl };
    }
    assumptions.push(fhp.assumption);

    // Flanders: the simulator-validated eco-modulated model (research section 12).
    // Brussels and Wallonia keep the representative fiscal-HP scale below.
    if (region === "flanders") {
      var fl = roadTaxFlandersModel(vehicle, regCfg, inf, fhp, assumptions);
      if (fl.needsMoreData) {
        return { amount: null, needsMoreData: true, reason: fl.reason, confidence: "none",
          basis: region + " annual road tax", assumptions: assumptions, simulatorUrl: simUrl };
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
        basis: region + " annual road tax", assumptions: notes, simulatorUrl: simUrl };
    }
  }

  // ---- public engine -------------------------------------------------------

  function createTaxEngine(tariffs) {
    if (!tariffs) throw new Error("createTaxEngine requires a tariff table");
    var inf = tariffs.inference;

    function computeBIV(vehicle, region, refDate) {
      if (region === "flanders") return bivFlanders(vehicle, tariffs, inf, refDate);
      if (region === "brussels") return tmcBrussels(vehicle, tariffs, inf, refDate);
      if (region === "wallonia") return tmcWallonia(vehicle, tariffs, inf, refDate);
      throw new Error("unknown region: " + region);
    }

    function computeRijtaks(vehicle, region, refDate) {
      if (["flanders", "brussels", "wallonia"].indexOf(region) === -1) throw new Error("unknown region: " + region);
      return roadTax(region, vehicle, tariffs, inf, refDate);
    }

    function computeAll(vehicle, region, refDate) {
      return {
        region: region,
        tariffVersion: tariffs.version,
        biv: computeBIV(vehicle, region, refDate),
        rijtaks: computeRijtaks(vehicle, region, refDate)
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
    defaultMma: defaultMma,
    FUEL_CLASSES: FUEL_CLASSES
  };
});

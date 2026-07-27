/*
 * Normalisation layer: turn a site-specific listing object into the common
 * Vehicle shape the tax engine understands. Pure, no DOM writes.
 * Sets globalThis.BivNormalise. AutoScout24 (Next.js) for now.
 */
(function (root) {
  "use strict";

  var Tax = root.BelgianCarTax;

  // Shallow/dot-path pick from an object.
  function pick(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      var parts = keys[i].split(".");
      var cur = obj, ok = true;
      for (var j = 0; j < parts.length; j++) {
        if (cur == null || typeof cur !== "object" || !(parts[j] in cur)) { ok = false; break; }
        cur = cur[parts[j]];
      }
      if (ok && cur != null && cur !== "") return cur;
    }
    return null;
  }

  // Breadth-first search for the first primitive value whose key matches a regex.
  function deepFind(obj, keyRe, valuePred) {
    var q = [obj], seen = 0;
    while (q.length && seen < 20000) {
      var node = q.shift();
      seen++;
      if (node == null || typeof node !== "object") continue;
      for (var k in node) {
        if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
        var v = node[k];
        if (keyRe.test(k) && (v == null || typeof v !== "object")) {
          if (!valuePred || valuePred(v)) if (v != null && v !== "") return v;
        }
        if (v && typeof v === "object") q.push(v);
      }
    }
    return null;
  }

  function num(v) {
    if (v == null) return null;
    if (typeof v === "number") return isFinite(v) ? v : null;
    var m = String(v).replace(/[^0-9.,-]/g, "").replace(",", ".");
    var n = parseFloat(m);
    return isFinite(n) ? n : null;
  }

  function parseEuroNorm(v) {
    if (v == null) return null;
    var m = String(v).match(/euro\s*([0-6])/i);
    if (m) return +m[1];
    var n = num(v);
    return n != null && n >= 0 && n <= 6 ? Math.round(n) : null;
  }

  // Map AutoScout24 listingDetails into the common Vehicle.
  function fromAutoScout24(details) {
    if (!details || typeof details !== "object") return null;

    var firstReg = pick(details, [
      "vehicle.firstRegistrationDate", "firstRegistrationDate",
      "vehicle.firstRegistration", "firstRegistration"
    ]) || deepFind(details, /firstregistration/i);

    var fuelRaw = pick(details, [
      "vehicle.fuelCategory.formatted", "vehicle.fuelCategory",
      "vehicle.fuelType", "fuelCategory", "fuelType", "vehicle.primaryFuel"
    ]) || deepFind(details, /^fuel(type|category)?$/i);

    var powerKw = num(pick(details, [
      "vehicle.rawPowerInKw", "rawPowerInKw", "vehicle.powerKw", "powerKw", "powerInKw"
    ]) || deepFind(details, /power.*kw|kw.*power|^powerkw$/i));
    if (powerKw == null) {
      var hp = num(deepFind(details, /power.*(hp|ps)|^rawpowerinhp$|powerinhp/i));
      if (hp != null) powerKw = Math.round(hp / 1.36);
    }

    var cc = num(pick(details, [
      "vehicle.rawDisplacementInCCM", "vehicle.displacement", "displacement",
      "rawDisplacementInCCM", "cubicCapacity", "displacementInCCM"
    ]) || deepFind(details, /displacement|cubiccapacity|ccm/i));

    var co2 = num(pick(details, [
      "vehicle.co2emissionInGramPerKmWithFallback", "co2emissionInGramPerKmWithFallback",
      "vehicle.co2Emission", "co2Emission", "co2"
    ]) || deepFind(details, /co2/i));

    var euro = parseEuroNorm(pick(details, [
      "vehicle.emissionClass.formatted", "vehicle.emissionClass", "emissionClass",
      "vehicle.pollutantClass", "pollutantClass", "euroNorm"
    ]) || deepFind(details, /emissionclass|pollutant|euronorm|schadstoff/i));

    var body = pick(details, ["vehicle.bodyType.formatted", "vehicle.bodyType", "bodyType", "vehicle.category"]);
    var mma = num(deepFind(details, /(maxweight|grossweight|permissibleweight|totalweight|gewicht.*zul|zul.*gewicht)/i));
    var kerb = num(deepFind(details, /(kerbweight|curbweight|emptyweight|leergewicht|unladenweight)/i));
    var price = num(pick(details, ["prices.public.priceRaw", "priceRaw", "price.raw", "price"]) || deepFind(details, /^priceraw$/i));
    var makeModel = [pick(details, ["vehicle.make.formatted", "vehicle.make", "make"]), pick(details, ["vehicle.model.formatted", "vehicle.model", "model"])].filter(Boolean).join(" ");

    return {
      firstRegistration: firstReg ? String(firstReg) : null,
      fuel: Tax.mapFuel(fuelRaw),
      fuelRaw: fuelRaw ? String(fuelRaw) : null,
      powerKw: powerKw,
      displacementCc: cc,
      co2: co2,
      euroNorm: euro,
      bodyType: body ? String(body) : null,
      mma: mma,
      kerbWeight: kerb,
      price: price,
      title: makeModel || null
    };
  }

  // ---- mobile.de -----------------------------------------------------------
  // First integer in a string, tolerant of German thousands dots and units.
  // "1.995 cm3" -> 1995, "128 g/km" -> 128, "140 kW (190 PS)" -> 140.
  function intFrom(v) {
    if (v == null) return null;
    var s = String(v).replace(/[.\s ]/g, "");
    var m = s.match(/-?\d+/);
    return m ? parseInt(m[0], 10) : null;
  }
  function kwFrom(v) {
    if (v == null) return null;
    var m = String(v).match(/(\d+(?:[.,]\d+)?)\s*kw/i);
    if (m) return Math.round(parseFloat(m[1].replace(",", ".")));
    var ps = String(v).match(/(\d+(?:[.,]\d+)?)\s*ps/i);
    if (ps) return Math.round(parseFloat(ps[1].replace(",", ".")) / 1.36);
    return intFrom(v);
  }

  // Build a Vehicle from mobile.de. input = { jsonld: object|null, tech: {labelLower: valueString} }.
  // JSON-LD (schema.org Car) is preferred; the labelled Technische Daten table is the fallback.
  function fromMobileDe(input) {
    input = input || {};
    var j = input.jsonld || null;
    var tech = input.tech || {};
    function t(label) { return tech[label] != null ? tech[label] : null; }

    var eng = j && (j.vehicleEngine || (j.vehicleEngine === 0 ? null : null));
    if (j && !eng && j["@graph"]) {
      for (var g = 0; g < j["@graph"].length; g++) {
        if (/car|vehicle|product/i.test(j["@graph"][g]["@type"] || "")) { j = j["@graph"][g]; eng = j.vehicleEngine; break; }
      }
    }

    // First registration.
    var firstReg = (j && (j.dateVehicleFirstRegistered || j.productionDate || j.vehicleModelDate)) ||
      t("erstzulassung") || t("ez");

    // Fuel.
    var fuelRaw = (j && (j.fuelType || (eng && eng.fuelType))) || t("kraftstoff") || t("kraftstoffart");

    // Power (kW).
    var powerKw = null;
    if (eng && eng.enginePower) {
      var ep = eng.enginePower;
      powerKw = kwFrom((ep.value != null ? ep.value + " " + (ep.unitText || "kW") : ep));
    }
    if (powerKw == null) powerKw = kwFrom(t("leistung"));

    // Displacement (cc).
    var cc = null;
    if (eng && eng.engineDisplacement) {
      var ed = eng.engineDisplacement;
      cc = intFrom(ed.value != null ? ed.value : ed);
    }
    if (cc == null) cc = intFrom(t("hubraum"));

    // CO2.
    var co2 = null;
    if (j && (j.emissionsCO2 != null)) co2 = intFrom(j.emissionsCO2);
    if (co2 == null) co2 = intFrom(t("co2-emissionen") || t("co₂-emissionen") || t("co2-emission"));

    // Euro norm.
    var euro = parseEuroNorm(t("schadstoffklasse") || t("emissionsklasse") || (j && j.emissionStandard));

    // Make / model.
    var make = j && (j.brand && (j.brand.name || j.brand) || j.manufacturer);
    var model = j && (j.model && (j.model.name || j.model) || j.name);
    var title = [make, model].filter(Boolean).join(" ").trim() || (j && j.name) || null;

    // MMA / kerb weight (rarely present for cars).
    var mma = intFrom(t("zul. gesamtgewicht") || t("zulassiges gesamtgewicht") || t("gesamtgewicht"));
    var kerb = intFrom(t("leergewicht"));
    var price = (j && (j.offers && (j.offers.price || (j.offers[0] && j.offers[0].price)))) || intFrom(t("preis"));

    return {
      firstRegistration: firstReg ? String(firstReg) : null,
      fuel: Tax.mapFuel(fuelRaw),
      fuelRaw: fuelRaw ? String(fuelRaw) : null,
      powerKw: powerKw,
      displacementCc: cc,
      co2: co2,
      euroNorm: euro,
      bodyType: (j && (j.bodyType || j.vehicleConfiguration)) ? String(j.bodyType || j.vehicleConfiguration) : null,
      mma: mma,
      kerbWeight: kerb,
      price: price != null ? Number(price) : null,
      title: title
    };
  }

  root.BivNormalise = {
    fromAutoScout24: fromAutoScout24,
    fromMobileDe: fromMobileDe,
    pick: pick,
    deepFind: deepFind
  };
})(typeof globalThis !== "undefined" ? globalThis : this);

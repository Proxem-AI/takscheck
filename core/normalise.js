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

  root.BivNormalise = { fromAutoScout24: fromAutoScout24, pick: pick, deepFind: deepFind };
})(typeof globalThis !== "undefined" ? globalThis : this);

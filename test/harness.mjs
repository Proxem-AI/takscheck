/*
 * Regression harness for the Flemish BIV engine.
 *
 * Ground truth: the official Vlaamse Belastingdienst simulator
 * (belastingen.fenb.be, POST /api/public/simulation/vkb/simulation).
 * Pax drove that simulator via a real browser and recorded every response to
 * the cent (research section 0.9). Those recorded values are the assertions
 * below: the engine must reproduce each official BIV within tolerance.
 *
 * The harness also ATTEMPTS a live call to the same endpoint. That endpoint is
 * WAF-protected and returns 403 to non-browser HTTP clients, so the live probe
 * is best-effort and reports gracefully; the recorded values (captured from the
 * exact same simulator) remain the authoritative ground truth.
 *
 * Run: node test/harness.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const tariffs = JSON.parse(readFileSync(join(root, "core", "tariffs.json"), "utf8"));
const { createTaxEngine, mapFuel } = require(join(root, "core", "tax.js"));
const engine = createTaxEngine(tariffs);

const TOL = 0.15; // Pax recorded +/- 0.15 EUR of rounding noise in the c grid
const REF = "2026-01-15";
const REG_NEW = "2026-01"; // new car, holding date 15/01/2026 => LC = 100%

// ---- Official simulator ground truth (research section 0.9) ---------------
// new car, 15/01/2026, natural person, fiscal PK 9, assessment year 2026.
const officialCases = [
  { fuel: "petrol", co2: 130, euroNorm: 0, expected: 1880.36 },
  { fuel: "petrol", co2: 130, euroNorm: 1, expected: 1042.69 },
  { fuel: "petrol", co2: 130, euroNorm: 2, expected: 567.64 },
  { fuel: "petrol", co2: 130, euroNorm: 3, expected: 492.11 },
  { fuel: "petrol", co2: 130, euroNorm: 4, expected: 395.50 },
  { fuel: "petrol", co2: 130, euroNorm: 5, expected: 392.42 },
  { fuel: "petrol", co2: 130, euroNorm: 6, expected: 392.42 },
  { fuel: "petrol", co2: 100, euroNorm: 6, expected: 103.05 },
  { fuel: "diesel", co2: 130, euroNorm: 0, expected: 4174.98 },
  { fuel: "diesel", co2: 130, euroNorm: 1, expected: 1482.78 },
  { fuel: "diesel", co2: 130, euroNorm: 2, expected: 1193.44 },
  { fuel: "diesel", co2: 130, euroNorm: 3, expected: 1021.50 },
  { fuel: "diesel", co2: 130, euroNorm: 4, expected: 986.51 },
  { fuel: "diesel", co2: 130, euroNorm: 5, expected: 976.25 },
  { fuel: "diesel", co2: 130, euroNorm: 6, expected: 969.22 },
  { fuel: "diesel", co2: 100, euroNorm: 6, expected: 679.85 },
  { fuel: "lpg", co2: 130, euroNorm: 6, expected: 196.93 },
  { fuel: "cng", co2: 130, euroNorm: 6, expected: 263.57 },
  // EV, new, 15/01/2026: simulator returns BIV 61.50
  { fuel: "electric", co2: null, euroNorm: null, expected: 61.50 }
];

// ---- A few more: engine-consistency / boundary cases ----------------------
// These exercise age correction, floors and PHEV.
//
// TASK 118. Until 2026-09-08 this block defined a local helper, bivRaw(), which
// reimplemented the engine's own BIV formula with hard-coded constants, and two
// rows below computed their `expected` from it. That is not a test. It asserts
// that the engine agrees with a second copy of itself, which means it passes when
// both copies are wrong and fails when the engine is CORRECTED. It has already
// done the first: the helper carried only the WLTP numerator, so the 12 year old
// car was asserted at the wrong amount, from the same missing branch the engine
// was missing.
//
// The September remedy added the NEDC branch to the local copy, making the
// duplicate agree rather than removing it, so the structural fault survived its
// own fix. The duplicate is now deleted. Nothing in this file recomputes engine
// logic any more.
//
// The two rows that depended on it are gone. RED decided on 2026-09-09 to remove
// them rather than let them sit red, after Pax reached the same conclusion from
// the capture side. The full reasoning, and the captured rows that carry their
// behaviour instead, sit where the rows used to be, a few lines below.
//
// The rule that outlives all of it: an expectation in this file must come from a
// captured official figure or from a statutory constant. Never from arithmetic
// performed here. Arithmetic here is what task 118 was, twice.
const extraCases = [
  // TWO ROWS WERE REMOVED HERE ON 2026-09-09. Read this before adding one back.
  //
  // They were:
  //   "petrol Euro6 130g, 3 years old -> LC 70%"                (WLTP branch, LC 70%)
  //   "petrol Euro6 130g, 12 years old -> LC floor 10%, NEDC"   (NEDC branch, LC 10%)
  //
  // Both took their expected value from bivRaw(), a local duplicate of the
  // engine's own BIV formula that used to live in this file. That is not a test:
  // it asserts the engine agrees with a copy of itself, so it passes when both are
  // wrong and fails when the engine is CORRECTED. It had already done the first.
  // The duplicate was deleted on 2026-09-08 and these two rows had nothing left to
  // assert against, because no official simulator capture exists for either car.
  //
  // A fresh capture was considered and is not straightforward. This harness holds
  // its reference date at REF = 2026-01-15, which sits in the tariff window BEFORE
  // the 1 July 2026 indexation. A capture run today returns figures at the current
  // window's rates, which are not comparable with what the engine computes at REF.
  // A comparable figure would need the official wizard dialled back to an
  // assessment date in January 2026, and nobody has established that the wizard
  // permits that. So the choice was not between a captured figure and a computed
  // one. It was between deleting the rows and inventing a third number.
  //
  // Nothing was lost. The behaviour these rows reached for is carried by captured
  // official ground truth in test/simulator-comparison-2026-09.json, asserted
  // --strict on every build:
  //   WLTP branch at LC 70%   ->  AGE-3Y   (first registered 01/01/2023)
  //   NEDC branch at LC 10%   ->  AGE-16Y  (first registered 01/01/2010, at the floor)
  //   petrol on the WLTP branch  ->  FUEL-PET
  //   petrol on the NEDC branch  ->  NEDC-PET
  // That was verified by running the engine over every captured case and reading
  // the branch and LC percentage back out of result.basis, not by assuming it. The
  // covering rows are diesel and the deleted rows were petrol, which does not
  // matter: the age correction is a pure multiplier,
  //     lc = Math.max(ac.floorPct, ac.startPct - ac.stepPerYear * years)
  // which reads only `years` and carries no fuel term. The aged-to-new BIV ratio
  // is identical for petrol and diesel to four decimal places on both branches, so
  // the age band is not a per-fuel code path and there is no petrol-shaped hole.
  //
  // If the age-correction coverage ever looks thin here, the fix is a captured
  // official figure, not a number computed in this file. Computing one is how this
  // defect arrived, and how it came back after its first fix.
  {
    // Combustion minimum BIV floor is 55.88 (simulator-confirmed via the 330e
    // PHEV case below); the EV flat 61.50 is a separate statutory amount.
    label: "petrol Euro6 25g/km (very clean) -> min floor 55.88",
    vehicle: { fuel: "petrol", co2: 25, euroNorm: 6, firstRegistration: REG_NEW },
    expected: 55.88
  },
  {
    label: "EV first registered 2022 -> historic exemption 0",
    vehicle: { fuel: "electric", firstRegistration: "2022-06" },
    expected: 0
  },
  {
    // BMW 330e plug-in hybrid, AutoScout24 fuel "Elektrisch/Benzine", CO2 35 g/km,
    // first registration 01/2022, cc 1998. Previously misread as a BEV and given the
    // pre-2026 EV exemption (BIV 0). Must now take the CO2/hybrid path and floor at
    // the combustion minimum 55.88 (official Vlaamse Belastingdienst simulator).
    label: "BMW 330e PHEV (Elektrisch/Benzine, CO2 35, EZ 2022) -> hybrid path 55.88",
    vehicle: { fuel: mapFuel("Elektrisch/Benzine"), co2: 35, firstRegistration: "2022-01", displacementCc: 1998, fiscalHp: 13, powerKw: 135 },
    expected: 55.88
  }
];

// ---------------------------------------------------------------------------

function pass(a, b) { return Math.abs(a - b) <= TOL; }

let failures = 0;
let total = 0;

console.log("BIV regression harness  (tariffs v" + tariffs.version + ", tolerance +/-" + TOL + " EUR)\n");
console.log("== Group 1: official Vlaamse Belastingdienst simulator ground truth ==");
console.log("   (new car, 15/01/2026, fiscal PK 9, assessment year 2026)\n");

let maxDelta = 0;
for (const tc of officialCases) {
  total++;
  // Real BEVs report no cylinder capacity; only combustion cars carry cc. The
  // zero-emission guard keys on cc, so the EV case must not fake a 1600cc engine.
  var isEv = tc.fuel === "electric" || tc.fuel === "hydrogen";
  const vehicle = {
    fuel: tc.fuel, co2: tc.co2, euroNorm: tc.euroNorm,
    firstRegistration: REG_NEW, fiscalHp: 9, powerKw: 85,
    displacementCc: isEv ? null : 1600
  };
  const r = engine.computeBIV(vehicle, "flanders", REF);
  const got = r.amount;
  const delta = Math.abs(got - tc.expected);
  if (delta > maxDelta) maxDelta = delta;
  const ok = pass(got, tc.expected);
  if (!ok) failures++;
  const name = (tc.fuel + " " + (tc.co2 ?? "-") + "g Euro" + (tc.euroNorm ?? "-")).padEnd(20);
  console.log(
    (ok ? "  PASS " : "  FAIL ") + name +
    " expected " + tc.expected.toFixed(2).padStart(9) +
    "   got " + Number(got).toFixed(2).padStart(9) +
    "   d=" + delta.toFixed(3)
  );
}

console.log("\n== Group 2: engine consistency / boundary cases ==\n");
for (const tc of extraCases) {
  total++;
  const r = engine.computeBIV(tc.vehicle, "flanders", REF);
  const got = r.amount;
  const ok = pass(got, tc.expected);
  if (!ok) failures++;
  console.log(
    (ok ? "  PASS " : "  FAIL ") + tc.label.padEnd(48) +
    " expected " + tc.expected.toFixed(2).padStart(9) +
    "   got " + Number(got).toFixed(2).padStart(9)
  );
}

// ---- v1 scope gate --------------------------------------------------------
// Brussels and Wallonia are encoded but were never round tripped against an
// official source, so tariffs.scope.validatedRegions holds v1 to Flanders and
// the public engine returns a not-validated descriptor for the other two. These
// two rows assert the gate itself: if someone widens the scope without doing the
// validation, the suite says so.
console.log("\n== Group 3: v1 scope gate (Flanders only) ==\n");
for (const region of ["brussels", "wallonia"]) {
  const r = engine.computeBIV({ fuel: "petrol", powerKw: 110, displacementCc: 1800, firstRegistration: REG_NEW }, region, REF);
  const ok = r.unvalidatedRegion === true && r.amount === null && !!r.simulatorUrl;
  total++;
  if (!ok) failures++;
  console.log((ok ? "  PASS " : "  FAIL ") + (region + " returns the not-validated descriptor, no amount, own simulator link").padEnd(72));
}
{
  const r = engine.computeBIV({ fuel: "petrol", co2: 130, euroNorm: 6, fiscalHp: 9, firstRegistration: REG_NEW }, "flanders", REF);
  const ok = !r.unvalidatedRegion && r.amount != null;
  total++;
  if (!ok) failures++;
  console.log((ok ? "  PASS " : "  FAIL ") + "flanders is inside the validated scope and still returns an amount".padEnd(72));
}

// ---- other-region smoke checks (documented expected values from research) --
// Run against a deliberately unscoped copy of the tariff table, so the Brussels
// and Wallonia formulas keep their coverage while the shipped engine refuses to
// present them. Scope is data, so widening it needs no product code.
console.log("\n== Group 4: Brussels / Wallonia formula smoke checks (out of v1 scope) ==\n");
const unscopedEngine = createTaxEngine({
  ...tariffs,
  scope: { ...tariffs.scope, validatedRegions: ["flanders", "brussels", "wallonia"] }
});
const smoke = [
  {
    label: "Brussels: petrol 110kW ~9CV new -> higher kW axis 1112.01",
    region: "brussels",
    vehicle: { fuel: "petrol", powerKw: 110, displacementCc: 1800, firstRegistration: REG_NEW },
    approx: 1112.01, tol: 1.0
  },
  {
    label: "Wallonia: EV 150kW MMA 2100 new -> ~283",
    region: "wallonia",
    vehicle: { fuel: "electric", powerKw: 150, mma: 2100, firstRegistration: REG_NEW },
    approx: 283.24, tol: 1.0
  },
  {
    label: "Brussels: EV flat 78.88",
    region: "brussels",
    vehicle: { fuel: "electric", powerKw: 150, firstRegistration: REG_NEW },
    approx: 78.88, tol: 0.01
  }
];
for (const s of smoke) {
  const r = unscopedEngine.computeBIV(s.vehicle, s.region, REF);
  const got = r.amount;
  const ok = Math.abs(got - s.approx) <= s.tol;
  console.log((ok ? "  OK   " : "  DIFF ") + s.label.padEnd(52) + " ~" + s.approx.toFixed(2).padStart(9) + "  got " + Number(got).toFixed(2).padStart(9));
}

// ---- live simulator probe (best-effort) -----------------------------------
console.log("\n== Live simulator probe (best-effort) ==\n");
await liveProbe();

async function liveProbe() {
  const url = "https://belastingen.fenb.be/api/public/simulation/vkb/simulation";
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(url, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Origin": "https://belastingen.fenb.be",
        "Referer": "https://belastingen.fenb.be/ui/public/vkb/simulatie"
      },
      body: JSON.stringify({ co2: 130, euroNorm: 6, fiscalPower: 9 })
    });
    clearTimeout(to);
    const text = await res.text();
    if (res.ok) {
      console.log("  LIVE reachable, HTTP " + res.status + ". Response head: " + text.slice(0, 200));
      console.log("  (Payload schema differs per app version; parse resultBIV to compare directly.)");
    } else {
      console.log("  LIVE endpoint returned HTTP " + res.status + " (WAF blocks non-browser clients, as expected).");
      console.log("  Ground truth above comes from the same simulator, captured via a real browser (research 0.9).");
    }
  } catch (e) {
    console.log("  LIVE probe could not complete (" + (e.name || "error") + "). Recorded simulator values remain authoritative.");
  }
}

// ---------------------------------------------------------------------------
console.log("\n---------------------------------------------------------------");
console.log("Ground-truth + consistency assertions: " + (total - failures) + "/" + total + " passed. Max delta vs official BIV: " + maxDelta.toFixed(3) + " EUR.");
if (failures > 0) {
  console.log("RESULT: FAIL (" + failures + " mismatch" + (failures === 1 ? "" : "es") + ").");
  process.exit(1);
} else {
  console.log("RESULT: PASS. Flemish engine matches the official simulator within +/-" + TOL + " EUR.");
  process.exit(0);
}

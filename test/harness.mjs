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
// These exercise age correction, floors and PHEV against hand-computed values.
function bivRaw(co2, f, c) {
  const inner = (co2 * f * 1.245) / 246;
  return Math.pow(inner, 6) * 4500 + c;
}
const extraCases = [
  {
    label: "petrol Euro6 130g, 3 years old -> LC 70%",
    vehicle: { fuel: "petrol", co2: 130, euroNorm: 6, firstRegistration: "2023-01" },
    expected: Math.round(bivRaw(130, 1.0, 27.43) * 0.7 * 100) / 100
  },
  {
    label: "petrol Euro6 130g, 12 years old -> LC floor 10%",
    vehicle: { fuel: "petrol", co2: 130, euroNorm: 6, firstRegistration: "2014-01" },
    expected: Math.max(55.88, Math.round(bivRaw(130, 1.0, 27.43) * 0.10 * 100) / 100)
  },
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

// ---- other-region smoke checks (documented expected values from research) --
console.log("\n== Group 3: Brussels / Wallonia smoke checks (research worked examples) ==\n");
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
  const r = engine.computeBIV(s.vehicle, s.region, REF);
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

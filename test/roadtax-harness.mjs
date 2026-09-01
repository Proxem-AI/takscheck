/*
 * Regression harness for the Flemish annual road tax (verkeersbelasting).
 *
 * Ground truth: the official Vlaamse Belastingdienst simulator
 * (belastingen.fenb.be, assessment year 2026). Pax drove that simulator via a
 * real browser and its JSON API and recorded every response to the cent
 * (research section 12.8). Those 19 recorded values are the assertions below:
 * the validated model must reproduce each official road tax to the cent.
 *
 * Fixed inputs per Pax: personenwagen, natural person, new car, first
 * registration 15/01/2026 (age correction 100 percent), assessment year 2026,
 * Flanders. The two electric rows carry their own registration dates.
 *
 * Run: node test/roadtax-harness.mjs   (self-exiting, no browser, no server)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const tariffs = JSON.parse(readFileSync(join(root, "core", "tariffs.json"), "utf8"));
const { createTaxEngine } = require(join(root, "core", "tax.js"));
const engine = createTaxEngine(tariffs);

const TOL = 0.02; // to the cent, allowing simulator rounding (e.g. 330e 399.34 vs 399.32)
const REF = "2026-06-15";
const REG_NEW = "2026-01"; // new car, first registration 15/01/2026

// ---- Pax validation table (research section 12.8), 19 rows -----------------
// fuel classes: petrol, diesel, cng, lpg, phev (= hybrid-petrol), electric.
const rows = [
  { n: 1,  fuel: "petrol", pk: 4,  co2: 130, euro: 6, reg: REG_NEW, expected: 81.64,   note: "low PK" },
  { n: 2,  fuel: "petrol", pk: 7,  co2: 130, euro: 6, reg: REG_NEW, expected: 193.03,  note: "" },
  { n: 3,  fuel: "petrol", pk: 9,  co2: 130, euro: 6, reg: REG_NEW, expected: 284.20,  note: "reference cell" },
  { n: 4,  fuel: "petrol", pk: 11, co2: 130, euro: 6, reg: REG_NEW, expected: 427.50,  note: "bracket jump" },
  { n: 5,  fuel: "petrol", pk: 15, co2: 130, euro: 6, reg: REG_NEW, expected: 819.41,  note: "" },
  { n: 6,  fuel: "petrol", pk: 20, co2: 130, euro: 6, reg: REG_NEW, expected: 2089.13, note: "" },
  { n: 7,  fuel: "petrol", pk: 9,  co2: 95,  euro: 6, reg: REG_NEW, expected: 246.57,  note: "CO2 lower" },
  { n: 8,  fuel: "petrol", pk: 9,  co2: 250, euro: 6, reg: REG_NEW, expected: 413.22,  note: "CO2 higher" },
  { n: 9,  fuel: "petrol", pk: 9,  co2: 130, euro: 4, reg: REG_NEW, expected: 293.15,  note: "Euro 4" },
  { n: 10, fuel: "petrol", pk: 9,  co2: 130, euro: 0, reg: REG_NEW, expected: 445.47,  note: "Euro 0" },
  { n: 11, fuel: "diesel", pk: 9,  co2: 130, euro: 6, reg: REG_NEW, expected: 391.71,  note: "diesel surcharge" },
  { n: 12, fuel: "diesel", pk: 13, co2: 130, euro: 6, reg: REG_NEW, expected: 859.17,  note: "" },
  { n: 13, fuel: "cng",    pk: 9,  co2: 130, euro: 6, reg: REG_NEW, expected: 284.20,  note: "equals petrol" },
  { n: 14, fuel: "lpg",    pk: 9,  co2: 130, euro: 6, reg: REG_NEW, expected: 286.62,  note: "VB 137.94 + AVB 148.68" },
  { n: 15, fuel: "phev",   pk: 13, co2: 35,  euro: 6, reg: REG_NEW, expected: 399.32,  note: "BMW 330e cell" },
  { n: 16, fuel: "phev",   pk: 9,  co2: 130, euro: 6, reg: REG_NEW, expected: 284.20,  note: "no PHEV break" },
  { n: 17, fuel: "electric", pk: null, co2: 0, euro: null, reg: "2026-01", expected: 107.18, note: "new EV flat, 1 Jul 2026 indexation (was 102.96 for 1 Jul 2025 to 30 Jun 2026)" },
  { n: 18, fuel: "electric", pk: null, co2: 0, euro: null, reg: "2020-06", expected: 0.00,   note: "retained exemption" },
  { n: 19, fuel: "petrol", pk: 4,  co2: 1,   euro: 6, reg: REG_NEW, expected: 58.55,   note: "minimum floor" }
];

function buildVehicle(r) {
  var isEv = r.fuel === "electric" || r.fuel === "hydrogen";
  return {
    fuel: r.fuel,
    co2: r.co2,
    euroNorm: r.euro,
    firstRegistration: r.reg,
    fiscalHp: r.pk != null ? r.pk : undefined,
    // Real BEVs report no cylinder capacity; the zero-emission guard keys on cc.
    displacementCc: isEv ? undefined : 1600
  };
}

console.log("Flemish road-tax regression harness  (tariffs v" + tariffs.version + ", tolerance +/-" + TOL.toFixed(2) + " EUR)\n");
console.log("== Pax validation table, 19 rows, all Flanders, assessment year 2026 ==\n");

let failures = 0;
let maxDelta = 0;
for (const r of rows) {
  const v = buildVehicle(r);
  const res = engine.computeRijtaks(v, "flanders", REF);
  const got = res.amount;
  const delta = Math.abs(got - r.expected);
  if (delta > maxDelta) maxDelta = delta;
  const ok = delta <= TOL;
  if (!ok) failures++;
  const label = (r.fuel + " PK" + (r.pk ?? "-") + " " + r.co2 + "g E" + (r.euro ?? "-")).padEnd(24);
  console.log(
    (ok ? "  PASS " : "  FAIL ") + String(r.n).padStart(2) + "  " + label +
    " expected " + r.expected.toFixed(2).padStart(9) +
    "   got " + Number(got).toFixed(2).padStart(9) +
    "   d=" + delta.toFixed(3) +
    "   [" + res.confidence + "]"
  );
}

// ---- 330e end-to-end: three fiscal-PK sources (research section 12.6) -------
console.log("\n== BMW 330e end to end (PHEV, CO2 35, Euro 6, cc 1998) ==\n");
const bmwCases = [
  { label: "cc 1998 -> official cc table 11 PK", vehicle: { fuel: "phev", co2: 35, euroNorm: 6, firstRegistration: REG_NEW, displacementCc: 1998 }, approx: 273.86, expectConf: "low" },
  { label: "certificate 13 PK (lister value)",   vehicle: { fuel: "phev", co2: 35, euroNorm: 6, firstRegistration: REG_NEW, displacementCc: 1998, fiscalHp: 13 }, approx: 399.32, expectConf: "high" }
];
for (const c of bmwCases) {
  const res = engine.computeRijtaks(c.vehicle, "flanders", REF);
  const okAmt = Math.abs(res.amount - c.approx) <= 0.03;
  const okConf = res.confidence === c.expectConf;
  console.log(
    (okAmt && okConf ? "  OK   " : "  DIFF ") + c.label.padEnd(38) +
    " ~" + c.approx.toFixed(2).padStart(9) + "  got " + Number(res.amount).toFixed(2).padStart(9) +
    "  conf " + res.confidence + (okConf ? "" : " (expected " + c.expectConf + ")")
  );
}

console.log("\n---------------------------------------------------------------");
console.log("Road-tax assertions: " + (rows.length - failures) + "/" + rows.length + " to the cent. Max delta: " + maxDelta.toFixed(3) + " EUR.");
if (failures > 0) {
  console.log("RESULT: FAIL (" + failures + " mismatch" + (failures === 1 ? "" : "es") + ").");
  process.exit(1);
} else {
  console.log("RESULT: PASS. Validated Flemish road-tax model matches the official simulator to the cent.");
  process.exit(0);
}

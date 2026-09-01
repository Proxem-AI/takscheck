/*
 * Simulator comparison harness (Flanders).
 *
 * Ground truth: test/simulator-comparison-2026-09.json, a 29 case set captured
 * by Pax on 2026-09-01 by driving the public Vlaamse Belastingdienst wizard at
 * belastingen.fenb.be one case at a time in a real browser. Every case was
 * chosen so that it isolates one variable: age band, CO2 level, fuel type,
 * fiscal PK step, euronorm, soot filter, and the NEDC / WLTP CO2 branch.
 *
 * This harness does NOT replace test/harness.mjs or test/roadtax-harness.mjs.
 * Those two assert the engine against new car captures from the 1 July 2025
 * indexation window and must keep passing. This one is the measurement net for
 * the divergence Pax was asked to find, and it is expected to FAIL rows until
 * the engine is corrected. It reports rather than blocks by default.
 *
 * Run: node test/simulator-comparison-harness.mjs
 *      node test/simulator-comparison-harness.mjs --strict   (exit 1 on any row outside tolerance)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const tariffs = JSON.parse(readFileSync(join(root, "core", "tariffs.json"), "utf8"));
const fixture = JSON.parse(readFileSync(join(__dirname, "simulator-comparison-2026-09.json"), "utf8"));
const { createTaxEngine } = require(join(root, "core", "tax.js"));
const engine = createTaxEngine(tariffs);

const STRICT = process.argv.includes("--strict");
const TOL = 0.05; // EUR

// fixture fuel labels -> engine fuel classes
const FUEL = {
  "petrol": "petrol", "diesel": "diesel", "lpg-petrol": "lpg",
  "cng": "cng", "hybrid-petrol": "hybrid", "electric": "electric"
};

// "dd/mm/yyyy" -> "yyyy-mm-dd"
function iso(d) { const p = d.split("/"); return p[2] + "-" + p[1] + "-" + p[0]; }

function toVehicle(c) {
  const v = c.vehicle;
  const fuel = FUEL[v.fuel];
  const ev = fuel === "electric" || fuel === "hydrogen";
  return {
    fuel: fuel,
    co2: ev ? null : v.co2,
    euroNorm: ev ? null : v.euroNorm,
    firstRegistration: iso(v.firstRegistration),
    fiscalHp: v.fiscalPk,
    displacementCc: ev ? null : 1600
  };
}

function pct(a, b) { return b ? ((a - b) / b) * 100 : null; }
function fmt(n, w) { return (n == null ? "-" : Number(n).toFixed(2)).padStart(w); }
function fmtp(n, w) { return (n == null ? "-" : (n >= 0 ? "+" : "") + Number(n).toFixed(1) + "%").padStart(w); }

console.log("Simulator comparison harness  (fixture " + fixture.capturedOn + ", tariffs v" + tariffs.version + ")");
console.log(fixture.fixedInputs + "\n");

const stat = { biv: { all: [], nedc: [], wltp: [] }, tax: { all: [], nedc: [], wltp: [] } };
let worse = 0, outside = 0;
let group = null;

console.log("case         cyc   official     engine      delta    err%   | official     engine      delta    err%");
console.log("                        BIV        BIV        BIV           |  roadtax    roadtax    roadtax");
for (const c of fixture.cases) {
  if (c.group !== group) { group = c.group; console.log("-- " + group + " " + "-".repeat(Math.max(0, 92 - group.length))); }
  const veh = toVehicle(c);
  const ref = iso(c.vehicle.registrationDate);
  const b = engine.computeBIV(veh, "flanders", ref);
  const t = engine.computeRijtaks(veh, "flanders", ref);

  const offB = c.official.biv, offT = c.official.roadTaxTotal;
  const dB = b.amount == null ? null : offB - b.amount;
  const dT = t.amount == null ? null : offT - t.amount;
  const pB = b.amount == null ? null : pct(offB, b.amount);
  const pT = t.amount == null ? null : pct(offT, t.amount);

  const cyc = c.vehicle.simulatorCo2Cycle === "NEDC" ? "N" : "W";
  const bucket = c.vehicle.simulatorCo2Cycle === "NEDC" ? "nedc" : "wltp";
  if (pB != null) { stat.biv.all.push(pB); stat.biv[bucket].push(pB); }
  if (pT != null) { stat.tax.all.push(pT); stat.tax[bucket].push(pT); }

  if (dB != null && Math.abs(dB) > TOL) outside++;
  if (dT != null && Math.abs(dT) > TOL) outside++;
  if (dB != null && Math.abs(dB) > Math.abs(c.deltaAtCapture.bivEur) + TOL) worse++;
  if (dT != null && Math.abs(dT) > Math.abs(c.deltaAtCapture.roadTaxEur) + TOL) worse++;

  console.log(
    c.id.padEnd(12) + " " + cyc + "  " + fmt(offB, 10) + fmt(b.amount, 11) + fmt(dB, 11) + fmtp(pB, 8) +
    "   |" + fmt(offT, 9) + fmt(t.amount, 11) + fmt(dT, 11) + fmtp(pT, 8)
  );
}

function summary(name, arr) {
  if (!arr.length) return name + ": no rows";
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const abs = arr.map(Math.abs).sort((a, b) => a - b);
  const meanAbs = abs.reduce((a, b) => a + b, 0) / abs.length;
  const median = abs[Math.floor(abs.length / 2)];
  return name.padEnd(46) + "n=" + String(arr.length).padStart(2) +
    "  mean " + (mean >= 0 ? "+" : "") + mean.toFixed(2) + "%" +
    "  mean|err| " + meanAbs.toFixed(2) + "%" +
    "  median|err| " + median.toFixed(2) + "%" +
    "  worst " + Math.max(...abs).toFixed(2) + "%";
}

console.log("\n== measured error of the engine against the official simulator ==\n");
console.log(summary("BIV, all cases", stat.biv.all));
console.log(summary("BIV, WLTP branch (first reg from 01/01/2021)", stat.biv.wltp));
console.log(summary("BIV, NEDC branch (first reg before 01/01/2021)", stat.biv.nedc));
console.log(summary("Road tax, all cases", stat.tax.all));
console.log(summary("Road tax, WLTP branch", stat.tax.wltp));
console.log(summary("Road tax, NEDC branch", stat.tax.nedc));

console.log("\n---------------------------------------------------------------");
console.log("Rows outside +/-" + TOL.toFixed(2) + " EUR of the official value: " + outside + " of " + (fixture.cases.length * 2) + " comparisons.");
console.log("Rows that drifted FURTHER from official than the 2026-09-01 baseline: " + worse + ".");
if (worse > 0) {
  console.log("RESULT: REGRESSION. Something moved the engine away from the simulator.");
  process.exit(1);
}
if (STRICT && outside > 0) {
  console.log("RESULT: FAIL (--strict). " + outside + " comparison(s) still diverge from the official simulator.");
  process.exit(1);
}
console.log("RESULT: no regression against the recorded baseline. Run with --strict once the engine is corrected.");
process.exit(0);

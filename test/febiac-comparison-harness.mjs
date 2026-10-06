/*
 * FEBIAC Taxo comparison harness, all three regions.
 *
 * Ground truth: test/febiac-comparison-2026-10.json, 16 submissions captured by
 * Pax from FEBIAC's Taxo Lite wizard between 1 and 6 October 2026. One Taxo
 * submission returns Flanders, Brussels and Wallonia off the same result
 * screen, so 16 submissions give 48 region cases and 96 BIV and road tax
 * comparisons.
 *
 * This is the sibling of test/simulator-comparison-harness.mjs and does not
 * replace it. That one is Flanders against the Vlaamse Belastingdienst's own
 * simulator, which is a primary government source. This one is all three
 * regions against a private intermediary, which is why the two disagree on one
 * family of cases and why those cases are frozen here as known mismatches
 * rather than as expectations: where FEBIAC contradicts VLABEL on a vehicle
 * VLABEL itself priced, VLABEL wins.
 *
 * What gates and what does not. Every comparison carries a status in the
 * fixture. status "expect" gates the build under --strict. status
 * known-mismatch is printed on every run with its reason and never gates, so
 * the four open questions stay visible without blocking. Freezing a known
 * defect as the expected value would hide it; dropping it from the fixture
 * would lose it.
 *
 * Brussels and Wallonia are outside tariffs.scope.validatedRegions, so the
 * shipped engine returns a not-validated descriptor for them instead of an
 * amount. This harness therefore runs against a deliberately unscoped COPY of
 * the tariff table, the same way test/harness.mjs group 4 does. The shipped
 * scope gate is not touched and is still asserted by test/harness.mjs.
 *
 * Run: node test/febiac-comparison-harness.mjs
 *      node test/febiac-comparison-harness.mjs --strict   (exit 1 on any gating row outside tolerance)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const tariffs = JSON.parse(readFileSync(join(root, "core", "tariffs.json"), "utf8"));
const fixture = JSON.parse(readFileSync(join(__dirname, "febiac-comparison-2026-10.json"), "utf8"));
const { createTaxEngine } = require(join(root, "core", "tax.js"));

// Unscoped copy, so the Brussels and Wallonia formulas are measurable while the
// shipped engine still refuses to present them. Scope is data, not code.
const engine = createTaxEngine({
  ...tariffs,
  scope: { ...tariffs.scope, validatedRegions: ["flanders", "brussels", "wallonia"] }
});

const STRICT = process.argv.includes("--strict");
const TOL = fixture.tolerance;
const REGIONS = ["flanders", "brussels", "wallonia"];

// The reference date is each batch's own capture date, read from the fixture.
// Every one of them falls inside the 1 July 2026 indexation window, which is
// the window the captured figures were billed off.
function compute(sub, region) {
  return {
    biv: engine.computeBIV(sub.vehicle, region, sub.capturedOn).amount,
    roadTax: engine.computeRijtaks(sub.vehicle, region, sub.capturedOn).amount
  };
}

console.log("FEBIAC Taxo comparison harness  (tariffs v" + tariffs.version +
  ", fixture " + fixture.capturedOn + ", tolerance +/-" + TOL.toFixed(2) + " EUR)");
console.log(fixture.source);
console.log("");

let gating = 0, gatingFail = 0, known = 0, knownStillOff = 0, improved = 0, worse = 0;
const failures = [];
const knownRows = [];

for (const sub of fixture.submissions) {
  console.log(sub.id + "  " + sub.batch + "  " + sub.label);
  console.log("  " + sub.planCaseIds.join(", "));
  for (const region of REGIONS) {
    const cells = sub.regions[region];
    if (!cells) continue;
    const got = compute(sub, region);
    for (const tax of ["biv", "roadTax"]) {
      const cell = cells[tax];
      const engineNow = got[tax];
      const delta = engineNow == null ? null : Math.round((engineNow - cell.official) * 100) / 100;
      const ok = delta != null && Math.abs(delta) <= TOL;

      // Did this cell move towards or away from FEBIAC since the capture?
      const wasOff = Math.abs(cell.deltaAtCapture);
      const nowOff = delta == null ? Infinity : Math.abs(delta);
      let drift = "same";
      if (nowOff < wasOff - 0.005) { drift = "better"; improved++; }
      else if (nowOff > wasOff + 0.005) { drift = "WORSE"; worse++; }

      const tag = cell.status === "expect" ? (ok ? "PASS " : "FAIL ") : (ok ? "known/now-ok" : "known");
      const line = "    " + tag.padEnd(12) + region.padEnd(9) + tax.padEnd(8) +
        " official " + cell.official.toFixed(2).padStart(9) +
        "   engine " + (engineNow == null ? "null" : Number(engineNow).toFixed(2)).padStart(9) +
        "   d " + (delta == null ? "n/a" : (delta >= 0 ? "+" : "") + delta.toFixed(2)).padStart(8) +
        "   (at capture " + (cell.deltaAtCapture >= 0 ? "+" : "") + cell.deltaAtCapture.toFixed(2) + ", " + drift + ")";
      console.log(line);

      if (cell.status === "expect") {
        gating++;
        if (!ok) { gatingFail++; failures.push(sub.id + " " + region + " " + tax + ": official " + cell.official.toFixed(2) + ", engine " + (engineNow == null ? "null" : Number(engineNow).toFixed(2))); }
      } else {
        known++;
        if (!ok) { knownStillOff++; knownRows.push(sub.id + " " + region + " " + tax + ": " + cell.note); }
      }
    }
  }
  console.log("");
}

console.log("== known mismatches, reported every run, never gating ==\n");
for (const r of knownRows) console.log("  " + r + "\n");
if (knownStillOff !== known) {
  console.log("  NOTE: " + (known - knownStillOff) + " of the " + known +
    " known mismatches now match. Promote them to status expect in the fixture.\n");
}

console.log("---------------------------------------------------------------");
console.log("Comparisons: " + (gating + known) + " over " + fixture.submissions.length +
  " submissions (" + gating + " gating, " + known + " known mismatches).");
console.log("Gating comparisons inside +/-" + TOL.toFixed(2) + " EUR: " + (gating - gatingFail) + "/" + gating + ".");
console.log("Moved towards FEBIAC since capture: " + improved + ". Moved away: " + worse + ".");

if (worse > 0) {
  console.log("");
  console.log("RESULT: REGRESSION. " + worse + " comparison(s) drifted further from FEBIAC than the 2026-10 capture baseline.");
  process.exit(1);
}
if (gatingFail > 0) {
  console.log("");
  for (const f of failures) console.log("  FAIL " + f);
  console.log("");
  if (STRICT) {
    console.log("RESULT: FAIL (--strict). " + gatingFail + " gating comparison(s) diverge from FEBIAC.");
    process.exit(1);
  }
  console.log("RESULT: " + gatingFail + " gating comparison(s) still diverge. Run with --strict to gate the build on them.");
  process.exit(0);
}
console.log("");
console.log("RESULT: PASS. Every gating comparison matches FEBIAC within tolerance.");
process.exit(0);

/*
 * Pins the BIV q coefficient (flanders.biv.qWindows) by calendar year.
 *
 * Why this exists next to window-expiry-check.mjs. That ratchet proves the build
 * goes red when the newest window lapses. It does not prove which q each year is
 * served, and q sits under a sixth power, so a 0.035 slip is about 18 percent on
 * the CO2 component of every WLTP car. This file asserts the numbers.
 *
 * The expected values are written out here from the statute, not read from the
 * engine and not computed in a loop: VCF art. 2.3.4.1.2/1, tweede lid, 3:
 * "q is gelijk aan 1,07 in 2021 en wordt jaarlijks verhoogd met 0,035 vanaf het
 * jaar 2022" (codex.vlaanderen.be, document 1023499, article in force from
 * 01/01/2021 with no end date). That reads 1.245 for 2026 and 1.28 for 2027.
 *
 * Beyond the table (2028 and later) there is deliberately NO expected q. The
 * contract is: serve the newest window we hold, label it stale, and never
 * extrapolate. The 2028 case below fails if anyone makes the engine climb on its
 * own (1.315).
 *
 * Run:  node test/q-windows.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tariffs = JSON.parse(readFileSync(join(root, "core", "tariffs.json"), "utf8"));
const { createTaxEngine, pickWindow } = require(join(root, "core", "tax.js"));
const engine = createTaxEngine(tariffs);

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? "  PASS " : "  FAIL ") + name + (detail ? "  (" + detail + ")" : ""));
  if (!ok) failures++;
}
function qAt(date) {
  const p = pickWindow(tariffs.flanders.biv, date, "qWindows");
  return { q: p.values.q, status: p.vintage.status };
}

// A WLTP car (first registered after 31/12/2020), so q is in the numerator.
const probe = { fuel: "petrol", co2: 130, euroNorm: 6, fiscalHp: 9, firstRegistration: "2023-05-15" };
const bivAt = (date) => engine.computeAll(probe, "flanders", date);

console.log("BIV q coefficient by year\n");

// 2026: the value confirmed against the 29 case simulator capture.
for (const d of ["2026-01-01", "2026-06-30", "2026-12-31"]) {
  const r = qAt(d);
  check("q on " + d + " is 1.245 and current", r.q === 1.245 && r.status === "current", r.q + ", " + r.status);
}

// 2027: statute value, must flip exactly on 1 January.
for (const d of ["2027-01-01", "2027-06-30", "2027-12-31"]) {
  const r = qAt(d);
  check("q on " + d + " is 1.28 and current", r.q === 1.28 && r.status === "current", r.q + ", " + r.status);
}

// Beyond the table: newest window held, labelled stale, never extrapolated.
for (const d of ["2028-01-01", "2028-06-30"]) {
  const r = qAt(d);
  check("q on " + d + " stays 1.28 and is labelled stale, not extrapolated to 1.315",
    r.q === 1.28 && r.status === "stale", r.q + ", " + r.status);
}
{
  const r = qAt("2029-01-01");
  check("q on 2029-01-01 is labelled expired (more than 12 months past the table)",
    r.q === 1.28 && r.status === "expired", r.q + ", " + r.status);
}

// End to end: the 1 January 2027 step must reach the amount, upward, and the
// year beyond the table must not silently keep looking current.
const a2026 = bivAt("2026-12-31"), a2027 = bivAt("2027-01-01");
check("BIV for the WLTP probe rises across 31/12/2026 -> 01/01/2027",
  a2026.biv.amount != null && a2027.biv.amount != null && a2027.biv.amount > a2026.biv.amount,
  a2026.biv.amount + " -> " + a2027.biv.amount);

const a2028 = bivAt("2028-01-01");
check("BIV on 2028-01-01 is not served as current",
  a2028.dataVintage && a2028.dataVintage.status !== "current",
  a2028.dataVintage && a2028.dataVintage.status);

console.log("");
if (failures) {
  console.error("RESULT: FAIL (" + failures + ").");
  process.exit(1);
}
console.log("RESULT: PASS.");

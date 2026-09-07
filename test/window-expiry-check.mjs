/*
 * Ratchet: fail the build once the tariff tables are out of date.
 *
 * Modelled on the two ratchets in the hc-margin build.sh, which do the same job
 * there: convert a defect that would otherwise appear silently in the field into
 * a loud failure at build time.
 *
 * The problem this exists for. core/tariffs.json carries dated windows. The
 * Flemish BIV and road tax amounts are re-indexed every 1 July and the BIV q
 * coefficient moves every 1 January. When a window lapses the engine keeps
 * computing, which is deliberate (see the staleness ladder in core/tax.js), but
 * nothing would ever prompt anyone to put the new numbers in. q is the sharp
 * end: it sits inside a term raised to the sixth power, so its 2.8 per cent
 * annual step lands as roughly 18 per cent on the CO2 component of the BIV, on
 * every car first registered from 01/01/2021.
 *
 * The dates below are read straight out of core/tariffs.json with JSON.parse and
 * compared against the system clock. They are NOT obtained from core/tax.js.
 * A check that asks the code under test what it expects proves nothing, and this
 * project has already been bitten by exactly that.
 *
 * Run:  node test/window-expiry-check.mjs
 * Prove it can fail:  TAKSCHECK_TODAY=2027-01-01 node test/window-expiry-check.mjs
 *
 * TAKSCHECK_TODAY is a test hook for that proof only. Never set it in CI: it
 * exists so the ratchet can be demonstrated to bite, not so it can be dodged.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const tariffs = JSON.parse(readFileSync(join(root, "core", "tariffs.json"), "utf8"));

// Twelve months is hardcoded here on purpose. Importing STALE_GRACE_MONTHS from
// the engine would make this test agree with the engine by construction, which
// is the failure mode that lets a wrong answer through green.
const GRACE_MONTHS = 12;
const WARN_DAYS = 60;

const today = (process.env.TAKSCHECK_TODAY || new Date().toISOString().slice(0, 10)).trim();
if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) {
  console.error("FAIL: TAKSCHECK_TODAY must be YYYY-MM-DD, got " + JSON.stringify(today));
  process.exit(1);
}

function daysBetween(a, b) {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
}

// Collect every dated window series in the file, wherever it lives, so a series
// added later (Brussels and Wallonia, when they are validated) is covered
// without anyone remembering to extend this list.
function collectSeries(node, path, out) {
  if (!node || typeof node !== "object") return out;
  for (const [key, value] of Object.entries(node)) {
    const here = path ? path + "." + key : key;
    if (Array.isArray(value)) {
      if (/Windows$/.test(key) && value.some((w) => w && typeof w === "object" && w.from)) {
        out.push({ path: here, windows: value });
      }
      continue;
    }
    if (value && typeof value === "object") collectSeries(value, here, out);
  }
  return out;
}

const series = collectSeries(tariffs, "", []);
let failures = 0;

console.log("Tariff window expiry ratchet  (tariffs v" + tariffs.version + ", today " + today +
  (process.env.TAKSCHECK_TODAY ? ", CLOCK FAKED VIA TAKSCHECK_TODAY" : "") + ")\n");

if (!series.length) {
  console.error("FAIL: no dated window series found in core/tariffs.json.");
  console.error("Either the file lost its indexWindows / qWindows, or this check stopped finding them.");
  process.exit(1);
}

// --- structural: a window without both bounds cannot be checked at all -------
for (const s of series) {
  for (const w of s.windows) {
    if (!w.from || !w.until) {
      console.error("FAIL: " + s.path + " has a window without both a from and an until (" +
        JSON.stringify({ from: w.from || null, until: w.until || null }) + ").");
      console.error("Every window needs both bounds. Selecting on from alone is the defect this file exists to prevent.");
      failures++;
    } else if (w.from > w.until) {
      console.error("FAIL: " + s.path + " has a window whose from (" + w.from + ") is after its until (" + w.until + ").");
      failures++;
    }
  }
}
if (failures) process.exit(1);

// --- the ratchet: the newest window of every series must still be live -------
// Older windows are meant to be in the past. They stay in the file because an
// assessment dated inside them is still billed off them.
let deadline = null;
let deadlinePath = null;

for (const s of series) {
  const newest = s.windows.reduce((a, b) => (a.until >= b.until ? a : b));
  const daysLeft = daysBetween(today, newest.until);
  const state = daysLeft < 0 ? "EXPIRED" : (daysLeft <= WARN_DAYS ? "expiring" : "live");
  console.log("  " + state.padEnd(9) + s.path.padEnd(38) +
    newest.from + " to " + newest.until +
    (daysLeft < 0 ? "   " + -daysLeft + " days past" : "   " + daysLeft + " days left"));
  if (deadline === null || newest.until < deadline) { deadline = newest.until; deadlinePath = s.path; }
}

const daysLeft = daysBetween(today, deadline);
console.log("\nEarliest expiry: " + deadlinePath + " on " + deadline + ".");

if (daysLeft < 0) {
  const graceEnd = (() => {
    const y = +deadline.slice(0, 4), m = +deadline.slice(5, 7), d = +deadline.slice(8, 10);
    const t = y * 12 + (m - 1) + GRACE_MONTHS;
    const ny = Math.floor(t / 12), nm = (t % 12) + 1;
    const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
    return String(ny).padStart(4, "0") + "-" + String(nm).padStart(2, "0") + "-" + String(Math.min(d, last)).padStart(2, "0");
  })();
  console.error("\nFAIL: the newest window in " + deadlinePath + " expired on " + deadline +
    ", " + -daysLeft + " day" + (daysLeft === -1 ? "" : "s") + " ago.");
  console.error("TaksCheck is now quoting rates it knows are out of date. Users see them labelled");
  console.error("stale and the input tier is forced down, and from " + graceEnd + " the amounts stop");
  console.error("being shown at all. That is the safety net, not the fix.");
  console.error("");
  console.error("The fix: capture the new rates and add a window to " + deadlinePath + ".");
  console.error("  Amounts (1 July cycle): re-run the official Vlaamse Belastingdienst simulator");
  console.error("  the way test/simulator-comparison-2026-09.json was captured, and add the new");
  console.error("  set to indexWindows, newest first.");
  console.error("  q (1 January cycle): read the value from VCF art. 2.3.4.1.2/1, tweede lid, 3");
  console.error("  and add it to flanders.biv.qWindows. Do NOT extrapolate it by adding 0.035:");
  console.error("  the escalator can be stopped by decree, and a formula that keeps climbing on");
  console.error("  its own is a silent wrong answer by design.");
  failures++;
} else if (daysLeft <= WARN_DAYS) {
  console.log("WARNING: " + daysLeft + " days until this build starts failing. Capture the new rates now.");
}

// --- behavioural: the engine must not call a lapsed window current -----------
// The expectation comes from the date in the JSON, not from the engine, so this
// is a cross-check rather than a restatement.
const { createTaxEngine } = require(join(root, "core", "tax.js"));
const engine = createTaxEngine(tariffs);
const probe = { fuel: "petrol", co2: 130, euroNorm: 6, fiscalHp: 9, firstRegistration: "2023-05-15" };

function dayAfter(iso) {
  return new Date(Date.parse(iso + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);
}
function plusMonths(iso, n) {
  const y = +iso.slice(0, 4), m = +iso.slice(5, 7), d = +iso.slice(8, 10);
  const t = y * 12 + (m - 1) + n;
  const ny = Math.floor(t / 12), nm = (t % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return String(ny).padStart(4, "0") + "-" + String(nm).padStart(2, "0") + "-" + String(Math.min(d, last)).padStart(2, "0");
}

console.log("");
const justAfter = engine.computeAll(probe, "flanders", dayAfter(deadline));
const okStale = justAfter.dataVintage && justAfter.dataVintage.status === "stale" && justAfter.biv.amount != null;
console.log((okStale ? "  PASS " : "  FAIL ") +
  "one day past " + deadline + ": labelled stale, amount still shown (" +
  (justAfter.dataVintage && justAfter.dataVintage.status) + ", " + justAfter.biv.amount + ")");
if (!okStale) failures++;

const wellAfter = engine.computeAll(probe, "flanders", plusMonths(dayAfter(deadline), GRACE_MONTHS + 1));
const okExpired = wellAfter.dataVintage && wellAfter.dataVintage.status === "expired" && wellAfter.biv.amount === null;
console.log((okExpired ? "  PASS " : "  FAIL ") +
  "more than " + GRACE_MONTHS + " months past " + deadline + ": amount withdrawn (" +
  (wellAfter.dataVintage && wellAfter.dataVintage.status) + ", " + wellAfter.biv.amount + ")");
if (!okExpired) failures++;

const current = engine.computeAll(probe, "flanders", deadline);
const okCurrent = current.dataVintage && current.dataVintage.status === "current" && current.biv.amount != null;
console.log((okCurrent ? "  PASS " : "  FAIL ") +
  "on " + deadline + " itself: still current, amount shown (" +
  (current.dataVintage && current.dataVintage.status) + ", " + current.biv.amount + ")");
if (!okCurrent) failures++;

console.log("");
if (failures) {
  console.error("RESULT: FAIL (" + failures + ").");
  process.exit(1);
}
console.log("RESULT: PASS. Every window is live and the staleness ladder behaves.");

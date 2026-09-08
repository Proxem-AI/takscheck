/*
 * Fiscal PK derivation: cover the branches real users actually hit.
 *
 * deriveFiscalHp in core/tax.js has four branches. The first one, which reads
 * vehicle.fiscalHp and reports confidence "high" with the assumption "fiscal HP
 * taken from the ad", is UNREACHABLE IN PRODUCTION. Nothing outside the test
 * suite sets that field: BivNormalise does not emit it, neither content script
 * writes it, and the popup and service worker never touch it. Verified by search
 * on 2026-09-09.
 *
 * That mattered because five test files supplied fiscalHp, so the branch no user
 * can reach was the best covered one in the suite, while the branches carrying
 * every production figure, from displacementCc and from powerKw, had almost no
 * coverage. This file covers those.
 *
 * Expectations come from the belastbare-kracht table in core/tariffs.json, which
 * carries its own provenance, read off by hand. Nothing here recomputes what
 * core/tax.js computes. That rule is the whole of task 118.
 *
 * Run: node test/fiscal-hp.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const tariffs = JSON.parse(readFileSync(join(root, "core", "tariffs.json"), "utf8"));
const Tax = require(join(root, "core", "tax.js"));
const inf = tariffs.inference;

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log("  ok   " + label); }
  else { failed++; console.log("  FAIL " + label); }
}
function eq(actual, expected, label) {
  ok(actual === expected, label + "  expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
}

console.log("Fiscal PK derivation\n");
console.log("== branch selection and the confidence each branch reports ==\n");

const D = (v) => Tax.deriveFiscalHp(v, inf);

// Branch 1. Test-only: nothing in production sets fiscalHp. Asserted so that the
// day something starts setting it, this file says so out loud.
const fromAd = D({ fiscalHp: 11, displacementCc: 1995 });
eq(fromAd.value, 11, "fiscalHp present: value taken verbatim");
eq(fromAd.confidence, "high", "fiscalHp present: confidence high");
ok(/taken from the ad/.test(fromAd.assumption), "fiscalHp present: assumption says it came from the ad");

// Branch 3, the one almost every combustion advert takes.
const fromCc = D({ displacementCc: 1600 });
eq(fromCc.confidence, "medium", "from cc: confidence medium, not high");
ok(/derived from cc/.test(fromCc.assumption), "from cc: assumption says derived, never 'from the ad'");

// Branch 4, taken when the advert lists power but no cylinder capacity.
const fromKw = D({ powerKw: 110 });
eq(fromKw.confidence, "low", "from kW only: confidence low");
ok(/roughly estimated from kW/.test(fromKw.assumption), "from kW only: assumption says roughly estimated");

// Branch 2, electric.
const fromEv = D({ fuel: "electric", powerKw: 150 });
eq(fromEv.confidence, "low", "EV from kW: confidence low");
ok(/EV fiscal HP estimated from kW/.test(fromEv.assumption), "EV from kW: assumption names the approximate table");

// Nothing to go on.
const fromNothing = D({});
eq(fromNothing.value, null, "no cc and no kW: value null");
eq(fromNothing.confidence, "none", "no cc and no kW: confidence none");

// Precedence: cc beats the kW last resort, and an EV takes the EV table even
// when it also carries a cylinder capacity from a mislabelled advert.
eq(D({ displacementCc: 1600, powerKw: 110 }).confidence, "medium", "cc wins over the kW last resort");
ok(/EV fiscal HP/.test(D({ fuel: "electric", powerKw: 150, displacementCc: 1600 }).assumption),
   "an electric vehicle takes the EV table even when cc is present");

console.log("\n== the cc to fiscal PK table, read off core/tariffs.json ==\n");
// Band edges, both sides. Values are read from inference.fiscalPkByCc by hand,
// not computed here.
const CC_CASES = [
  [700, 4], [750, 4], [751, 5], [950, 5], [951, 6],
  [1350, 7], [1550, 8], [1551, 9], [1600, 9], [1750, 9], [1751, 10],
  [1995, 11], [2350, 12], [3050, 15], [3051, 16], [4050, 20]
];
for (const [cc, pk] of CC_CASES) eq(D({ displacementCc: cc }).value, pk, "cc " + cc + " -> fiscal pk");

// Below the smallest band the statutory minimum applies rather than a lower number.
eq(D({ displacementCc: 50 }).value, inf.fiscalHpMin, "a tiny engine floors at the statutory minimum of " + inf.fiscalHpMin);
// Above the last band the table extrapolates. 4051 is one cc past 4050, which is
// inside the first extrapolated step, so it is pk 21.
eq(D({ displacementCc: 4051 }).value, 21, "one cc above the last band steps to 21");

console.log("\n== the production shape: no advert can reach the 'from the ad' branch ==\n");

// The guard that stops this defect returning. If BivNormalise ever starts emitting
// fiscalHp, or a fixture is mistaken for production shape again, this fails.
// normalise.js attaches itself to globalThis, so requiring it for the side effect
// is how the rest of the suite reaches it too.
require(join(root, "core", "normalise.js"));
const globalNorm = globalThis.BivNormalise;
const as24 = globalNorm.fromAutoScout24({
  vehicle: { make: { formatted: "BMW" }, model: { formatted: "320d" },
    firstRegistrationDate: "06/2019", fuelCategory: { formatted: "Diesel" },
    rawPowerInKw: 140, rawDisplacementInCCM: 1995,
    co2emissionInGramPerKmWithFallback: { raw: 148, formatted: "148 g/km (gem.)", isFallback: false } },
  prices: { public: { priceRaw: 24900 } }
});
const mob = globalNorm.fromMobileDe({ jsonld: null, tech: {
  "erstzulassung": "06/2019", "kraftstoffart": "Diesel",
  "leistung": "140 kW (190 PS)", "hubraum": "1.995 cm3", "co2-emissionen": "148 g/km" } });

ok(!("fiscalHp" in as24), "fromAutoScout24 output has no fiscalHp key at all");
ok(!("fiscalHp" in mob), "fromMobileDe output has no fiscalHp key at all");
eq(D(as24).confidence, "medium", "a real AutoScout24 vehicle derives fiscal pk, it never reads it");
eq(D(mob).confidence, "medium", "a real mobile.de vehicle derives fiscal pk, it never reads it");
ok(!/taken from the ad/.test(D(as24).assumption),
   "a real advert is never told its fiscal pk came from the ad");
ok(!/taken from the ad/.test(D(mob).assumption),
   "a real mobile.de advert is never told its fiscal pk came from the ad");

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);

/*
 * AutoScout24 extraction fixtures.
 *
 * Two defects found on the live site on 2026-09-08 and guarded here.
 *
 * 1. co2emissionInGramPerKmWithFallback is an OBJECT, not a string:
 *      { raw: 128, formatted: "128 g/km (mixte)", isFallback: false }
 *    co2FromText only handled numbers and strings, so String() turned it into
 *    "[object Object]" and the authoritative CO2 source was never read. A figure
 *    only ever reached the badge by luck, via the DOM spec-row fallback. The old
 *    fixture in test/host-permissions.mjs passed a STRING for this field, which is
 *    why nothing caught it: the fixture disagreed with reality.
 *
 * 2. readCo2FromSpecs required the CO2 token BEFORE the emission word, which is
 *    the German and Dutch order. French prints "Emissions de CO2", so the DOM
 *    fallback had a hole exactly where defect 1 bit hardest. Proven with the same
 *    advert served in both Belgian languages: identical raw CO2 of 128, the Dutch
 *    page showed the figure and the French page showed "CO2 inconnu".
 *
 * Run: node test/autoscout24-extract.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { parseHTML } from "linkedom";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const tariffs = JSON.parse(readFileSync(join(root, "core", "tariffs.json"), "utf8"));

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log("  ok   " + label); }
  else { failed++; console.log("  FAIL " + label); }
}

// Load the real engine + normaliser in a bare sandbox.
const core = { console };
core.globalThis = core;
vm.createContext(core);
vm.runInContext(readFileSync(join(root, "core", "tax.js"), "utf8"), core, { filename: "tax.js" });
vm.runInContext(readFileSync(join(root, "core", "normalise.js"), "utf8"), core, { filename: "normalise.js" });
const N = core.BivNormalise;

console.log("AutoScout24 extraction fixtures\n");
console.log("== co2FromText value shapes ==\n");

// The real shape, both languages of the same advert.
ok(N.co2FromText({ raw: 128, formatted: "128 g/km (gem.)", isFallback: false }) === 128,
   "object with raw, Dutch formatting, reads 128");
ok(N.co2FromText({ raw: 128, formatted: "128 g/km (mixte)", isFallback: false }) === 128,
   "object with raw, French formatting, reads 128");
// raw absent: fall through to the formatted string rather than giving up.
ok(N.co2FromText({ raw: null, formatted: "142 g/km (mixte)", isFallback: false }) === 142,
   "object with raw null falls back to the formatted string");
// genuinely absent
ok(N.co2FromText({ raw: null, formatted: "- (g/km)", isFallback: false }) === null,
   "object with no figure at all stays null");
// the older shapes must keep working
ok(N.co2FromText("130 g/km") === 130, "plain string still reads");
ok(N.co2FromText(130) === 130, "plain number still reads");
ok(N.co2FromText("35 g/km (gem.)") === 35, "string with a parenthetical still reads");

console.log("\n== fromAutoScout24 with the real object shape ==\n");
function listing(fuel, co2Field) {
  return { vehicle: { make: { formatted: "BMW" }, model: { formatted: "218i" },
    firstRegistrationDate: "10/2020", fuelCategory: { formatted: fuel },
    rawPowerInKw: 100, rawDisplacementInCCM: 1499,
    co2emissionInGramPerKmWithFallback: co2Field,
    bodyType: { formatted: "Coupe" } }, prices: { public: { priceRaw: 24950 } } };
}
const NLV = N.fromAutoScout24(listing("Benzine", { raw: 128, formatted: "128 g/km (gem.)", isFallback: false }));
const FRV = N.fromAutoScout24(listing("Essence", { raw: 128, formatted: "128 g/km (mixte)", isFallback: false }));
ok(NLV.co2 === 128, "be-NL advert: co2 128");
ok(FRV.co2 === 128, "be-FR advert, same car: co2 128");
ok(NLV.co2 === FRV.co2, "the same advert yields the same CO2 in both Belgian languages");
ok(NLV.fuel === "petrol" && FRV.fuel === "petrol", "Benzine and Essence both map to petrol");

console.log("\n== readCo2FromSpecs: DOM fallback label order ==\n");
// co2 absent from the data blob, present only as a rendered spec row. This is the
// path that has to carry French, because raw is null on plenty of real adverts.
function runContentScript(html) {
  const { document } = parseHTML(html);
  const u = new URL("https://www.autoscout24.be/fr/offres/bmw-218i-abc123");
  const location = { href: u.href, pathname: u.pathname, search: u.search, origin: u.origin, hostname: u.hostname };
  const rendered = { count: 0, last: null };
  const timers = [];
  const sandbox = {
    document, location, URL, URLSearchParams,
    console: { debug() {}, log() {}, info() {}, warn: console.warn, error: console.error },
    window: { addEventListener() {}, dispatchEvent() {}, location },
    Event: function (t) { this.type = t; },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    MutationObserver: function () { this.observe = () => {}; },
    history: { pushState() {}, replaceState() {} },
    chrome: { runtime: { sendMessage() {}, getURL: (p) => p },
              storage: { local: { get: (d, cb) => cb(d) } } },
    fetch: () => Promise.resolve({ json: () => Promise.resolve(tariffs) }),
    Promise
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(root, "core", "tax.js"), "utf8"), sandbox, { filename: "tax.js" });
  vm.runInContext(readFileSync(join(root, "core", "normalise.js"), "utf8"), sandbox, { filename: "normalise.js" });
  sandbox.BivBadge = { render: (all, vehicle) => { rendered.count++; rendered.last = { all, vehicle }; }, remove: () => {} };
  vm.runInContext(readFileSync(join(root, "content", "autoscout24.js"), "utf8"), sandbox, { filename: "autoscout24.js" });
  timers.forEach((fn) => fn());
  return new Promise((res) => setTimeout(() => res(rendered), 0));
}
function page(labelHtml) {
  const blob = { props: { pageProps: { listingDetails:
    listing("Essence", { raw: null, formatted: "- (g/km)", isFallback: false }) } } };
  return '<!doctype html><html lang="fr"><head></head><body>' +
    '<script id="__NEXT_DATA__" type="application/json">' + JSON.stringify(blob) + "</scr" + "ipt>" +
    labelHtml + "</body></html>";
}
// The literal French label harvested from autoscout24.be/fr on 2026-09-08, with
// the figure in the sibling element exactly as the site renders it.
const FR_ROW = '<div><span>\u00c9missions de CO2</span><span>128 g/km (mixte)</span></div>';
const NL_ROW = '<div><span>CO2-uitstoot</span><span>128 g/km (gem.)</span></div>';
const DE_ROW = '<div><span>CO2-Emission</span><span>128 g/km (komb.)</span></div>';

const FRR = await runContentScript(page(FR_ROW));
ok(FRR.last && FRR.last.vehicle.co2 === 128, "French spec row 'Emissions de CO2' is read (CO2 token last)");
// The French label ends in the digit 2, so a wrapper that concatenates label and
// value reads as "CO2128 g/km". That must never reach the engine as 2128 g/km.
ok(FRR.last && FRR.last.vehicle.co2 !== 2128,
   "the concatenated CO2 label and figure is not misread as 2128 g/km");
const NLR = await runContentScript(page(NL_ROW));
ok(NLR.last && NLR.last.vehicle.co2 === 128, "Dutch spec row 'CO2-uitstoot' still read (no regression)");
const DER = await runContentScript(page(DE_ROW));
ok(DER.last && DER.last.vehicle.co2 === 128, "German spec row 'CO2-Emission' still read (no regression)");

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);

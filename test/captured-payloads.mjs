/*
 * Run the SHIPPED extractors against payloads captured from the live sites.
 *
 * Every other payload-shaped fixture in this repo was authored from an assumption
 * about what the sites send. That is how a parser which had never once read
 * AutoScout24's CO2 field passed a green suite: the fixture supplied a string
 * where the site sends an object, so the test proved the parser worked on data
 * that does not exist. This file closes that loop. The inputs are real captures,
 * the expectations were hand-read off those captures by a person, and neither was
 * produced by running the code under test.
 *
 * Sources, both carrying full provenance and a do-not-edit line:
 *   test/site-payload-mobilede-2026-09.json
 *   test/site-payload-autoscout24-2026-09.json
 *
 * Run: node test/captured-payloads.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { parseHTML } from "linkedom";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const tariffs = JSON.parse(readFileSync(join(root, "core", "tariffs.json"), "utf8"));
const MOBILE = JSON.parse(readFileSync(join(root, "test", "site-payload-mobilede-2026-09.json"), "utf8"));
const AS24 = JSON.parse(readFileSync(join(root, "test", "site-payload-autoscout24-2026-09.json"), "utf8"));

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log("  ok   " + label); }
  else { failed++; console.log("  FAIL " + label); }
}
function eq(actual, expected, label) {
  ok(actual === expected, label + "  expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
}

function sandboxFor(html, url) {
  const { document } = parseHTML(html);
  const u = new URL(url);
  const location = { href: u.href, pathname: u.pathname, search: u.search, origin: u.origin, hostname: u.hostname };
  const timers = [];
  const rendered = { count: 0, last: null };
  const sandbox = {
    document, location, URL, URLSearchParams,
    console: { debug() {}, log() {}, info() {}, warn() {}, error: console.error },
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
  sandbox.__TC_EXPORT_FOR_TEST__ = true;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(root, "core", "tax.js"), "utf8"), sandbox, { filename: "tax.js" });
  vm.runInContext(readFileSync(join(root, "core", "normalise.js"), "utf8"), sandbox, { filename: "normalise.js" });
  sandbox.BivBadge = { render: (all, vehicle) => { rendered.count++; rendered.last = { all, vehicle }; }, remove: () => {} };
  return { sandbox, timers, rendered };
}

// ---------------------------------------------------------------------------
console.log("Captured payload extraction\n");
console.log("== mobile.de, " + MOBILE.captured.length + " live adverts, "
  + MOBILE.coverage.uiLanguages.join(" / ") + " ==\n");

for (let i = 0; i < MOBILE.captured.length; i++) {
  const rec = MOBILE.captured[i];
  const e = rec.expectedExtraction;
  const rows = rec.specPairs.map(([k, v]) =>
    "<dt>" + k.replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</dt>" +
    "<dd>" + String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</dd>").join("");
  const html = '<!doctype html><html lang="' + rec.uiLang + '"><body><dl>' + rows + "</dl></body></html>";
  const { sandbox } = sandboxFor(html, rec.url);
  vm.runInContext(readFileSync(join(root, "content", "mobilede.js"), "utf8"), sandbox, { filename: "mobilede.js" });
  const hook = sandbox.__tcTest;
  const tag = "[" + rec.uiLang + " #" + i + "]";
  if (!hook) { ok(false, tag + " test hook present"); continue; }
  const jsonld = hook.readJsonLd();
  ok(hook.isDetailPage(jsonld) === true, tag + " isDetailPage accepts " + rec.pathname);
  const v = sandbox.BivNormalise.fromMobileDe({ jsonld, tech: hook.readTechData() });
  eq(v.displacementCc, e.displacementCc, tag + " displacementCc");
  eq(v.powerKw, e.powerKw, tag + " powerKw");
  eq(v.fuel, e.fuel, tag + " fuel");
  eq(v.euroNorm, e.euroNorm, tag + " euroNorm");
  eq(v.firstRegistration, e.firstRegistration, tag + " firstRegistration");
  eq(v.co2, e.co2, tag + " co2");
}

// ---------------------------------------------------------------------------
console.log("\n== AutoScout24, " + AS24.captured.length + " live adverts, "
  + AS24.coverage.hosts.length + " hosts ==\n");

for (let i = 0; i < AS24.captured.length; i++) {
  const rec = AS24.captured[i];
  const e = rec.expectedExtraction;
  const f = rec.fields;
  // Rebuild listingDetails from the captured field values, unmodified.
  const vehicle = {};
  for (const k of Object.keys(f)) if (f[k].value !== undefined) vehicle[k] = f[k].value;
  const blob = { props: { pageProps: { listingDetails: { vehicle } } } };
  // Rebuild the CO2 spec rows exactly as captured, label element then value sibling.
  const specHtml = (rec.co2SpecRows || []).map(([label, val]) =>
    "<div><span>" + String(label).replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</span>" +
    "<span>" + String(val == null ? "" : val).replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</span></div>").join("");
  const html = '<!doctype html><html lang="' + rec.uiLang + '"><body>' +
    '<script id="__NEXT_DATA__" type="application/json">' + JSON.stringify(blob) + "</scr" + "ipt>" +
    specHtml + "</body></html>";
  const { sandbox, timers, rendered } = sandboxFor(html, rec.url);
  vm.runInContext(readFileSync(join(root, "content", "autoscout24.js"), "utf8"), sandbox, { filename: "autoscout24.js" });
  timers.forEach((fn) => fn());
  await new Promise((r) => setTimeout(r, 0));
  const tag = "[" + rec.domain + " " + rec.uiLang + " #" + i + "]";
  const v = rendered.last && rendered.last.vehicle;
  ok(!!v, tag + " vehicle produced");
  if (!v) continue;
  eq(v.firstRegistration, e.firstRegistration, tag + " firstRegistration");
  eq(v.powerKw, e.powerKw, tag + " powerKw");
  eq(v.displacementCc, e.displacementCc, tag + " displacementCc");
  eq(v.fuel, e.fuel, tag + " fuel");
  eq(v.co2, e.co2, tag + " co2");
  eq(v.euroNorm, e.euroNorm, tag + " euroNorm (never present in the payload, inferred later)");
}

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);

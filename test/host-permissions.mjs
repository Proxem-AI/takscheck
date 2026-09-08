/*
 * Host permission surface: keep the manifest and the code telling the same story.
 *
 * TaksCheck asks for access to specific car listing sites. Chrome review requires
 * a justification for every one, and a Belgian tax tool that reads Turkish or
 * Bulgarian AutoScout24 domains cannot honestly give one. On 2026-09-07 the set
 * was cut from 16 to 6. This file stops it drifting back and, more importantly,
 * stops the three separate match-pattern lists in manifest.json disagreeing:
 * host_permissions, each content_scripts[].matches, and
 * web_accessible_resources[].matches. If a content script is registered against a
 * pattern that host_permissions does not cover, the extension silently does not
 * run there, and nothing in the build would have said so.
 *
 * The second half is not a paper check. It evaluates the REAL content scripts in
 * a linkedom + vm sandbox, once per retained domain, and asserts a badge was
 * rendered carrying a real euro figure. That exercises the shipped pipeline end
 * to end: detail-page gate, extraction, normalise, tax engine, badge.
 *
 * Run: node test/host-permissions.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";
import { parseHTML } from "linkedom";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const tariffs = JSON.parse(readFileSync(join(root, "core", "tariffs.json"), "utf8"));

let failures = 0, total = 0;
function check(label, ok, detail) {
  total++;
  if (!ok) failures++;
  console.log((ok ? "  PASS " : "  FAIL ") + label + (ok || !detail ? "" : "\n         " + detail));
}

// The six the tool can justify: Belgium, plus the four markets a Belgian buyer
// realistically imports from. Anything else is access we do not need.
const EXPECTED = [
  "*://*.autoscout24.be/*", "*://*.autoscout24.de/*", "*://*.autoscout24.nl/*",
  "*://*.autoscout24.fr/*", "*://*.autoscout24.lu/*", "*://*.mobile.de/*"
];
// Dropped on 2026-09-07. Listed explicitly so a silent re-add fails loudly.
const MUST_NOT_MATCH = [
  "https://www.autoscout24.com/angebote/x", "https://www.autoscout24.it/angebote/x",
  "https://www.autoscout24.es/angebote/x", "https://www.autoscout24.at/angebote/x",
  "https://www.autoscout24.bg/angebote/x", "https://www.autoscout24.hr/angebote/x",
  "https://www.autoscout24.pl/angebote/x", "https://www.autoscout24.ro/angebote/x",
  "https://www.autoscout24.se/angebote/x", "https://www.autoscout24.tr/angebote/x"
];

// Chrome match pattern -> RegExp. Only the shapes this manifest uses.
function patternToRegExp(p) {
  const m = /^(\*|https?):\/\/(\*\.)?([^/]+)(\/.*)$/.exec(p);
  if (!m) throw new Error("unsupported match pattern: " + p);
  const scheme = m[1] === "*" ? "https?" : m[1];
  const host = (m[2] ? "(?:[^/]+\\.)?" : "") + m[3].replace(/\./g, "\\.");
  const path = m[4].replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + scheme + "://" + host + path + "$");
}
const matchesAny = (url, pats) => pats.some((p) => patternToRegExp(p).test(url));

console.log("Host permission surface  (manifest v" + manifest.version + ")\n");

// ---- 1. the three lists agree ---------------------------------------------
console.log("== manifest.json internal consistency ==\n");
const hp = manifest.host_permissions;
const csAll = manifest.content_scripts.flatMap((c) => c.matches);
const warAll = manifest.web_accessible_resources.flatMap((r) => r.matches);

check("host_permissions is exactly the six justified patterns",
  JSON.stringify([...hp].sort()) === JSON.stringify([...EXPECTED].sort()),
  "got " + JSON.stringify(hp));

const csOrphans = csAll.filter((p) => !hp.includes(p));
check("every content_scripts match is covered by host_permissions",
  csOrphans.length === 0, "uncovered: " + JSON.stringify(csOrphans));

const warOrphans = warAll.filter((p) => !hp.includes(p));
check("every web_accessible_resources match is covered by host_permissions",
  warOrphans.length === 0, "uncovered: " + JSON.stringify(warOrphans));

const unused = hp.filter((p) => !csAll.includes(p));
check("every host_permission is actually used by a content script",
  unused.length === 0, "requested but unused: " + JSON.stringify(unused));

// ---- 2. the patterns resolve the way we think they do ----------------------
console.log("\n== match pattern behaviour ==\n");
for (const url of [
  "https://www.autoscout24.be/aanbod/x", "https://www.autoscout24.de/angebote/x",
  "https://www.autoscout24.nl/aanbod/x", "https://www.autoscout24.fr/offre/x",
  "https://www.autoscout24.lu/offre/x", "https://suchen.mobile.de/fahrzeuge/details.html?id=123",
  // A Dutch-language user is served the advert from www.mobile.de/nl/..., not from
  // suchen.mobile.de, so the localised host has to be covered too. Confirmed live
  // on 2026-09-08: the same advert id resolves under both hosts.
  "https://www.mobile.de/nl/voertuigen/details.html?id=447034521"
]) {
  check("matches: " + url, matchesAny(url, hp));
}
for (const url of MUST_NOT_MATCH) {
  check("no longer matches: " + url.replace("https://www.", "").replace("/angebote/x", ""),
    !matchesAny(url, hp));
}

// ---- 3. the shipped pipeline still runs on each retained domain ------------
console.log("\n== real content scripts, real engine, one run per retained domain ==\n");

// A petrol Euro 6 130 g car registered 2023, i.e. the WLTP branch.
const LISTING = {
  vehicle: {
    make: { formatted: "BMW" }, model: { formatted: "318i" },
    firstRegistrationDate: "2023-05-15",
    fuelCategory: { formatted: "Benzine" },
    rawPowerInKw: 115, rawDisplacementInCCM: 1998,
    co2emissionInGramPerKmWithFallback: "130 g/km",
    emissionClass: { formatted: "Euro 6" },
    bodyType: { formatted: "Sedan" }
  },
  prices: { public: { priceRaw: 24950 } }
};
const AS24_HTML = '<!doctype html><html lang="nl"><head></head><body>' +
  '<script id="__NEXT_DATA__" type="application/json">' +
  JSON.stringify({ props: { pageProps: { listingDetails: LISTING } } }) +
  "</scr" + "ipt></body></html>";

function runContentScript(scriptRel, html, url) {
  const { document } = parseHTML(html);
  const u = new URL(url);
  const location = { href: u.href, pathname: u.pathname, search: u.search, origin: u.origin, hostname: u.hostname };
  const rendered = { count: 0, last: null };
  const timers = [];
  const sandbox = {
    document, location, URL, URLSearchParams,
    // The content scripts log the computed result on every run. Useful in a real
    // browser, noise here, so the sandbox gets a quiet console and keeps warn.
    console: { debug() {}, log() {}, info() {}, warn: console.warn, error: console.error },
    window: { addEventListener() {}, dispatchEvent() {}, location },
    Event: function (t) { this.type = t; },
    // Run the debounced callback immediately; the real page has a real clock.
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    MutationObserver: function () { this.observe = () => {}; },
    history: { pushState() {}, replaceState() {} },
    chrome: {
      runtime: { sendMessage() {}, getURL: (p) => p },
      storage: { local: { get: (d, cb) => cb(d) } }
    },
    fetch: () => Promise.resolve({ json: () => Promise.resolve(tariffs) }),
    Promise
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(root, "core", "tax.js"), "utf8"), sandbox, { filename: "tax.js" });
  vm.runInContext(readFileSync(join(root, "core", "normalise.js"), "utf8"), sandbox, { filename: "normalise.js" });
  sandbox.BivBadge = {
    render: (all, vehicle, region) => { rendered.count++; rendered.last = { all, vehicle, region }; },
    remove: () => {}
  };
  vm.runInContext(readFileSync(join(root, "content", scriptRel), "utf8"), sandbox, { filename: scriptRel });
  timers.forEach((fn) => fn());          // fire the debounced run()
  return new Promise((res) => setTimeout(() => res(rendered), 0));  // let the fetch/storage promises settle
}

for (const host of ["www.autoscout24.be", "www.autoscout24.de", "www.autoscout24.nl",
                    "www.autoscout24.fr", "www.autoscout24.lu"]) {
  const r = await runContentScript("autoscout24.js", AS24_HTML, "https://" + host + "/aanbod/bmw-318i-abc123");
  const biv = r.last && r.last.all.biv.amount;
  check(host + ": badge rendered with a real BIV figure",
    r.count === 1 && typeof biv === "number" && biv > 0,
    "renders=" + r.count + " biv=" + biv);
}

const MOBILE_HTML = '<!doctype html><html lang="de"><head>' +
  '<script type="application/ld+json">' + JSON.stringify({
    "@context": "https://schema.org", "@type": "Car", name: "BMW 318i",
    vehicleConfiguration: "Limousine",
    fuelType: "Benzin", vehicleEngine: { enginePower: { value: 115, unitCode: "KWT" }, engineDisplacement: { value: 1998, unitCode: "CMQ" } },
    dateVehicleFirstRegistered: "2023-05-15",
    emissionsCO2: 130
  }) + "</scr" + "ipt></head><body></body></html>";

{
  const r = await runContentScript("mobilede.js", MOBILE_HTML,
    "https://suchen.mobile.de/fahrzeuge/details.html?id=411223344");
  const biv = r.last && r.last.all.biv.amount;
  check("suchen.mobile.de: badge rendered with a real BIV figure",
    r.count === 1 && typeof biv === "number" && biv > 0,
    "renders=" + r.count + " biv=" + biv);
}

// ---- 4. the storage surface stays local ------------------------------------
// chrome.storage.sync replicates through the user's Google account, so data
// would leave the device and the privacy policy's "transmits nothing" would need
// hedging. Two preference keys are not worth that. This guards the claim.
console.log("\n== storage surface ==\n");
const shipped = ["sw.js", "popup.js", "options.js", "ui/badge.js",
                 "content/autoscout24.js", "content/mobilede.js"];
for (const rel of shipped) {
  const src = readFileSync(join(root, rel), "utf8");
  const uses = /chrome\.storage\.sync/.test(src);
  check(rel + ": no chrome.storage.sync", !uses,
    "storage.sync replicates via the user's Google account; use chrome.storage.local");
}
{
  const worker = readFileSync(join(root, "sw.js"), "utf8");
  check("sw.js still makes no network call",
    !/\bfetch\s*\(|XMLHttpRequest|sendBeacon/.test(worker));
  check("sw.js carries the privacy obligation note for a future tariff refresh",
    /IF YOU ADD THE SCHEDULED TARIFF REFRESH/.test(worker));
}

console.log("\nHost permission assertions: " + (total - failures) + "/" + total + " passed.");
if (failures) { console.log("RESULT: FAIL (" + failures + ")."); process.exit(1); }
console.log("RESULT: PASS.");

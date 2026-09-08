/*
 * Fixture test for the mobile.de content-script extraction and detail-page gate.
 * mobile.de is DataDome-walled, so we cannot load the real page. This builds
 * realistic mock detail pages with linkedom (the DOM lib the project already
 * uses) and asserts:
 *   - the current /fahrzeuge/details.html?id=<digits> URL passes isDetailPage,
 *   - the per-locale detail paths pass it too, /nl/voertuigen/details.html above
 *     all, and the search, home and listing pages of those locales still do not,
 *   - the extractor produces a non-null vehicle from a Car JSON-LD,
 *   - the extractor produces a non-null vehicle from several Technische Daten
 *     DOM shapes (dt/dd, table rows, sibling divs, inline "label: value",
 *     two-child row wrapper, label-plus-child-value),
 *   - the OLD url format + old dt/dd DOM still pass (no regression).
 *
 * The content script is an IIFE that reads globals (document, location, chrome,
 * BelgianCarTax, BivNormalise, BivBadge). We only need the pure extraction and
 * gate logic, so we load core/tax.js and core/normalise.js for real, stub Badge
 * and chrome, and re-expose isDetailPage / readTechData / run via a tiny shim by
 * evaluating the content script in a sandbox that captures them.
 *
 * Run: node test/mobilede-extract.mjs
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

const tariffs = JSON.parse(readFileSync(join(root, "core", "tariffs.json"), "utf8"));

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log("  ok   " + label); }
  else { failed++; console.log("  FAIL " + label); }
}

// Build a fresh sandbox per fixture: a linkedom document + a matching location,
// the real tax + normalise modules, stub Badge + chrome, then evaluate the
// content script and capture the functions it defines on a test hook.
function makeContext(html, url) {
  const { document } = parseHTML(html);
  const u = new URL(url);
  const location = {
    href: u.href, pathname: u.pathname, search: u.search, origin: u.origin, hostname: u.hostname
  };
  const windowStub = { addEventListener() {}, dispatchEvent() {}, location };

  // Real engine + normaliser (CommonJS IIFE style: they set globalThis.*).
  const sandbox = {
    document, window: windowStub, location, URL, URLSearchParams, console,
    Event: function (t) { this.type = t; },
    setTimeout: () => 0, clearTimeout: () => {},
    MutationObserver: function () { this.observe = () => {}; },
    history: { pushState() {}, replaceState() {} },
    chrome: {
      runtime: { sendMessage() {}, getURL: (p) => p },
      storage: { local: { get: (d, cb) => cb(d) } }
    },
    fetch: () => Promise.resolve({ json: () => Promise.resolve(tariffs) })
  };
  sandbox.globalThis = sandbox;
  sandbox.__TC_EXPORT_FOR_TEST__ = true;
  vm.createContext(sandbox);

  // Load tax + normalise into the same global (they attach to globalThis).
  vm.runInContext(readFileSync(join(root, "core", "tax.js"), "utf8"), sandbox, { filename: "tax.js" });
  vm.runInContext(readFileSync(join(root, "core", "normalise.js"), "utf8"), sandbox, { filename: "normalise.js" });

  // Stub Badge; capture the last render so tests can assert a draw happened.
  const rendered = { count: 0, last: null };
  sandbox.globalThis.BivBadge = {
    render: (all, vehicle) => { rendered.count++; rendered.last = { all, vehicle }; },
    remove: () => {}
  };

  // The content script is an IIFE; to reach its internal isDetailPage/readTechData
  // we expose them via a test hook the script checks for. Simplest robust path:
  // append a small exporter to the source that publishes the closures. Instead of
  // editing the script, we re-declare the two pure functions is not possible from
  // outside the IIFE, so we evaluate the script and rely on its public behaviour
  // (Badge.render) plus a direct re-run trigger.
  const src = readFileSync(join(root, "content", "mobilede.js"), "utf8");
  vm.runInContext(src, sandbox, { filename: "mobilede.js" });

  return { sandbox, rendered, document, location };
}

// Because the IIFE runs on load (readyState !== 'loading' -> scheduled()), and our
// setTimeout is a no-op, the debounced run() does not fire automatically. We drive
// extraction directly through the public normaliser + a gate re-implementation is
// avoided: instead we assert via BivNormalise.fromMobileDe + a standalone gate that
// mirrors the shipped isDetailPage, loaded from the same source by regex-free eval.
// To keep the test honest we evaluate the ACTUAL isDetailPage/readTechData by
// re-exposing them: we append an exporter line in a second eval that reopens the
// module scope is not possible, so we instead re-run the shipped functions by
// reading them off a global the script sets when running under test.

// The script does not export internals, so we test the two pure pieces that matter
// through a thin re-eval of just those functions extracted from source is brittle.
// Simplest reliable approach: assert the observable contract. We trigger run() by
// dispatching the readyState path already executed on load; if data is present the
// stub Badge.render is called. We force a synchronous run by calling the exposed
// hook window.__tc_run if present.

function extract(html, url) {
  const ctx = makeContext(html, url);
  // The content script sets globalThis.__tcTest with {isDetailPage, readTechData}
  // when running in a test context (added exporter). Fall back to normaliser-only.
  const hook = ctx.sandbox.globalThis.__tcTest;
  const N = ctx.sandbox.globalThis.BivNormalise;
  let gate = null, vehicle = null;
  if (hook) {
    const jsonld = hook.readJsonLd();
    gate = hook.isDetailPage(jsonld);
    const tech = hook.readTechData();
    vehicle = N.fromMobileDe({ jsonld, tech });
  }
  return { gate, vehicle, hook: !!hook, rendered: ctx.rendered };
}

// ---- Fixtures --------------------------------------------------------------
const CAR_JSONLD = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "Car",
  name: "BMW 320d",
  brand: { "@type": "Brand", name: "BMW" },
  model: "320d",
  dateVehicleFirstRegistered: "2020-05",
  fuelType: "Diesel",
  vehicleEngine: {
    "@type": "EngineSpecification",
    enginePower: { value: 140, unitText: "kW" },
    engineDisplacement: { value: 1995, unitText: "cm3" }
  },
  emissionsCO2: 128,
  offers: { "@type": "Offer", price: 24900, priceCurrency: "EUR" }
});

const NEW_URL = "https://suchen.mobile.de/fahrzeuge/details.html?id=38737228465184&dam=false&ref=srp&s=Car&vc=Car";
const OLD_URL = "https://suchen.mobile.de/auto-inserat/bmw-320d/412345678.html";

// (a) new URL + Car JSON-LD only (no spec table)
const HTML_JSONLD = `<!doctype html><html><head>
  <script type="application/ld+json">${CAR_JSONLD}</script></head>
  <body><h1>BMW 320d</h1></body></html>`;

// (b) new URL + dt/dd spec table (German labels), no JSON-LD
const HTML_DTDD = `<!doctype html><html><head></head><body>
  <dl>
    <dt>Erstzulassung</dt><dd>05/2020</dd>
    <dt>Kraftstoff</dt><dd>Diesel</dd>
    <dt>Leistung</dt><dd>140 kW (190 PS)</dd>
    <dt>Hubraum</dt><dd>1.995 cm3</dd>
    <dt>CO2-Emissionen (kombiniert)</dt><dd>128 g/km</dd>
    <dt>Schadstoffklasse</dt><dd>Euro 6</dd>
    <dt>Preis</dt><dd>24.900 EUR</dd>
  </dl></body></html>`;

// (c) new URL + table rows (English labels)
const HTML_TABLE = `<!doctype html><html><head></head><body>
  <table><tbody>
    <tr><th>First registration</th><td>05/2020</td></tr>
    <tr><th>Fuel</th><td>Diesel</td></tr>
    <tr><th>Power</th><td>140 kW (190 PS)</td></tr>
    <tr><th>Emission class</th><td>Euro 6</td></tr>
  </tbody></table></body></html>`;

// (d) new URL + sibling-div layout with hashed classes (label leaf, value sibling)
const HTML_DIVPAIR = `<!doctype html><html><head></head><body>
  <div class="a1"><span class="k">Erstzulassung</span><span class="v">05/2020</span></div>
  <div class="a2"><span class="k">Leistung</span><span class="v">140 kW</span></div>
  <div class="a3"><span class="k">Kraftstoff</span><span class="v">Diesel</span></div>
  </body></html>`;

// (e) new URL + inline "label: value" and label-plus-child-value shapes
const HTML_INLINE = `<!doctype html><html><head></head><body>
  <ul>
    <li>Erstzulassung: 05/2020</li>
    <li>Leistung: 140 kW (190 PS)</li>
    <li>Kraftstoff: Diesel</li>
  </ul>
  <div class="row"><div>CO2-Emissionen</div><div>128 g/km</div></div>
  </body></html>`;

// (f) OLD url + old dt/dd DOM (regression guard)
const HTML_OLD = `<!doctype html><html><head>
  <script type="application/ld+json">${CAR_JSONLD}</script></head><body>
  <dl><dt>Erstzulassung</dt><dd>05/2020</dd><dt>Leistung</dt><dd>140 kW</dd></dl>
  </body></html>`;

console.log("mobile.de extraction fixtures");

function assertVehicle(label, res, needs) {
  ok(res.hook, label + ": test hook present");
  ok(res.gate === true, label + ": isDetailPage passes");
  const v = res.vehicle;
  ok(!!v, label + ": vehicle non-null");
  if (v) {
    for (const f of needs) ok(v[f] != null, label + ": " + f + " present (" + JSON.stringify(v[f]) + ")");
  }
}

assertVehicle("(a) JSON-LD", extract(HTML_JSONLD, NEW_URL), ["firstRegistration", "co2", "powerKw", "fuel", "price"]);
assertVehicle("(b) dt/dd DE", extract(HTML_DTDD, NEW_URL), ["firstRegistration", "co2", "powerKw", "fuel", "price"]);
assertVehicle("(c) table EN", extract(HTML_TABLE, NEW_URL), ["firstRegistration", "powerKw", "fuel"]);
assertVehicle("(d) div pairs", extract(HTML_DIVPAIR, NEW_URL), ["firstRegistration", "powerKw", "fuel"]);
assertVehicle("(e) inline",   extract(HTML_INLINE, NEW_URL), ["firstRegistration", "powerKw", "fuel", "co2"]);
assertVehicle("(f) OLD url",  extract(HTML_OLD, OLD_URL), ["firstRegistration", "powerKw"]);

// ---- locale path shapes ---------------------------------------------------
// mobile.de translates the detail-page path noun, not just the page copy. The
// German suchen.mobile.de/fahrzeuge/details.html and the Dutch
// www.mobile.de/nl/voertuigen/details.html were both confirmed live on
// 2026-09-08, serving the same advert id. Until then the gate named the German
// noun, so a Belgian user browsing in Dutch, the user this extension exists for,
// got no badge on any advert. These fixtures carry a spec table and no JSON-LD,
// so the URL is the only thing the gate can decide on. Nouns for the locales not
// confirmed live are plausible spellings on purpose: the gate must not care what
// the word is, which is the whole point of the fix.
const LOCALE_DETAIL_URLS = [
  ["DE  /fahrzeuge/details.html",     "https://suchen.mobile.de/fahrzeuge/details.html?id=447034521"],
  ["NL  /nl/voertuigen/details.html", "https://www.mobile.de/nl/voertuigen/details.html?id=447034521"],
  ["NL  with the srp query tail",     "https://www.mobile.de/nl/voertuigen/details.html?id=460779544&vc=Car&dam=false&ref=srp&sb=rel"],
  ["FR  /fr/vehicules/details.html",  "https://www.mobile.de/fr/vehicules/details.html?id=447034521"],
  ["EN  /en/vehicle/details.html",    "https://www.mobile.de/en/vehicle/details.html?id=447034521"],
  ["IT  /it/veicoli/details.html",    "https://www.mobile.de/it/veicoli/details.html?id=447034521"]
];
for (const [label, url] of LOCALE_DETAIL_URLS) {
  ok(extract(HTML_DTDD, url).gate === true, "(locale) gate accepts " + label);
}

// The locale prefix must not become a way in for pages that are not adverts.
// The mandatory numeric ad id is what holds that line, so it is tested here.
const BARE = `<!doctype html><html><body><h1>overzicht</h1></body></html>`;
const LOCALE_NON_DETAIL_URLS = [
  ["DE search page",         "https://suchen.mobile.de/fahrzeuge/search.html?isSearchRequest=true"],
  ["NL search page",         "https://www.mobile.de/nl/voertuigen/zoek.html?vc=Car&s=Car"],
  ["NL home",                "https://www.mobile.de/nl"],
  ["NL make listing page",   "https://www.mobile.de/nl/car/bmw"],
  ["NL details without id",  "https://www.mobile.de/nl/voertuigen/details.html?vc=Car"],
  ["NL details, id too short", "https://www.mobile.de/nl/voertuigen/details.html?id=123"]
];
for (const [label, url] of LOCALE_NON_DETAIL_URLS) {
  ok(extract(BARE, url).gate === false, "(locale neg) gate refuses " + label);
}

// End to end on the Dutch path: gate, extraction and normalisation together.
assertVehicle("(g) NL locale path", extract(HTML_DTDD, LOCALE_DETAIL_URLS[1][1]),
  ["firstRegistration", "co2", "powerKw", "fuel", "price"]);

// ---- locale spec labels ---------------------------------------------------
// mobile.de prints the spec labels in the user's UI language. Until 2026-09-08 the
// stems covered German and English only, so on a live Dutch advert ZERO labels
// resolved and the badge read "Onvoldoende gegevens". Every label below is a
// literal string harvested from the live site that day, same advert (447034521),
// one locale at a time. They are not translations, because a plausible translation
// that is not the literal string fails silently, which is how this defect happened.
const NL_URL = "https://www.mobile.de/nl/voertuigen/details.html?id=447034521";
const FR_URL = "https://www.mobile.de/fr/vehicules/details.html?id=447034521";

function fieldsEq(label, res, expect) {
  ok(!!res.vehicle, label + ": vehicle non-null");
  const v = res.vehicle || {};
  for (const k of Object.keys(expect)) {
    ok(v[k] === expect[k],
       label + ": " + k + " = " + JSON.stringify(expect[k]) + " (got " + JSON.stringify(v[k]) + ")");
  }
}

// Dutch, in the real DOM order, including the rows that are traps: the CO2 class
// row and the CO2 cost row both carry a CO2 token, and "Brandstofverbruik" and
// "Brandstofprijs" both begin with "Brandstof".
const HTML_NL = `<!doctype html><html lang="nl"><body><dl>
  <dt>Kilometrage</dt><dd>59.071 km</dd>
  <dt>Inhoud</dt><dd>2.993 ccm</dd>
  <dt>Vermogen</dt><dd>210 kW (286 PK)</dd>
  <dt>Type aandrijving</dt><dd>Interne verbrandingsmotor</dd>
  <dt>Brandstof</dt><dd>Diesel</dd>
  <dt>Energieverbruik (kam.)2</dt><dd>5,4 l/100km</dd>
  <dt>CO₂-emissies (kam.)2</dt><dd>142 g/km</dd>
  <dt>CO₂-klasse</dt><dd>Op basis van CO₂-emissies (gecombineerd)</dd>
  <dt>Brandstofverbruik2</dt><dd>5,4 l/100km (gecombineerd)</dd>
  <dt>Brandstofprijs</dt><dd>&euro; 1,61/l (jaargemiddelde 2025)</dd>
  <dt>Motorrijtuigenbelasting</dt><dd>&euro; 386/jaar</dd>
  <dt>Emissieklasse</dt><dd>Euro6d</dd>
  <dt>Emissiesticker</dt><dd>4 (Groen)</dd>
  <dt>Eerste registratie</dt><dd>01/2023</dd>
</dl></body></html>`;

// French. Note the CO2 token comes LAST in the label, and the thousands separator
// is a non-breaking space, both exactly as the live site printed them.
const HTML_FR = `<!doctype html><html lang="fr"><body><dl>
  <dt>Kilom&eacute;trage</dt><dd>59 071 km</dd>
  <dt>Cylindr&eacute;e</dt><dd>2 993 ccm</dd>
  <dt>Puissance</dt><dd>210 kW (286 Ch DIN)</dd>
  <dt>Carburant</dt><dd>Diesel</dd>
  <dt>&Eacute;missions de CO₂ (peigne)2</dt><dd>142 g/km</dd>
  <dt>Classe CO₂</dt><dd>Sur la base des &eacute;missions de CO₂ (combin&eacute;es)</dd>
  <dt>Prix du carburant</dt><dd>1,61 &euro;/l</dd>
  <dt>Norme antipollution</dt><dd>Euro6d</dd>
  <dt>Date immatriculation</dt><dd>01/2023</dd>
</dl></body></html>`;

fieldsEq("(NL) live Dutch labels", extract(HTML_NL, NL_URL), {
  firstRegistration: "01/2023", fuel: "diesel", powerKw: 210,
  displacementCc: 2993, co2: 142, euroNorm: 6
});
fieldsEq("(FR) live French labels", extract(HTML_FR, FR_URL), {
  firstRegistration: "01/2023", fuel: "diesel", powerKw: 210,
  displacementCc: 2993, co2: 142, euroNorm: 6
});

// Worst-case ordering: readTechData keeps the FIRST hit per key, so put the CO2
// class row BEFORE the emission row. The figure must still be 142, not the prose.
const HTML_CO2_CLASS_FIRST = `<!doctype html><html><body><dl>
  <dt>CO₂-klasse</dt><dd>Op basis van CO₂-emissies (gecombineerd)</dd>
  <dt>CO₂-emissies (kam.)2</dt><dd>142 g/km</dd>
</dl></body></html>`;
ok(extract(HTML_CO2_CLASS_FIRST, NL_URL).vehicle.co2 === 142,
   "(NL) CO2 class row before the figure does not poison the CO2 value");

// The subscript two is what the site renders; a plain 2 is what other markup
// carries. Neither form is bet on, so both must read 142.
const HTML_PLAIN_2 = `<!doctype html><html><body><dl>
  <dt>CO2-emissies (kam.)2</dt><dd>142 g/km</dd></dl></body></html>`;
ok(extract(HTML_PLAIN_2, NL_URL).vehicle.co2 === 142,
   "(NL) plain 2 in the CO2 label reads the same as the subscript");

// An EV page carries kWh rows. The unit fallback must never read battery capacity
// or electricity consumption as engine power.
const HTML_EV_KWH = `<!doctype html><html><body><dl>
  <dt>Accucapaciteit (in kWh)</dt><dd>81 kWh</dd>
  <dt>Stroomverbruik2</dt><dd>16,6 kWh/100km</dd>
  <dt>Elektrische actieradius2</dt><dd>559 km</dd>
  <dt>Eerste registratie</dt><dd>01/2023</dd>
</dl></body></html>`;
const EV = extract(HTML_EV_KWH, NL_URL);
ok(EV.vehicle.powerKw !== 81, "(EV) 81 kWh battery is not read as 81 kW of power");
ok(EV.vehicle.powerKw == null, "(EV) no power label and no kW value leaves powerKw null");

// A locale we have never harvested. The labels are unreadable, but mobile.de does
// not translate its units, so the value pass still recovers the unit-bearing
// fields. This is the difference between a partial badge and a blank one.
const HTML_UNKNOWN_LOCALE = `<!doctype html><html lang="it"><body><dl>
  <dt>Cilindrata</dt><dd>2.993 ccm</dd>
  <dt>Potenza</dt><dd>210 kW (286 CV)</dd>
  <dt>Emissioni di CO₂ (comb.)2</dt><dd>142 g/km</dd>
  <dt>Classe di emissioni</dt><dd>Euro6d</dd>
  <dt>Immatricolazione</dt><dd>01/2023</dd>
  <dt>Carburante</dt><dd>Diesel</dd>
</dl></body></html>`;
const IT = extract(HTML_UNKNOWN_LOCALE, NL_URL);
ok(IT.vehicle.displacementCc === 2993, "(unseen locale) cc recovered from the ccm unit");
ok(IT.vehicle.powerKw === 210, "(unseen locale) power recovered from the kW unit");
ok(IT.vehicle.co2 === 142, "(unseen locale) CO2 recovered from the g/km unit");
ok(IT.vehicle.euroNorm === 6, "(unseen locale) euro norm recovered from the Euro6d value");
// The documented limit: a date and a free-text word carry no unit, so these two
// still need a label stem per locale. Asserted so the limit is visible, not implied.
ok(IT.vehicle.firstRegistration == null,
   "(unseen locale) first registration is NOT recoverable without a label stem");

// Negative: a non-detail page must NOT pass the gate.
const NEG = extract(`<!doctype html><html><body><h1>Search</h1></body></html>`,
  "https://suchen.mobile.de/fahrzeuge/search.html?isSearchRequest=true");
ok(NEG.gate === false, "(neg) search page: isDetailPage false");

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);

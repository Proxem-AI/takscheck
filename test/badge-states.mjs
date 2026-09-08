/*
 * Badge rendering assertions, NL and FR.
 *
 * Two jobs. First, lock the wording the pre-publication legal review fixed on
 * 2026-09-06, because it has moved before: the confidence caption went
 * "Betrouwbaarheid" to "Nauwkeurigheid" to "Précision" over three commits, and
 * the review's whole point is that a caption claiming output accuracy is a claim
 * this meter cannot support. A string test is the cheapest way to stop that
 * drifting back. Second, prove the four panel states actually render: current,
 * stale, expired, and unvalidated region.
 *
 * Renders the real ui/badge.js into a linkedom document. No Chrome APIs are
 * present, and every call site in the badge already guards for that.
 *
 * Run: node test/badge-states.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { parseHTML } from "linkedom";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const tariffs = JSON.parse(readFileSync(join(root, "core", "tariffs.json"), "utf8"));
const { createTaxEngine } = require(join(root, "core", "tax.js"));
const engine = createTaxEngine(tariffs);

const badgeSrc = readFileSync(join(root, "ui", "badge.js"), "utf8");

let failures = 0;
let total = 0;

function check(label, ok, detail) {
  total++;
  if (!ok) failures++;
  console.log((ok ? "  PASS " : "  FAIL ") + label + (ok || !detail ? "" : "\n         got: " + detail));
}

// Render the badge for one language and one engine result, returning the text
// content and the raw markup of the shadow tree.
function render(lang, all, vehicle, region) {
  const { document, window } = parseHTML(
    '<!doctype html><html lang="' + lang + '"><head></head><body></body></html>'
  );
  const sandbox = {
    document,
    window,
    navigator: { language: lang },
    location: { pathname: "/" },
    globalThis: null
  };
  sandbox.globalThis = sandbox;
  // The badge is an IIFE taking the global object. Feed it our sandbox.
  const fn = new Function("globalThis", "document", "window", "navigator", "location", badgeSrc);
  fn(sandbox, document, window, sandbox.navigator, sandbox.location);
  sandbox.BivBadge.render(all, vehicle, region);
  const host = document.getElementById("takscheck-host");
  const html = host.shadowRoot.innerHTML;
  const text = html.replace(/<style>[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return { html, text };
}

// Shaped like what BivNormalise actually emits from a real advert. It emits
// displacementCc and it does NOT emit fiscalHp, so a fixture supplying fiscalHp
// exercises a branch of deriveFiscalHp that no real user can reach. 1600 cc sits
// in the 1551 to 1750 band of the official belastbare-kracht table in
// core/tariffs.json, which is fiscal pk 9, the value this fixture used to hand in
// directly. See test/fiscal-hp.mjs.
const petrol = { title: "Test", fuel: "petrol", co2: 130, euroNorm: 6, displacementCc: 1600, firstRegistration: "2023-05-15" };
const noCo2 = { title: "Test", fuel: "petrol", euroNorm: 6, displacementCc: 1600, firstRegistration: "2023-05-15" };

// The dates are taken from the tariff file, not from the engine, so these stay
// meaningful when a new window is added.
const qWindow = tariffs.flanders.biv.qWindows[0];
const CURRENT = qWindow.until;                              // last live day
const STALE = "2027-03-01";                                 // past q, inside grace
const EXPIRED = "2028-06-01";                               // past the grace period

console.log("Badge state and wording assertions  (tariffs v" + tariffs.version + ")\n");

// ---- 1. the caption, both languages ---------------------------------------
console.log("== Caption: what the meter measures is the advert, not the answer ==\n");
{
  const nl = render("nl", engine.computeAll(petrol, "flanders", CURRENT), petrol, "flanders");
  check('NL caption reads "Gegevens uit de advertentie"', nl.text.includes("Gegevens uit de advertentie"));
  check('NL tier word reads "volledig"', /Gegevens uit de advertentie\s*volledig/.test(nl.text));
  check("NL aria-label matches the visible caption",
    nl.html.includes('aria-label="Gegevens uit de advertentie: volledig"'));
  check("NL carries no output-accuracy claim",
    !/Nauwkeurigheid|Betrouwbaarheid/.test(nl.html), nl.text.slice(0, 160));

  const fr = render("fr", engine.computeAll(petrol, "flanders", CURRENT), petrol, "flanders");
  check("FR caption reads \"Données de l'annonce\"", fr.text.includes("Données de l'annonce"));
  check('FR tier word reads "complètes"', /Données de l'annonce\s*complètes/.test(fr.text));
  check("FR aria-label matches the visible caption",
    fr.html.includes("aria-label=\"Données de l'annonce: complètes\""));
  check("FR carries no output-accuracy claim",
    !/Précision|Fiabilité/.test(fr.html), fr.text.slice(0, 160));
}

// ---- 2. the vintage line, generated from the data --------------------------
console.log("\n== Vintage: generated from the selected window, never hardcoded ==\n");
{
  const nl = render("nl", engine.computeAll(petrol, "flanders", CURRENT), petrol, "flanders");
  check("NL shows the estimate notice and the rate vintage",
    nl.text.includes("Schatting op basis van deze advertentie. Geen officiële aanslag.") &&
    nl.text.includes("Tarieven van 1 juli 2026."), nl.text.slice(-220));

  const fr = render("fr", engine.computeAll(petrol, "flanders", CURRENT), petrol, "flanders");
  check("FR shows the estimate notice and the rate vintage",
    fr.text.includes("Estimation basée sur cette annonce. Pas un avis d'imposition officiel.") &&
    fr.text.includes("Tarifs du 1er juillet 2026."), fr.text.slice(-220));
}

// ---- 3. stale: disclose and degrade, do not refuse -------------------------
console.log("\n== Stale: the figure stays, the claim comes down ==\n");
{
  const all = engine.computeAll(petrol, "flanders", STALE);
  const nl = render("nl", all, petrol, "flanders");
  check("euro amount is still rendered when stale", all.biv.amount != null && /€/.test(nl.html));
  check("NL stale sentence is shown",
    nl.text.includes("Let op: deze tarieven zijn van 1 juli 2026 en zijn sindsdien geïndexeerd.") &&
    nl.text.includes("Het werkelijke bedrag is daardoor waarschijnlijk hoger.") &&
    nl.text.includes("Controleer de officiële simulator voor het actuele bedrag."), nl.text.slice(-300));
  // The direction is stated as a likelihood, not as fact. Indexation has only
  // ever moved upward, but that is inductive and a decree can cut a rate, so an
  // unqualified "ligt hoger" would be an affirmative claim about a number this
  // panel cannot compute. Same defect the caption was sent back for.
  check("NL states the direction as likelihood, not as fact",
    !/bedrag ligt hoger/.test(nl.text), nl.text.slice(-300));
  check("stale disclaimer carries the warning treatment", nl.html.includes("tc-disc-warn"));
  check("official simulator link is promoted", nl.html.includes("tc-sim-lead"));
  check("input tier is forced down a step (high becomes medium)",
    all.biv.confidence === "medium", String(all.biv.confidence));
  check("NL tier word follows the tier down",
    nl.text.includes("deels geschat"), nl.text.slice(0, 200));
  check("NL aria-label follows the tier down with it",
    nl.html.includes('aria-label="Gegevens uit de advertentie: deels geschat"'));
  // A figure whose own index window is still live must not be dragged down by the
  // BIV going stale. Its window runs to 2027-06-30; only q has lapsed, and q
  // touches the BIV alone. That separation is the entire reason the caption
  // changed, so it is worth asserting rather than assuming.
  //
  // This used to assert an ABSOLUTE tier: road tax confidence "high" with the
  // caption "volledig". It only ever passed because the fixture handed the engine
  // a fiscalHp that no advert carries. A real advert derives its fiscal pk from
  // cylinder capacity, which caps the road tax one step below "high", so
  // "volledig" is a state no user can reach on this figure. See test/fiscal-hp.mjs.
  //
  // The intent is unchanged and is now expressed RELATIVELY: q lapsed, so the BIV
  // tier moves and the road tax does not. Written this way it tests the
  // separation without hard-coding a ceiling, which also means it stays correct
  // after Iris settles what the tiers themselves should be. That tiering decision
  // is deliberately not made here.
  const live = engine.computeAll(petrol, "flanders", CURRENT);
  check("q lapsing moves the BIV tier down",
    live.biv.confidence !== all.biv.confidence,
    "current " + live.biv.confidence + ", stale " + all.biv.confidence);
  check("q lapsing does not drag the road tax tier down with it",
    all.rijtaks.confidence === live.rijtaks.confidence,
    "current " + live.rijtaks.confidence + ", stale " + all.rijtaks.confidence);
  check("q lapsing does not move the road tax amount either",
    all.rijtaks.amount === live.rijtaks.amount,
    "current " + live.rijtaks.amount + ", stale " + all.rijtaks.amount);
  check("the stale sentence is in the accessible text, not conveyed by colour alone",
    /Let op:/.test(nl.text));

  const fr = render("fr", all, petrol, "flanders");
  check("FR aria-label follows the tier down with it",
    fr.html.includes("aria-label=\"Données de l'annonce: partiellement estimées\""));
  check("FR stale sentence is shown",
    fr.text.includes("Attention: ces tarifs datent du 1er juillet 2026 et ont été indexés depuis.") &&
    fr.text.includes("Le montant réel est donc probablement plus élevé.") &&
    fr.text.includes("Vérifiez le simulateur officiel pour le montant actuel."), fr.text.slice(-300));
  check("FR states the direction as likelihood, not as fact",
    !/montant réel est plus élevé/.test(fr.text), fr.text.slice(-300));
}

// ---- 4. expired: amounts withdrawn, panel and link stay --------------------
console.log("\n== Expired: amounts withdrawn, the route to the right number stays ==\n");
{
  const all = engine.computeAll(petrol, "flanders", EXPIRED);
  const nl = render("nl", all, petrol, "flanders");
  check("no euro amount is rendered", all.biv.amount === null && !/€/.test(nl.html), nl.text.slice(0, 200));
  check("NL expired sentence is shown",
    nl.text.includes("TaksCheck toont geen bedragen meer") && nl.text.includes("zijn te oud"), nl.text.slice(-240));
  check("panel still offers the official simulator", nl.html.includes("tc-sim"));
  check("cells say the figure is no longer shown, not that data is missing",
    nl.text.includes("Niet meer getoond") && !nl.text.includes("Onvoldoende gegevens"), nl.text.slice(0, 220));

  const fr = render("fr", all, petrol, "flanders");
  check("FR expired sentence is shown",
    fr.text.includes("TaksCheck n'affiche plus de montants") && fr.text.includes("sont trop anciens"), fr.text.slice(-240));
}

// ---- 5. unvalidated region -------------------------------------------------
console.log("\n== Unvalidated region: named as such, sent to its own simulator ==\n");
for (const region of ["brussels", "wallonia"]) {
  const all = engine.computeAll(petrol, region, CURRENT);
  const nl = render("nl", all, petrol, region);
  check(region + ": no euro amount", !/€/.test(nl.html));
  check(region + ": NL says the region is not yet validated",
    nl.text.includes("Nog niet gevalideerd voor deze regio"), nl.text.slice(0, 240));
  check(region + ": the note appears once, not once per figure",
    (nl.text.match(/Nog niet gevalideerd voor deze regio/g) || []).length === 1);
  check(region + ": links to that region's own simulator",
    nl.html.includes(tariffs.simulatorUrls[region]));
  const fr = render("fr", all, petrol, region);
  check(region + ": FR says the region is not yet validated",
    fr.text.includes("Pas encore validé pour cette région"), fr.text.slice(0, 240));
}

// ---- 5b. no assumption reason renders twice in one panel -------------------
// Every engine assumption the badge cannot match falls through to the generic
// "Enkele waarden zijn geschat". Two NEDC branch strings had no rule, one from
// the BIV and one from the road tax, so a pre-2021 car printed that same line
// twice in the same list and it read as a bug. Iris caught it while preparing
// the store screenshots on 2026-09-07. This asserts the panel never repeats a
// reason, which catches the next missing rule as well as these two.
console.log("\n== assumption list has no duplicate rows ==\n");
{
  // The control vehicle from Iris's screenshot 3: a pre-2021 diesel, which takes
  // the NEDC branch on both taxes and derives fiscal PK from displacement.
  const nedc = { title: "BMW 320d", fuel: "diesel", co2: 148, euroNorm: 6,
                 displacementCc: 1995, firstRegistration: "2019-06-15" };
  const all = engine.computeAll(nedc, "flanders", CURRENT);
  for (const lg of ["nl", "fr"]) {
    const r = render(lg, all, nedc, "flanders");
    const rows = [...r.html.matchAll(/<span class="tc-rz">([^<]*)<\/span>/g)].map((m) => m[1]);
    const dupes = rows.filter((v, i) => rows.indexOf(v) !== i);
    check(lg.toUpperCase() + ": no assumption reason appears twice",
      dupes.length === 0, "duplicated: " + JSON.stringify([...new Set(dupes)]));
    check(lg.toUpperCase() + ": no reason fell through to the generic string",
      !rows.includes(lg === "nl" ? "Enkele waarden zijn geschat" : "Certaines valeurs sont estimées"),
      JSON.stringify(rows));
  }
  const nl = render("nl", all, nedc, "flanders");
  check("NL names the BIV NEDC branch specifically",
    nl.text.includes("Van voor 1 januari 2021: NEDC-formule voor de BIV"), nl.text.slice(0, 260));
  check("NL names the road tax NEDC branch specifically",
    nl.text.includes("Van voor 1 januari 2021: NEDC-CO2 gebruikt"), nl.text.slice(0, 260));
}

// ---- 6. a genuinely incomplete advert still reads as incomplete ------------
console.log("\n== Missing input still reads as missing input ==\n");
{
  const all = engine.computeAll(noCo2, "flanders", CURRENT);
  const nl = render("nl", all, noCo2, "flanders");
  check("BIV without CO2 still names the missing field",
    nl.text.includes("Onvoldoende gegevens") && nl.text.includes("de CO2-waarde"), nl.text.slice(0, 260));
}

console.log("\nBadge assertions: " + (total - failures) + "/" + total + " passed.");
if (failures) {
  console.log("RESULT: FAIL (" + failures + ").");
  process.exit(1);
}
console.log("RESULT: PASS.");

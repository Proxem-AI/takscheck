# TaksCheck

A Manifest V3 Chrome extension prototype that reads an AutoScout24 or mobile.de
car ad and shows two estimated Belgian vehicle taxes as an on-ad badge:

- **BIV / TMC** the one-off registration tax (belasting op de inverkeerstelling)
- **Rijtaks / TC** the annual road tax (jaarlijkse verkeersbelasting)

The badge is bilingual (NL / FR): it auto-detects the page language, defaults to
Dutch, and carries a manual NL / FR toggle whose choice is remembered.

Everything runs client side, in the tab the user already opened. No data leaves
the browser. Every figure is labelled an estimate; the binding amount is set by
the regional tax office from the certificate of conformity.

## What is implemented

- **Tax engine** (`core/tax.js`), a pure, framework-free module encoding all
  three regions:
  - **Flanders** BIV: the CO2 formula `((CO2 x f x q)/246)^6 x 4500 + c) x LC`,
    with the confirmed 2026 constants (q = 1.245, the calibrated air-component
    `c` grid, fuel factors, the LC age table, the 61.50 EUR EV minimum). This is
    the validated priority and matches the official simulator to the cent.
  - **Brussels** TMC: the traditional higher-of fiscal-HP / kW dual table, the
    15-year federal age schedule, EV flat 78.88 EUR.
  - **Wallonia** TMC: the reformed 2025 formula `MB x (CO2/X) x (MMA/1838) x C`
    with the kW base table, energy coefficient, mass ratio, 50 / 9000 bounds.
  - Annual road tax per region on the representative fiscal-HP scale, with the
    simulator-confirmed Flemish EV flat (102.96 EUR) and minimum (58.55 EUR).
- **Updateable tariff tables** as JSON (`core/tariffs.json`), baked in as the
  default. The logic reads the numbers from this file, so tariffs can be updated
  without touching code.
- **Derivations** from the research: fiscal HP from cc (cc / 200), Euro norm and
  WLTP/NEDC cycle inferred from the first-registration date, MMA fallback tiering
  (ad value, then kerb weight + payload, then body-type default).
- **Confidence + assumptions**: every result carries a confidence level and the
  list of assumptions used. The badge surfaces confidence as an "approx." / "env."
  tag plus a short localised note; the full assumptions list stays in the
  `[BIV+Rijtaks]` console debug line to keep the on-ad badge clean.
- **Two per-site detail-page adapters feeding one shared pipeline**
  (normaliser to tax engine to Shadow-DOM badge). Only extraction differs:
  - **AutoScout24** (`content/autoscout24.js`): parses `__NEXT_DATA__`
    (`props.pageProps.listingDetails`).
  - **mobile.de** (`content/mobilede.js`): parses the schema.org Car JSON-LD
    first, with a fallback to the labelled German **Technische Daten** table
    (stable label text, not hashed class names).
  Both normalise into the same `Vehicle` shape, run the same engine, and inject
  the same panel via **Shadow DOM**, re-running on SPA navigation.
- **Badge design** (`ui/badge.js`): Iris's approved TaksCheck identity in a
  style-isolated Shadow DOM overlay. Light header (`#F1F4F8`) with the
  Belgian-plate mark (soft drop-shadow), the ink + ruby `TaksCheck` wordmark and
  the NL / FR toggle; a compact vehicle line; the BIV and Rijtaks figures in two
  reflow-proof columns (euro in tabular mono, key label in a fixed two-line slot
  so the longer French wording never shifts the numbers); a footer with the
  region plate tag and a single-hue verdict (low = neutral, medium = pale ruby
  tint, high = full ruby fill, no green or amber); and an estimate disclaimer.
  Palette is one blue `#1B54C7`, one ruby `#841922`, plus neutrals. States: full
  data, low confidence (an "approx." / "env." tag plus a localised sentence), and
  a "not enough data" cell naming the missing input while the other tax still
  computes. Currency uses the euro glyph with a dot thousands separator (e.g. the
  glyph then "1.847"), the Belgian convention.
- **Options page** (`options.html`): region selection (Flanders default), stored
  in `chrome.storage.sync`.
- **Regression harness** (`test/harness.mjs`): runs the Flemish engine against
  the official simulator's recorded ground truth.

## Load the unpacked extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder
   (`~/Projects/belgian-car-tax-extension`).
4. Open the extension **Options** (or the Details page > Extension options) and
   pick your region. Flanders is the default.
5. Open any **detail** page (a single car, not the search results list):
   - AutoScout24, e.g. an ad on `autoscout24.be` or `autoscout24.de`.
   - mobile.de, e.g. `suchen.mobile.de/auto-inserat/<slug>/<id>.html`.
   A panel appears bottom-right with the BIV and Rijtaks estimates. Click its
   header to collapse it. Open the browser console to see the extracted vehicle
   and the full computation under the `[BIV+Rijtaks]` debug line.

If a badge shows "not enough data", the ad did not expose a required field
(typically CO2 for Flanders, or displacement for the fiscal-HP based figures).

## Run the regression harness

```bash
node test/harness.mjs
# or
npm test
```

The harness proves the Flemish engine against government ground truth. It runs
the test vehicles Pax recorded from the official Vlaamse Belastingdienst
simulator (research section 0.9: petrol and diesel across Euro 0-6 at 130 and
100 g/km, LPG, CNG, and a new EV) plus age-correction and floor boundary cases,
and asserts each matches within +/- 0.15 EUR.

**Current result: 23/23 pass, max delta 0.000 EUR** against the 19 official
simulator values. The engine reproduces the simulator exactly.

### About the live simulator

The harness also attempts a live call to
`POST https://belastingen.fenb.be/api/public/simulation/vkb/simulation`. That
endpoint is WAF-protected and returns HTTP 403 to non-browser HTTP clients, so
the live probe reports the block and falls back to the recorded values. Those
recorded values were captured from the exact same simulator through a real
browser, so they are the authoritative ground truth. To refresh them, drive the
simulator wizard in a browser (or via browser automation, as Pax did) and read
`resultBIV` from the JSON response.

## Scope (this prototype) and next phase

**In scope now**

- **AutoScout24 detail pages** across all country domains (be, de, nl, fr, lu,
  com, it, es, at, bg, hr, pl, ro, se, tr).
- **mobile.de detail pages** (`*.mobile.de`, including `suchen.mobile.de` and
  `www.mobile.de`): JSON-LD first, Technische Daten table fallback.
- All three regional formulas, with **Flanders BIV validated** against the
  official simulator.

**Deferred to the next phase**

- **List-view** badges (AutoScout24 and mobile.de) with the SPA plus
  infinite-scroll handling. Badges currently appear on detail pages only.
- **Brussels and Wallonia validation.** Their formulas are encoded from the
  research but not round-tripped against an official simulator (Brussels has no
  public simulator; Wallonia was not driven). Spot-check before relying on them.
- **Annual road-tax precision.** The per-CV cents come from a representative
  shared scale and drift by indexation window. Only the Flemish EV flat and
  minimum are simulator-pinned. Re-scrape the three official baremes to pin them.
- **Remote tariff refresh.** `sw.js` is where a scheduled fetch of an updated
  `tariffs.json` from a Proxem-controlled endpoint would live (data only, never
  remote code, per MV3).

## Accuracy caveats

- **CO2 quality is the dominant risk.** CO2 is missing on many pre-2018 and
  private ads; without it the Flemish BIV cannot be computed precisely and the
  badge shows "not enough data" rather than a wrong number. When CO2 is present
  the ad rarely states WLTP vs NEDC, so the cycle is inferred from the
  registration date (2018-09 to 2019 is a genuine mixed window, flagged low).
- **Fiscal HP is always derived** (cc / 200), never listed; it can be off by a
  bracket, which matters most for the steep annual-tax steps.
- **MMA is rarely published for passenger cars**, so Wallonia usually runs on a
  defaulted mass and is labelled accordingly.
- Euro norm, when absent, is inferred from the registration date.

## Files

```
manifest.json            MV3 config, narrow AutoScout24 + mobile.de host permissions, storage only
icons/                   plate mark: icon.svg + icon-16.svg sources, icon16/32/48/128.png (toolbar + store)
core/tax.js              pure tax engine (BIV + Rijtaks, all three regions)
core/tariffs.json        updateable tariff tables (baked-in default)
core/normalise.js        site payload -> common Vehicle (fromAutoScout24, fromMobileDe)
content/autoscout24.js   AutoScout24 detail-page adapter (parse __NEXT_DATA__)
content/mobilede.js      mobile.de detail-page adapter (JSON-LD + Technische Daten)
ui/badge.js              Shadow-DOM TaksCheck badge renderer (shared, bilingual NL / FR)
options.html / options.js  region selection UI
sw.js                    ephemeral MV3 service worker
test/harness.mjs         regression harness vs the official Flemish simulator
```

## Privacy

The extension collects and transmits nothing. It reads the page you are viewing,
computes locally, and stores only your region choice in `chrome.storage.sync`.
The only extension resource loaded is the bundled `core/tariffs.json`.

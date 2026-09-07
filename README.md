# TaksCheck

## Disclaimer

TaksCheck produces an estimate of Belgian vehicle tax from the data in a
car advert. It is not an official assessment and not tax advice. The
binding amount is set by the regional tax authority from the vehicle's
certificate of conformity.

Flemish rates are re-indexed every 1 July, and the BIV q coefficient
changes every 1 January. The rate tables in core/tariffs.json carry the
window they are valid for. Figures computed outside that window are
labelled stale in the interface and are withdrawn entirely after twelve
months.

Scope of validation: Flanders only. Verified against the official Vlaamse
Belastingdienst simulator on 1 September 2026, 27 of 29 cases exact to the
cent on BIV and 28 of 29 on road tax, with the residual differences
attributable to the simulator's own rounding. See
test/simulator-comparison-2026-09.json.

TaksCheck is an independent tool by Proxem AI. It is not affiliated with,
endorsed by or connected to the Vlaamse Belastingdienst, AutoScout24 or
mobile.de.

## What it is

A Manifest V3 Chrome extension that reads an AutoScout24 or mobile.de
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
  - **Flanders** BIV: two branches, not one. From first registration
    01/01/2021 the numerator is `CO2 x f x q` (WLTP); before that date it is
    `CO2 x f + 63.00` (NEDC) and q does not appear at all. Both run through
    `(numerator/246)^6 x 4500 + c`, then the LC age correction. Constants are
    the calibrated air-component `c` grid, the fuel factors, the statutory LC
    table and the 61.50 EUR EV flat. q is 1.245 for calendar year 2026 and
    lives in `flanders.biv.qWindows` with its own validity dates, because it
    moves every 1 January while the amounts move every 1 July. This is the
    validated priority and matches the official simulator to the cent.
  - **Brussels** TMC: the traditional higher-of fiscal-HP / kW dual table, the
    15-year federal age schedule, EV flat 78.88 EUR.
  - **Wallonia** TMC: the reformed 2025 formula `MB x (CO2/X) x (MMA/1838) x C`
    with the kW base table, energy coefficient, mass ratio, 50 / 9000 bounds.
  - Annual road tax per region on the representative fiscal-HP scale. The
    Flemish EV flat is 107.16 EUR and the minimum 60.94 EUR in the window from
    1 July 2026; the preceding window carries 107.18 and 58.55. 102.96 EUR is
    the WALLOON EV forfait, which this README previously attributed to Flanders
    and called simulator-confirmed. It is neither: the provenance block marks
    it SUSPECT, sourced from "unknown", and notes it is the Flemish figure
    copied into the wrong region.
- **Updateable tariff tables** as JSON (`core/tariffs.json`), baked in as the
  default. The logic reads the numbers from this file, so tariffs can be updated
  without touching code.
- **Derivations** from the research: fiscal HP from cc (cc / 200), Euro norm and
  WLTP/NEDC cycle inferred from the first-registration date, MMA fallback tiering
  (ad value, then kerb weight + payload, then body-type default).
- **Input completeness + assumptions**: every result carries a tier and the
  list of assumptions used. The tier measures how complete the ADVERT was, which
  is all it can measure: high means the fiscal PK was stated and CO2, Euro norm
  and fuel were all known, low means a plug-in hybrid or a guessed Euro norm.
  It is captioned "Gegevens uit de advertentie" and "Donnees de l'annonce" for
  that reason. It is not a claim about how close the figure is to the right
  answer, and it cannot be: a meter fed by the advert has no way to detect the
  formula being wrong. Model confidence belongs in the comparison result above,
  because something measured that. The badge also shows an "approx." / "env."
  tag and a short localised note; the full assumptions list stays in the
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
  data, partial data (an "approx." / "env." tag plus a localised sentence), a
  "not enough data" cell naming the missing input while the other tax still
  computes, a stale-rates state that keeps the figures and labels them, and an
  expired state that withdraws them. A blank cell always names its own reason:
  the advert was short of a field, the region is not validated, or the rates are
  too old to stand behind. Currency uses the euro glyph with a dot thousands separator (e.g. the
  glyph then "1.847"), the Belgian convention.
- **Options page** (`options.html`): region selection (Flanders default), stored
  in `chrome.storage.local`.
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
npm test
```

`npm test` runs seven stages, in this order. Each is its own `node` process, chained with `&&`, so no stage can leak state into another and the first failure stops the run:

| Stage | What it proves |
| --- | --- |
| `test/window-expiry-check.mjs` | Every dated window in `core/tariffs.json` is still live. Fails the build once today is past the newest window of any series, with 60 days of warning first. |
| `test/harness.mjs` | 27 assertions: the official Vlaamse Belastingdienst BIV ground truth, engine boundary cases, and the v1 scope gate. |
| `test/roadtax-harness.mjs` | 19 rows of the official road-tax table, to the cent. |
| `test/simulator-comparison-harness.mjs --strict` | The 29 case official simulator capture, 58 comparisons across BIV and road tax. |
| `test/badge-states.mjs` | 39 assertions: the badge renders correctly in the current, stale, expired and unvalidated-region states, in NL and FR, and carries the wording and the aria strings the legal review fixed. |
| `test/mobilede-extract.mjs` | 41 assertions: the mobile.de detail-page gate and extractor against six DOM shapes plus the JSON-LD path, including the old URL format, on mock pages built with linkedom. |
| `test/host-permissions.mjs` | 26 assertions: the three match-pattern lists in `manifest.json` agree, the six retained domains match and the ten removed ones do not, and the real content scripts render a badge on each retained domain. |

**Current result: 27 of 29 cases exact to the cent on BIV and 28 of 29 on road
tax** against the official simulator, captured 1 September 2026, Flanders only.
Three residuals: one cent on `AGE-1Y` and `NEDC-200` (BIV), two cents on
`FUEL-DIE` (road tax), all attributable to the simulator's own rounding. No row
is outside 0.05 EUR. Full record: `test/simulator-comparison-2026-09.json`.

The window expiry check can be shown to bite by faking the clock:

```bash
TAKSCHECK_TODAY=2027-01-01 npm test   # exits 1: the q window lapsed on 2026-12-31
```

That environment variable is a test hook for demonstrating the ratchet. It is
not for use in CI.

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
- **Flanders only.** The BIV and the annual road tax, both validated against
  the official simulator. Brussels and Wallonia are encoded but scoped out, see
  below.

**Deferred to the next phase**

- **List-view** badges (AutoScout24 and mobile.de) with the SPA plus
  infinite-scroll handling. Badges currently appear on detail pages only.
- **Brussels and Wallonia validation.** Their formulas are encoded from the
  research but not round-tripped against an official simulator (Brussels has no
  public simulator; Wallonia was not driven). They are therefore OUT OF SCOPE
  for v1: `scope.validatedRegions` in `core/tariffs.json` holds v1 to Flanders,
  and the other two regions return a "not yet validated" panel with a link to
  their own official simulator instead of a figure. Presenting an unvalidated
  amount in the same typography as a Flemish amount checked against 29 official
  runs claims more than the evidence supports. They return by being validated
  the way Flanders was and added to that list.
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
test/harness.mjs         BIV ground truth, boundary cases, v1 scope gate
test/roadtax-harness.mjs official road-tax table, 19 rows
test/simulator-comparison-harness.mjs  29 case official simulator capture
test/badge-states.mjs    badge wording and the four panel states, NL and FR
test/window-expiry-check.mjs  fails the build once a tariff window lapses
LICENSE                  Apache License 2.0
```

## Permissions

TaksCheck requests the minimum that lets it do its one job. The set was cut from
16 host permissions to 6 on 7 September 2026, before the Chrome Web Store
submission, because ten of them could not be justified. `test/host-permissions.mjs`
fails the build if the set grows again or if the three match-pattern lists in
`manifest.json` fall out of step.

**`storage`**

> TaksCheck stores two user preferences using `chrome.storage.local`: the Belgian
> tax region the user selects, and whether they want the interface in Dutch or
> French. Both are chosen by the user in the extension popup or options page, and
> both are read by the content script so the panel on the advert shows figures for
> the correct region in the correct language. Nothing else is stored. Storage is
> local to the device and is not synced to any account. The extension makes no
> network requests to any server, so nothing is transmitted.

**Host permissions** (`autoscout24.be`, `autoscout24.de`, `autoscout24.nl`, `autoscout24.fr`, `autoscout24.lu`, `mobile.de`)

> TaksCheck reads the vehicle specification already shown on a car advert the user
> has opened (fuel type, CO2 figure, engine power, cylinder capacity, date of first
> registration and Euro emission standard) and displays the estimated Belgian
> registration tax and annual road tax in a panel on that page. Access is needed to
> the six domains where those adverts appear: `autoscout24.be` for the Belgian
> market, and `autoscout24.de`, `autoscout24.nl`, `autoscout24.fr`,
> `autoscout24.lu` and `mobile.de`, which are the markets Belgian buyers import
> from and where the Belgian tax figure is the question the user actually has. All
> reading happens in the user's own browser, on a page they opened themselves. No
> page content is copied, stored or sent anywhere. Ten further AutoScout24 country
> domains were removed on 7 September 2026 because a Belgian tax calculator has no
> legitimate need for them.

No remote code is loaded. The only `fetch` calls in the extension read the bundled
`core/tariffs.json` through `chrome.runtime.getURL`.

Storage is `chrome.storage.local`, deliberately, not `chrome.storage.sync`. Sync
would have replicated the two preference keys through the user's Google account,
which means data leaving the device, and that would turn "transmits nothing" into
a sentence needing a footnote. Carrying a region choice between a user's machines
is not worth qualifying the main claim. `test/host-permissions.mjs` fails the
build if `chrome.storage.sync` reappears in shipped code.

## Licence

Apache License 2.0. See `LICENSE`.

Apache 2.0 over MIT for the express limitation of liability: for a tax
calculator, where the whole concern is responsibility for a wrong output, the
stronger and more explicit clause is the right one.

Note what that does and does not cover. The warranty disclaimer binds anyone
who takes this source code under the licence. It does not bind an end user who
installs the packaged extension from a store, because that person is not a
licensee of the code. The licence protects the repository; the notice at the
top of this file and the notice rendered in the extension protect the product.
Both are needed and neither substitutes for the other.

## Privacy

The extension collects and transmits nothing. It reads the page you are viewing,
computes locally, and stores two preferences, your region and your choice of
Dutch or French, in `chrome.storage.local`. Local means on your device: they are
not synced to a Google account or anywhere else. The only extension resource
loaded is the bundled `core/tariffs.json`. There are no network requests, no
telemetry, no analytics and no remote endpoint.

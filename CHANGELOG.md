# Changelog

Versions follow the `version` field in `manifest.json`. This file starts at 0.1.1;
earlier history is in `git log`.

## 0.1.1 (2026-10-23)

### Fixed

- Flemish BIV for assessments dated from 1 January 2027 now uses q = 1.28. Before
  this release the engine held q at 1.245 (the 2026 value) after 31 December 2026,
  which under-quotes the CO2 component of every car first registered from
  1 January 2021, because q sits under a sixth power.
- Source: Vlaamse Codex Fiscaliteit art. 2.3.4.1.2/1, tweede lid, 3 ("q is gelijk
  aan 1,07 in 2021 en wordt jaarlijks verhoogd met 0,035 vanaf het jaar 2022"),
  consolidated text read on 2026-10-23 at codex.vlaanderen.be, document 1023499.
- q is stored per calendar year in `flanders.biv.qWindows`, never computed. After
  2027 the engine serves the newest window, labels it stale and does not
  extrapolate (1.315 for 2028 is deliberately not served).

### Tests

- `test/q-windows.mjs` pins q for 2026, 2027 and 2028 and requires the 2028 BIV
  to equal the 2027 BIV, so any extrapolation fails the build.

### To do

- January 2027: re-run the official Flemish BIV simulator for a 2027 assessment and
  confirm q = 1.28. The 2027 value is read from the statute and is not yet
  confirmed against the simulator, which cannot be driven for 2027 before 2027.
- Before 1 July 2027: add the indexed 1 July 2027 amount windows, or the expiry
  check in `test/window-expiry-check.mjs` fails the build.

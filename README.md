# Nearby Flight Radar

A fully static [Astro](https://astro.build) site that shows a live **green radar**
of aircraft flying near you. Flights are plotted as blips; when the sweep passes
over one it "pings" and reveals the **flight number** and **origin → destination**.

No backend, no API keys, no scraping. Everything runs in the browser against two
keyless, CORS-enabled public sources:

- **[airplanes.live](https://airplanes.live/api-guide/)** — live ADS-B positions
  around a point (returns distance + bearing from the center, ideal for a radar).
- **[vradarserver standing-data](https://github.com/vradarserver/standing-data)**
  via `adsb.lol` — one JSON file per callsign
  (`https://vrs-standing-data.adsb.lol/routes/BA/BAW123.json`) giving its
  departure/arrival airports, under ODbL and cached in-memory + `localStorage`.
  These files are keyed on callsign alone, which is often ambiguous (a callsign
  reused across different city pairs), so a naive lookup can return a route
  belonging to a completely different flight. Because each file also carries the
  airports' coordinates, the app disambiguates **client-side**: it keeps a route
  only if the aircraft's live position falls within a great-circle corridor of
  the route, and rejects the mismatches.
- **[vradarserver standing-data `airlines.csv`](https://github.com/vradarserver/standing-data/tree/main/airlines)**
  — the route files carry only an ICAO airline *code* (e.g. `BAW`), so this
  CC0 dataset maps it to a readable name (`British Airways`). Fetched at most
  once per session and cached for a week in `localStorage`.

Both are free for non-commercial use and rate-limited to ~1 request/second.

> **Why not `adsb.lol`'s `/api/0/routeset`?** That position-aware POST endpoint
> would do the plausibility check server-side, but it no longer returns CORS
> headers on its preflight, so a static browser-only site can't call it. The
> static standing-data files it's built on *are* CORS-enabled, so we read those
> directly and do the plausibility check ourselves.

## Run it

```bash
npm install
npm run dev      # http://localhost:4321
```

Build the static site (outputs to `./dist`, deployable anywhere):

```bash
npm run build
npm run preview
```

## Configure

Edit `src/config.js`:

- `fallback` — coordinates used if geolocation is denied (defaults to London).
- `useGeolocation` — ask the browser for your location first.
- `rangeNm` — outer radar ring in nautical miles (max 250 per API query).
- `pollIntervalMs` — how often to refresh positions (keep >= 1000).
- `staleAfterSec` — drop contacts not heard from for this long.
- `minAltFt` — hide traffic below this altitude (0 = show everything).
- `soundEnabled` — default sound state (off); the speaker button overrides and
  remembers your choice.
- `maxBackoffMs` / `staleAfterIntervals` — poll-failure backoff ceiling and how
  many intervals before "last updated" is flagged stale.

## Features

- **Special-flight highlighting** — military (ADS-B mil flag / callsign),
  emergency squawks (7500/7600/7700), and rare airframes get a distinct colour,
  a pulsing glow, a status tag, and a persistent (non-fading) blip.
- **Sound (opt-in)** — a Web Audio radar ping on each sweep-cross and a soft
  chime for the hero moment. Muted by default; toggle with the speaker button.
- **Wake lock + recovery** — the screen is kept awake, failed polls retry with
  exponential backoff, and a "last updated Xs ago" readout shows staleness.

## Dev / demo mode

Click the faint `</>` button next to Passport, load the page with `?dev` in
the URL, or press <kbd>D</kbd> to open a demo panel. Its buttons inject synthetic contacts — heavy jet, rare (A380),
military, emergency 7700, radio-fail 7600, hijack 7500, light GA — right onto
the scope so you can preview the hero banner and special-flight highlighting
with no real traffic. "Clear demo" removes them.

## How it works

| File | Role |
| --- | --- |
| `src/config.js` | User settings |
| `src/scripts/api.js` | Fetch positions + resolve/cache routes + special-flight flags |
| `src/scripts/radar.js` | Canvas radar renderer (sweep, blips, phosphor, labels, highlighting) |
| `src/scripts/audio.js` | Web Audio synth for the ping + hero chime (no assets) |
| `src/scripts/main.js` | Geolocation, polling loop, hero/wake-lock wiring |
| `src/pages/index.astro` | HUD shell + styling |

## Notes / limitations

- Coverage depends on volunteer ADS-B receivers: excellent over Europe, North
  America, East Asia and Australia; sparse over oceans and remote regions.
- Private / general-aviation and some shuttle callsigns have no route in the
  route database, so those blips show the callsign (and operator) alone.
- Geolocation requires a secure context (`https://` or `localhost`).

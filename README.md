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
- **[Planespotters.net photo API](https://www.planespotters.net/photo/api)** —
  keyless, CORS-enabled lookup of the latest photo for a registration, used for
  the aircraft thumbnails in the passport's Aircraft logbook. Images are loaded
  straight from Planespotters' CDN in your browser, each credits its
  photographer and links back to the photo page, and JSON responses are cached
  for 24h in `localStorage` per their terms of use.
- **[Open-Meteo](https://open-meteo.com)** — keyless, CORS-enabled, worldwide
  current conditions (temperature, WMO weather code, wind) for the nearest
  airport, shown as a subtle weather chip in the HUD.
- **[OurAirports](https://ourairports.com)** — a curated public-domain subset
  (every large + medium airport worldwide) is **bundled** with the app as
  `src/data/airports.json` and lazy-loaded in its own chunk. It powers the
  subtle airport overlay on the scope and picks the nearest airport for the
  weather chip. No third-party request; it's part of the static build.

These are free for non-commercial use and rate-limited to ~1 request/second.

> **Why not `adsb.lol`'s `/api/0/routeset`?** That position-aware POST endpoint
> would do the plausibility check server-side, but it no longer returns CORS
> headers on its preflight, so a static browser-only site can't call it. The
> static standing-data files it's built on *are* CORS-enabled, so we read those
> directly and do the plausibility check ourselves.

> **Why not aviationweather.gov METAR?** It's the natural METAR source, but it
> sends no CORS headers (their docs: *"Cross-origin resource sharing is not
> permitted at this time."*), so a browser-only static site can't read it — the
> same wall as `routeset` above. Open-Meteo is keyless, CORS-enabled and
> worldwide, so the weather chip reads current conditions from it instead.

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
- **Airport overlay** — large/medium airports within range are drawn subtly on
  the scope (a faint ring, with a code label on the nearest few) from a bundled
  OurAirports subset, so blips have geographic context.
- **Nearest-airport weather** — a faint HUD chip shows current conditions
  (temperature, sky, wind) for the closest airport, via Open-Meteo. Refreshed
  on a location change and every 10 minutes.

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
| `src/scripts/api.js` | Fetch positions + resolve/cache routes + special-flight flags + nearest-airport weather |
| `src/scripts/airports.js` | Bundled-airport lookup (nearest + within-range) |
| `src/data/airports.json` | Bundled OurAirports subset (large + medium airports) |
| `src/scripts/radar.js` | Canvas radar renderer (sweep, blips, phosphor, labels, highlighting, airport overlay) |
| `src/scripts/audio.js` | Web Audio synth for the ping + hero chime (no assets) |
| `src/scripts/main.js` | Geolocation, polling loop, hero/wake-lock wiring, airport overlay + weather |
| `src/pages/index.astro` | HUD shell + styling |

## Notes / limitations

- Coverage depends on volunteer ADS-B receivers: excellent over Europe, North
  America, East Asia and Australia; sparse over oceans and remote regions.
- Private / general-aviation and some shuttle callsigns have no route in the
  route database, so those blips show the callsign (and operator) alone.
- Geolocation requires a secure context (`https://` or `localhost`).

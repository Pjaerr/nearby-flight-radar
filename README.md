# Nearby Flight Radar

A fully static [Astro](https://astro.build) site that shows a live **green radar**
of aircraft flying near you. Flights are plotted as blips; when the sweep passes
over one it "pings" and reveals the **flight number** and **origin → destination**.

No backend, no API keys, no scraping. Everything runs in the browser against two
keyless, CORS-enabled public APIs:

- **[airplanes.live](https://airplanes.live/api-guide/)** — live ADS-B positions
  around a point (returns distance + bearing from the center, ideal for a radar).
- **[adsbdb.com](https://github.com/mrjackwills/adsbdb)** — resolves a callsign to
  its departure/arrival airports (cached in-memory + `localStorage`).

Both are free for non-commercial use and rate-limited to ~1 request/second.

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
- Private / general-aviation and some shuttle callsigns have no route in adsbdb,
  so those blips show the callsign alone.
- Geolocation requires a secure context (`https://` or `localhost`).

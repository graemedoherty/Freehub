# Freehub: project handover

Paste this file (or tell Claude to read it from the repo) at the start of a new chat. It describes what Freehub is, how it is built, and where things live.

## What it is
Freehub is Graeme's personal replacement for a Zwift subscription, used with a Zwift Hub smart trainer and a Bluetooth heart-rate strap. It is a zero-dependency Node server plus a static dashboard that runs in Chrome (or an Electron desktop wrapper). Graeme is a mobile (Android/iOS) developer. His FTP is about 180 W. He is training for IRONMAN Malaga 70.3 (31 Oct 2027) and is currently building aerobic base.

## Files
| Path | Purpose |
|---|---|
| `server.js` | Node 18+ http server, no npm dependencies. Serves `public/`, relays live state over SSE, handles Strava OAuth and upload, stores rides and plans on disk. |
| `public/index.html` | The whole dashboard (about 136 KB, one inline script). Everything below under "Dashboard" lives here. |
| `public/companion.html` | Phone companion page, opened by QR code over the LAN. Shows live data and has remote controls. |
| `public/qrcode.js` | QR generator. |
| `public/fonts/` | Bundled Nunito (soft, rounded font, SIL Open Font License) so the look is the same on Mac, Windows and the phone. |
| `public/images/` | `freehub_logo.png`, `freehub_mark.png`, `favicon.png` (all transparent PNGs), `freehub_logo.jpeg` (old, unused). |
| `electron/main.js`, `picker.html`, `picker-preload.js` | Desktop wrapper. Runs the server in-process and provides a Bluetooth device picker. |
| `package.json`, `build/` | electron-builder config (dmg arm64+x64, NSIS x64), `build/icon.png`, `build/entitlements.mac.plist`. |
| `.github/workflows/build.yml` | CI matrix build for Mac and Windows. |
| `data/` | Created at runtime: `rides/`, `store/custom.json`, `store/plans.json`. Git-ignored. Back this folder up. |
| `config.json`, `tokens.json` | Strava client keys and OAuth tokens. Git-ignored. |

Run it with `node server.js` and open `http://localhost:<port>` in Chrome. Web Bluetooth only works in Chrome/Edge and Electron, not Safari or Firefox. `FREEHUB_DATA` env var moves the data directory (Electron sets it to the user data folder).

## Server
- LAN-exposed routes are only `/companion`, `/api/state-stream`, `/api/cmd` and `/images/*`. Everything else is localhost-only.
- Persistence API: `GET /api/rides`, `GET/PUT/DELETE /api/rides/:id`, `GET /api/rides/:id/tcx`, `POST /api/rides/:id/upload` (Strava), `GET/PUT /api/store/custom` and `/api/store/plans`.
- Strava: OAuth plus TCX upload. New Strava apps are limited to Single Player Mode (about 10 athletes without Strava review). The public API cannot attach photos.
- Port clash: prints a clear EADDRINUSE message.

## Dashboard (public/index.html)
**Bluetooth (FTMS)**: service 0x1826, Indoor Bike Data 0x2AD2, Control Point 0x2AD9. Opcodes used: request control 0x00, ERG target power 0x05, start 0x07, stop 0x08, simulation params 0x11. Separate HR strap connection.

**Live tiles**: speed, power (actual left, target right, up/down arrow when more than 5 W off target), HR, cadence (with speed up / slow down hint when a cadence target exists), time, distance. Each tile has a small corner-notch icon (`TILE_ICONS`, `.tbadge`). Power zone bar. Weight, FTP and speed source are stored in localStorage (`hubrider.ftp`, `hubrider.weight`, `hubrider.speedsrc`).

**Workout engine**
- A session is a list of steps: `{label, dur, from, to, hr?, cad?:[lo,hi], free?}`. `from` and `to` are fractions of FTP; a different `to` makes a ramp.
- `finalize()` computes offsets and total, `currentTarget()` and `applyTarget()` drive the trainer, `nextStep()` and `wkInfo()` feed the UI.
- Warm-ups ramp in 5 W-style stages by design of the preset definitions; ERG targets are sent as integer watts.
- HR steps (`H(label, mins, bpm, start)`): `hrControl()` runs every 10 s, averages about 10 s of HR, nudges ERG power by at most 4 W (gain 0.4, clamp 30 to 110 percent of FTP) to hold the target BPM.
- `free` steps release ERG control (trainer returns to simulation mode) and the UI shows FREE.
- Cadence steps use `CAD(st, lo, hi)`.
- Tests: `ramp` (FTP = 75 percent of best 1-minute power) and `ftp20` (FTP = 95 percent of 20-minute average). `testResult()` opens an overlay with "Use X W as my FTP" / "Keep".
- Presets include Sweet Spot, threshold, VO2, endurance, aerobic base (`ab60`, `ab90`, `abl`), recovery spin (`rec45`), low cadence torque (`lct55`, `lct60`), plus the two FTP tests.
- Session builder supports power, HR and cadence columns. Custom sessions are saved to `data/store/custom.json` (migrated from localStorage `hubrider.custom`).
- Chart: `drawProfile(cv, t0, t1, pos, o)` canvas renderer with interval separators, watt labels inside blocks wide enough, hover tooltip (`#ptip`) via `canvas._geo`. Options: `mini`, `bare` (`cv._bare`, no axes, used over video), `o` for image rendering.

**History**: every finished ride is saved to `data/rides/` (record plus TCX). History overlay shows totals, a list, and a detail view with a regenerated 4:3 share image (`buildShareImage`, 1600x1200), TCX download, Strava upload, rename and delete.

**Training plans**: Plan overlay with templates (4-week FTP build, 4-Week Aerobic Base, 3-week sweet spot), an active plan, per-day status, "today's session" shortcut and a plan editor. Stored in `data/store/plans.json`.

**YouTube mode** (header button, `#ytMode`): pastes a YouTube video or playlist URL (IFrame API) and overlays glass (iOS-style, backdrop-filter) data cards vertically centred on the right: speed, power with target and arrow, HR, cadence, time, distance, workout card. Cards have the same corner-notch icons. Bar at the top fades after 3.5 s of no mouse movement. Size S/M/L, H key hides the HUD, fullscreen supported. When a workout is running, a glass strip along the bottom shows the whole session across the full width, with watt labels inside blocks, dimmed completed portion, your actual power line and a lime "you are here" marker. The cards move up to make room while the strip is visible. Queue/autoplay-next is deliberately not built yet. The phone companion has a YouTube card (paste a link, play/pause, mute, show/hide data, size, exit) using `yt-*` commands over `/api/cmd`; the dashboard handles them in `ytRemote()`. While YouTube mode is open the dashboard redraws only the bottom strip (once a second) and updates the data boxes twice a second, to keep the video smooth; a Glass: Full/Light button switches the blur off for slower machines. Embedding is blocked for some videos (error codes 101, 150, 153).

**Tiles**: averages sit at the bottom right of each tile (speed, power, heart rate, cadence) on both the dashboard and the phone companion, and both use the same corner-notch icons. The companion shrinks long numbers to fit their tile and shows a small notice if the Mac page is older than the companion.

**Coach foundations (Phase 1 of the coach plan)**: `analyse(rec)` works on every ride's 5-second series and gives load (TSS), intensity (IF), efficiency (watts per bpm), time in zones and aerobic drift (watts-per-bpm change between the first and second half of the steady part of the ride; skipped for interval sessions). Results are stored on the ride as `rec.an`. After each ride the summary shows "Coach notes" in plain English and a five-button "How did it feel?" rating (`rec.feel`), also editable in History. The Progress screen (📈 button) shows weekly hours, FTP history, efficiency and drift trends and the power zones. `profile` (server store `/api/store/profile`, file `data/profile.json`) holds the FTP history (logged whenever FTP changes, with its source) and the measured Zone 2. Three Zone 2 drift test sessions (`drift65/70/75`, 75 min, `test:'drift'`) end with a result overlay (`driftResult()`) that gives a verdict, a next-step suggestion and a "Save as my Zone 2" button. Planned next: Phase 2 (levels, weekly plan generator, Today screen, adaptation using the feel rating) and Phase 3 (reading Strava runs for load, race-date periodisation; needs the `activity:read` Strava scope).

**Theme**: navy and lime. `--bg #08111f`, `--card #0f1c31`, `--card2 #14253f`, `--line #1f3453`, `--text #f2f6fc`, `--mute #8da0ba`, accent lime `#c6f31a`, blue `#4da3ff`, coral `#ff5d73`, gradient `linear-gradient(135deg,#c6f31a,#8fe03a)`. Primary buttons use dark text.

## Electron desktop app
`npm run app` runs it; `npm run dist:mac` / `dist:win` build installers. A custom Bluetooth picker replaces Chrome's. Mac builds use hardened runtime plus entitlements (bluetooth, network); notarisation uses `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` (Graeme has an Apple Developer account). Windows ships as an unsigned NSIS installer, so SmartScreen will warn.

## Testing approach
`node --check` on the extracted inline script, Playwright/Chromium screenshots with a simulated workout state, Electron under xvfb. No real hardware or YouTube access in the sandbox.

## Not yet tested on real hardware
Zwift Hub over Bluetooth in the new build, Electron Bluetooth picker, Mac signing and notarisation, Windows build, real YouTube playback and the bottom strip over video, HR controller on a real rider, ramp and 20-minute tests on the trainer, phone companion in the new theme.

## Open ideas
- Native Android app (Capacitor wrapper vs Kotlin): undecided.
- Android TV overlay: replaced for now by YouTube mode.
- YouTube queue / autoplay next: deferred by Graeme.
- Electron for non-technical friends: built-in Strava keys, first-run welcome, port fallback, friendlier Bluetooth errors.
- Optional 5 W stepped ramps, recolouring logo and app icon to lime, scheduling an FTP retest in the base plan.
- Branching: new features go on a git branch (`git switch -c feature/<name>`), merge via pull request.

## Layout v4 + Route rides (latest)
- **Layout**: header = one row of pills (Sessions, Plan, Route, History, Progress, YouTube) + connect buttons + **Phone app** dropdown (QR code + companion URL, `#btnQr`/`#qrPop`). Page = `main.app` grid: left `.stage` (main tile + strip card), right `.tiles` (Power, HR, Cadence, Speed, Norm. power/Climbed, Distance, Time). Extra stats, the 5-min chart and the ERG/weight panel sit in `.more` below. Sticky `.bottombar` holds state pill, ride chip, Start/Pause/Finish. App height follows the real header height via `--hdr`.
- **Main tile** (`#mainTile[data-view]`): `workout` | `route` | `video`, switched with `setView(v)` (tabs in the tile or the header Route/YouTube pills). The YouTube player lives inside the tile (`#ytMode`, never re-parented, so the iframe doesn't reload); **Full screen** (`ytEnterFull`) adds `.full` (fixed overlay + browser fullscreen) which shows the data HUD and the bottom strip; `ytLeaveFull` / Esc / native fullscreen exit return to the embedded tile. Render loop: full overlay ≈2.5 fps for the dashboard, embedded video ≈4 fps, otherwise ≈20 fps.
- **Strip card** (`#stripCard`, canvas `#stripCv`; `#ytStripCv` when full screen): shows the workout profile if a workout is running, else the route elevation profile (`rtElev`). Hidden in workout view.
- **Route module** (`const rt`, before `// ---------- Rendering`): `parseGpx` → `rtBuild` (resample 10–40 m, smooth elevation, gradient, colour runs, cumulative climb) → `rtTick` (progress = `session.distance`) → trainer grade: FTMS sim `[0x11, wind(2), grade int16 in 0.01%, crr 40, cw 51]` once a second / on change / every 5 s, only when a route is loaded, the ride is running and no ERG workout is active. Settings: Max grade (default 12%, downhill floor -6%), Hills strength (50/75/100%), Map On/Off (OpenStreetMap tiles, darkened with a canvas filter; attribution shown). Calculated speed adds the gradient term when a route is loaded.
- Routes persist in `data/routes.json` (store `routes`, up to 20, resampled points only). Last route restored via localStorage `freehub.rt.id`. Snapshot has `route` (companion shows a Route card) and `ver: 4`.
- Not tested on real hardware: Hub response to grade writes, OSM tiles from a real network, YouTube playback/fps in the embedded tile.

## Guided Strava setup + browser mode (latest)
- `public/webmode.js` loads first. It probes `api/info`; if a Freehub server answers, nothing changes. Otherwise (or with `?web` in the URL) it replaces `fetch('/api/…')` and `/auth/…` with a browser implementation: IndexedDB for stores/rides/tcx, localStorage `freehub.web.strava` for keys + tokens, direct calls to Strava (token exchange + upload). `EventSource` is stubbed (no phone companion). `window.FREEHUB_WEB` tells the page which mode it is in. Backup/restore via `window.freehubWeb`.
- Server: `POST /api/setup/strava` (localhost only, Origin-checked) writes `config.json` (mode 600) and updates keys live; `GET /api/setup/test`; `/api/status` now includes `clientId` (never the secret); serves `/webmode.js`.
- UI: Strava button opens the guided setup modal when unconfigured (right-click = change keys); "Data & help" button replaces "Phone app" in browser mode; amber banner if the browser has no Web Bluetooth; asset paths made relative so the site works from `/Freehub/`.
- Unverified: whether Strava's token and upload endpoints allow calls from a browser page (CORS). The setup modal's "Check keys" button reports this; if blocked, the upload error tells the rider to download the .tcx instead.
- `.github/workflows/pages.yml` publishes `public/` (minus companion.html) on push to main. Issue templates in `.github/ISSUE_TEMPLATE/`. Tester guide: `FRIENDS.md`.

## Fix 7: free ride is flat, routes only drive the trainer on purpose
- `rt.on` = a route is loaded (display only). `rt.ride` = this ride was STARTED from the Route tab; only then do grades go to the Hub, the speed model gets its gradient term, and the strip/companion show route data (`rtLive()`).
- `start()` sends `flatRide()` (request control + sim mode 0 % grade, crr 40, cw 51) unless an ERG workout is active, so the Hub never keeps a gradient from a previous ride. Finish (`openSummary`) and `resetAll` also send flat after a route ride. The 1 s grade loop is paused while the summary is open.
- A route loaded during a free ride shows "Free ride in progress: the route is not controlling your trainer".
- Upload error "Failed to fetch" now says Freehub can't reach its own server (restart `node server.js`). Server logs uncaught errors and keeps running.
- Strava on the website needs its own Strava app with callback domain `graemedoherty.github.io` (the desktop app uses `localhost`).

## Update 8
- Strava button: when keys are saved but not connected, it now opens the setup screen (showing the Strava app ID in use, with "Connect to Strava" and "Remove saved keys") instead of jumping straight to Strava. A wrong app or callback domain (`redirect_uri invalid`) can now be fixed in-app. Server and browser mode both accept `{clear:true}` on `POST /api/setup/strava`.
- Responsive: burger menu, phone bottom bar no longer overflows, route HUD scrolls on phones, toast and banner tidied, `--hdr` includes the browser warning.
- Companion: landscape phone shows all data fields on one screen.

## Update 9
- Link preview: Open Graph/Twitter tags and `public/images/share.png` (1200x630) so shared links show the logo. If the site URL changes, update the absolute URLs in the `og:` tags in `public/index.html`.
- Full-screen video on phones: the site header is hidden, the top bar scrolls sideways (URL box hidden in portrait), and the data panel is compact (a 3x2 strip at the bottom in portrait, a slim right column in landscape) so the video stays visible.

## Update 10
- Landscape phone, full-screen video: data now runs along the bottom as a single bar (Speed, Power, HR, Cadence, Time, Distance, plus Gradient on route rides); the workout/route profile strip sits just above it.
- Portrait phone, Video tab: skinny 16:9 player; stat tiles compact into a 3-column grid so all seven fit above the Start bar. `body[data-view]` now tracks the active main view (set in `setView`).

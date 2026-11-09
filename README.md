# Hub Rider — a minimal Zwift Hub app for macOS

Connects to a Zwift Hub over Bluetooth (standard FTMS), shows live power / cadence / speed / HR /
distance / time, records the ride and uploads it to Strava. No Zwift subscription needed.

## Requirements
- Node.js 18+ (`brew install node`)
- Google Chrome (Safari and Firefox don't support Web Bluetooth)
- Close Zwift/Companion app first — the Hub only accepts one connection at a time.

## Run
```bash
cd hub-rider
node server.js
```
Open http://localhost:3000 in Chrome → **Connect Zwift Hub** → **Start**.
A heart-rate strap can be paired separately with **Connect HR strap** (Zwift Hub has no HR sensor).

## Strava setup (one time, free)
1. Go to https://www.strava.com/settings/api and create an app.
   - Authorization Callback Domain: `localhost`
2. Create `config.json` next to `server.js`:
   ```json
   { "clientId": "12345", "clientSecret": "your_client_secret" }
   ```
3. Restart `node server.js`, click **Connect Strava**, approve.
4. After a ride: **Finish → Upload to Strava**. (Or **Download .tcx** and upload it manually.)

## Phone companion
Keep the dashboard tab open on your Mac and scan the QR code at the bottom of the dashboard with your phone camera
(the address is also printed in the terminal, e.g. `http://192.168.1.20:3000/companion`).
It must be on the same Wi-Fi. It mirrors the ride and can Start, Pause/Resume and Stop. After Stop you can
edit the Strava name, upload, resume or discard from the phone. Only the companion page and its control
endpoints are reachable from other devices; everything else (Strava, uploads) is Mac-only.

## Workouts (ERG mode)
Pick a workout in the Workout card and press **Start workout**. Targets are a percentage of your FTP (set it in the
panel below), the trainer holds each target power in ERG mode, and the app steps through the workout with beeps at each
change. You can **Skip step**, extend a step by a minute, or **End workout** (back to a flat free ride). The phone
companion shows the current target and has a Skip button. Included: ERG Check (10 min), Sweet Spot 3x8, 30/30 Intervals.
Pausing the ride pauses the workout clock. Workout names are used as the default Strava activity name.

## Session catalogue
The **Sessions** button (top left) opens your collection of workouts, with a small profile, length, IF and TSS for each.
**Use this session** loads it into the Workout card. **＋ New session** opens a builder: name it, add steps (minutes and
% of FTP, with optional ramps) or add a whole interval set in one go, and watch the profile update. Custom sessions are
saved in your browser (they stay after a refresh, but not across different browsers or computers). Built-in sessions can
be duplicated and edited as a custom copy.

## Ride image
After a ride is uploaded, the dialog shows a shareable image (ride name, stats, workout profile with your power over
it) with a **Download image** button. Strava's public API can't attach photos, so add it on Strava with **Add photo**.

## Connection buttons
The Connect buttons turn green ("✓ Zwift Hub linked" / "✓ HR strap linked") when paired. Click a linked button to disconnect.

## Extras
- Power-zone colouring (set your FTP).
- ERG target power and free-ride mode via FTMS control (if your Hub firmware accepts it).
- Normalised power, 3 s power, energy, rolling 5-minute chart.

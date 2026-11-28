# Swing Lab

A cricket ball swing simulator. Set the seam, the wear on each half of the ball, the weather and the pitch, and watch what the air does to the delivery.

## Run it

```
npm start
```

Then open http://localhost:5173. There is nothing to install or build: the site is plain static files, and the Three.js files it needs are checked in under `vendor/three` (version 0.170.0, MIT licence). To update them, bump `three` in `package.json`, run `npm install`, then `npm run vendor`. Space bowls the ball. Drag the view to look around; the camera buttons jump to fixed positions, and Ball cam follows the ball closely enough to watch the seam.

```
npm test
```

runs 38 checks: 28 of the physics engine against published behaviour of real cricket balls, and 10 of the visit-counting consent rules.

## How the physics works

`src/physics.js` is self-contained and has no browser dependencies.

**Air.** The ball surface is cut into 32 strips from the nose to the wake. On each strip the boundary layer starts laminar and becomes turbulent either because the leather is rough enough for the Reynolds number (fit to Achenbach's 1974 rough-sphere data) or because it crosses the seam fast enough for the stitches to trip it. A laminar layer separates near 82°. A turbulent one holds on to about 120°, less if it was tripped early, has run over scuffed leather, or was already turbulent when it met the seam. The pressure field those separation lines imply is integrated over the sphere to give drag and side force. Conventional, reverse and contrast swing all come out of that one calculation.

**Flight.** Rigid-body integration at 2 ms steps. Orientation follows the spin vector, so a seam that is not square to the spin axis wobbles and the forces follow it. Magnus lift uses Nathan's fit. Wind changes the airspeed and the angle the air meets the seam at.

**Pitch.** Incremental-impulse bounce with Coulomb friction, so a fast ball slides through contact and a slow one can grip and roll. When the seam is on the ground, friction across it is higher than along it, which produces seam movement.

**Weather.** Density from the moist-air gas law, viscosity from Sutherland's law, pressure from altitude. Humidity alone changes almost nothing, which matches wind-tunnel work. Cloud cover reduces small-scale turbulence in the air (the James, MacDonald and Hart 2012 hypothesis); the effect is kept small because it is not a measured coefficient.

### Calibration targets

| Behaviour | Target | Source |
|---|---|---|
| Peak side-force coefficient, new ball, 20° seam | about 0.3 near 108 km/h | Bentley et al. 1982, Mehta 2005 |
| New ball reverses | above roughly 140 km/h | Mehta 2005 |
| Reverse weaker than conventional in coefficient terms | about 0.1 to 0.2 | Mehta 2005, Scobie et al. 2013 |
| Contrast swing changes direction | near 115 to 125 km/h | Mehta 2005 |
| Drag coefficient | about 0.5 subcritical, 0.25 to 0.3 after the drag crisis | Achenbach 1974, Mehta 2005 |

### What it leaves out

- No batter.
- No aerodynamic torque on the seam: the wobble you set is the wobble you get.
- No moisture on the ball itself.
- The pitch sliders map onto bounce and friction by reasoned estimate, not by measurement of a particular ground.
- The model is calibrated to published wind-tunnel results, not fitted to ball-tracking data.

## Visit counting

The site can count visits and a little usage with Google Analytics 4. It is off until `MEASUREMENT_ID` in `src/analytics.js` is set to the `G-...` id of a GA4 web data stream; while that is empty nothing is loaded and no notice is shown.

- Visitors in the EU, the wider EEA, the UK and Switzerland (judged by browser time zone) are asked first, and nothing is requested from Google until they agree.
- Visitors elsewhere are counted straight away, told once, and can turn it off.
- A browser sending Global Privacy Control is treated as a no.
- The choice is remembered and can be changed from the "Visit counting" link under the controls.
- Advertising features are off in every case.

Two events are sent besides page views: `delivery_bowled` (with `speed_kmh` and `swing_type`) and `preset_loaded` (with `preset_name`). To see those details in GA4 reports, register them as event-scoped custom dimensions under Admin, Custom definitions.

## Files

- `src/physics.js` – atmosphere, strip aerodynamics, flight, bounce, aim solver
- `src/scene.js` – ground, sky, ball, cameras (Three.js)
- `src/ballTexture.js` – procedural leather, seam and wear
- `src/panels.js` – airflow diagram and side-force chart
- `src/main.js` – controls, presets, playback
- `src/analytics.js`, `src/consent.js` – visit counting and who is asked first
- `tests/physics.test.js`, `tests/consent.test.js` – physics and consent checks
- `serve.mjs` – static file server for local use
- `vendor/three` – the Three.js files the page loads

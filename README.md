# Swing Lab

A cricket ball swing simulator. Set the seam, the wear on each half of the ball, the weather and the pitch, and watch what the air does to the delivery.

## Run it

```
npm start
```

Then open http://localhost:5173. There is nothing to install or build: the site is plain static files, and the Three.js files it needs are checked in under `vendor/three` (version 0.170.0, MIT licence), and the player model under `assets/figure`. To update Three.js, bump `three` in `package.json`, run `npm install`, then `npm run vendor`. Space bowls the ball. Drag the view to look around; the camera buttons jump to fixed positions, and Ball cam follows the ball closely enough to watch the seam.

On a wide screen the controls sit in the corners of the play screen: the ball and its seam bottom left, the delivery bottom right, weather and pitch top right. The close-up of the ball is itself a control: drag it (or focus it and use the arrow keys) to turn the seam. Sideways sets the seam angle, and rolling it sets the tilt. Below 1360 px wide the same panels move into the left column so they do not cover the pitch.

```
npm test
```

runs 85 checks: 29 of the physics engine against published behaviour of real cricket balls, 26 of the batter, the laws and the over, 15 of how the players move, 4 of the player model file, 10 of the visit-counting consent rules, and one that the version shown under the title matches `package.json`.

Add `?gfx=high`, `?gfx=medium` or `?gfx=low` to the address to pin the graphics quality, which otherwise starts high and steps down by itself on a machine that cannot keep up. `?debug` puts the scene on `window.swinglab` for looking around from the console. `window.game` (`src/hook.js`) lets a script drive the game: `scene`, `state`, `press('Space')` to bowl, the arrow codes to turn the seam, and `step(n)` to run n sixtieths of a second. `?manual=1` stops the loop so only `step` moves it, and `?seed=7` fixes the challenge's dice for a repeatable run.

The version is written in two places, `package.json` and the `#version` label in `index.html`. Change both together.

## How the physics works

`src/physics.js` is self-contained and has no browser dependencies.

**Air.** The ball surface is cut into 32 strips from the nose to the wake. On each strip the boundary layer starts laminar and becomes turbulent either because the leather is rough enough for the Reynolds number (fit to Achenbach's 1974 rough-sphere data) or because it crosses the seam fast enough for the stitches to trip it. A laminar layer separates near 82°. A turbulent one holds on to about 120°, less if it was tripped early, has run over scuffed leather, or was already turbulent when it met the seam. The pressure field those separation lines imply is integrated over the sphere to give drag and side force. Conventional, reverse and contrast swing all come out of that one calculation.

**Flight.** Rigid-body integration at 2 ms steps. Orientation follows the spin vector, so a seam that is not square to the spin axis wobbles and the forces follow it. Magnus lift uses Nathan's fit. Wind changes the airspeed and the angle the air meets the seam at.

**Pitch.** Incremental-impulse bounce with Coulomb friction, so a fast ball slides through contact and a slow one can grip and roll. When the seam is on the ground, friction across it is higher than along it, which produces seam movement.

**Weather.** Density from the moist-air gas law, viscosity from Sutherland's law, pressure from altitude. Humidity alone changes almost nothing, which matches wind-tunnel work. Cloud cover reduces small-scale turbulence in the air (the James, MacDonald and Hart 2012 hypothesis); the effect is kept small because it is not a measured coefficient.

**Challenge mode.** One over against a batter of medium ability, in one of six match situations that fix the ball, pitch, weather and field. The batter (`src/batter.js`) reads the length, commits 0.22 s before contact, and expects the ball to carry on with part of the swing already seen and a plain bounce; the bat goes there, with a late adjustment that grows with the time the ball is in view after pitching, plus human error. The real ball then arrives where the physics puts it, and the gap decides middle, edge or miss. Bowled, caught and leg before wicket (Law 36) follow from the real trajectory. Runs off a clean hit and whether an edge is caught come from tables by stroke and field. Wides and no-balls use limited-overs interpretations. The bowler's own aim has scatter, in the angle of release, so a yorker is harder to land than a short ball.

**The players.** `src/pose.js` works out where every joint is, with no graphics involved. A pose is solved in priority order: the hands go where they are needed (on the bat handle, on the ball), the trunk leans and the hips shift until the shoulders can reach, and a foot is dragged in if a leg cannot. No bone ever changes length. On top of the solver sit the movements. The batter's strokes put the bat where the ball is. Anyone on foot is driven by a footstep model: feet land a little ahead of the hips at a steady beat and stay where they land until they push off, so nothing skates. The bowler runs in from a mark, leaps, lands back foot then front foot, and brings a straight arm over; the body is worked back from the hand, so the hand is on the ball's release point at the moment of release for any release height (a higher release is a taller bowler, a low one a rounder arm). Fielders walk in as the bowler runs up, settle, follow the ball with their eyes, and the nearest two chase a ball that has been hit. There is a non-striker who backs up, and two umpires.

`src/figures.js` puts a body on those joints. The body is the MakeHuman project's base mesh, shirt, trousers and trainers (all released CC0), shaped as a young man, with the clothes recoloured as whites. `tools/build_figure.py` builds `assets/figure` from MakeHuman's files: it fits the clothes, relaxes the hands, drops the skin the clothes hide, and ties every vertex to the solver's sixteen bones by adding up the weights MakeHuman gives its own finer skeleton. The solver's bone lengths in `src/pose.js` are that model's, and a test holds the two to each other. Helmet, caps, gloves, pads and bat are generated in code and ride on the bones.

**The light.** `src/scene.js` lights the ground the way daylight does. The sky is Preetham's scattering model (as in Three.js's `Sky`), with a layer of cloud; the same sky, blurred, is the fill light on everything. The sun's shadows are drawn as four cascades so that they are sharp near the camera and still reach the boundary. On machines that can afford it the frame is finished with ambient occlusion (shade where surfaces meet) and a little bloom. Cloud cover dims the sun and greys the sky; humidity thickens the haze. Turf is mown in bands that look pale brushed away from the eye and dark brushed toward it. None of this feeds back into the physics.

### Calibration targets

| Behaviour | Target | Source |
|---|---|---|
| Peak side-force coefficient, new ball, 20° seam | about 0.3 near 108 km/h | Bentley et al. 1982, Mehta 2005 |
| New ball reverses | above roughly 140 km/h | Mehta 2005 |
| Reverse weaker than conventional in coefficient terms | about 0.1 to 0.2 | Mehta 2005, Scobie et al. 2013 |
| Contrast swing changes direction | near 115 to 125 km/h | Mehta 2005 |
| Drag coefficient | about 0.5 subcritical, 0.25 to 0.3 after the drag crisis | Achenbach 1974, Mehta 2005 |

### What it leaves out

- No batter in free play. In challenge mode there is no running between the wickets (so no run-outs), and no byes or leg byes.
- The players' movements are worked out by formula, not motion-captured. Fingers do not move, cloth does not swing, and faces do not change. The fielders' chase is for show: who fields the ball and how many are run comes from the batter model's tables.
- Scoring off a clean hit, and catching, are probabilities, not simulation.
- No aerodynamic torque on the seam: the wobble you set is the wobble you get.
- No moisture on the ball itself.
- The pitch sliders map onto bounce and friction by reasoned estimate, not by measurement of a particular ground.
- The model is calibrated to published wind-tunnel results, not fitted to ball-tracking data.

## Visit counting

The site can count visits and a little usage with Google Analytics 4. It is off until `MEASUREMENT_ID` in `src/analytics.js` is set to the `G-...` id of a GA4 web data stream; while that is empty nothing is loaded and no notice is shown.

- Visitors in the EU, the wider EEA, the UK and Switzerland (judged by browser time zone) are asked first, and nothing is requested from Google until they agree.
- Visitors elsewhere are counted straight away, told once, and can turn it off.
- A browser sending Global Privacy Control is treated as a no.
- The choice is remembered and can be changed from the "Visit counting" link at the foot of the left-hand column.
- Advertising features are off in every case.

Four events are sent besides page views: `delivery_bowled` (with `speed_kmh` and `swing_type`), `preset_loaded` (with `preset_name`), `challenge_started` (with `challenge_name`) and `challenge_finished` (with `challenge_name`, `challenge_result` and `runs_conceded`). To see those details in GA4 reports, register them as event-scoped custom dimensions under Admin, Custom definitions.

## Files

- `src/physics.js` – atmosphere, strip aerodynamics, flight, bounce, aim solver
- `src/scene.js` – ground, sky, light and shadows, ball, cameras (Three.js)
- `src/ballTexture.js` – procedural leather, seam and wear
- `src/panels.js` – airflow diagram and side-force chart
- `src/main.js` – control panels, the draggable ball, presets, playback, challenge flow
- `src/batter.js` – the batter: reading the ball, choosing a stroke, what happens
- `src/challenge.js` – the scenarios, the over, the bowler's scatter
- `src/field.js` – fielders, and the ball's path after it reaches the batter
- `src/pose.js` – where every joint of a player is: the solver, footsteps, the strokes, the bowling action, the fielders
- `src/figures.js` – bodies and kit for everyone on the ground in the 3D view
- `assets/figure` – the player model: meshes, joints and textures (CC0, from MakeHuman)
- `tools/build_figure.py` – builds `assets/figure` from MakeHuman's files
- `tools/vendor.mjs` – copies the Three.js files the page loads into `vendor/three`
- `src/hook.js` – `window.game`, the hook scripted checks drive
- `src/analytics.js`, `src/consent.js` – visit counting and who is asked first
- `tests/physics.test.js`, `tests/challenge.test.js`, `tests/pose.test.js`, `tests/figure.test.js`, `tests/consent.test.js`, `tests/site.test.js` – physics, batter and rules, players' movement, the player model, consent and version checks
- `serve.mjs` – static file server for local use
- `vendor/three` – the Three.js files the page loads

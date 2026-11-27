// Swing Lab physics engine.
//
// Pure functions, SI units, no DOM. Runs in the browser and in Node (tests).
//
// Frame: x runs down the pitch from the bowler's stumps to the batter's stumps,
// z is up, y is to the bowler's left. For a right-handed batter +y is the off side.
//
// Model summary
// -------------
// Aerodynamics: a quasi-3D boundary-layer strip model. The ball surface is cut
// into meridian strips running from the front stagnation point to the wake. On
// each strip the boundary layer starts laminar and can become turbulent either
// naturally (surface roughness and Reynolds number; Achenbach 1974) or by being
// tripped by the seam (roughness Reynolds number of the stitches). A laminar
// layer separates near 82 deg; a turbulent one hangs on to ~120 deg, less if it
// was tripped early, has run over rough leather, or has been thickened by
// crossing the seam. The pressure field implied by those separation lines is
// integrated over the sphere to give drag and side force. Conventional swing,
// reverse swing and contrast swing all fall out of that one mechanism
// (Mehta 2005; Bentley et al. 1982; Scobie et al. 2013).
//
// Flight: rigid body. Orientation is integrated from the spin vector so a seam
// that is not aligned with the spin axis really does wobble, and the forces are
// recomputed from the instantaneous seam orientation every step.
//
// Impact: incremental-impulse rigid-sphere bounce with Coulomb friction that is
// anisotropic when the ball lands on its seam (the seam resists sliding across
// itself more than along itself), which produces seam movement.

export const BALL = {
  mass: 0.1595, // kg   (Law 4: 155.9 g to 163 g)
  radius: 0.03605, // m (Law 4: 22.4 cm to 22.9 cm circumference)
};
BALL.diameter = 2 * BALL.radius;
BALL.area = Math.PI * BALL.radius * BALL.radius;
BALL.inertia = 0.4 * BALL.mass * BALL.radius * BALL.radius;

export const PITCH = {
  length: 20.12, // m between the two sets of stumps (22 yards)
  crease: 1.22, // m, popping crease in front of each set of stumps
  halfWidth: 1.525, // m
  stumpHeight: 0.711, // m
  stumpsHalfWidth: 0.1143, // m (9 in overall)
  returnCrease: 1.32, // m from middle stump
};

const G = 9.80665;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

// ---------------------------------------------------------------- vector utils
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => {
  const l = len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// quaternion [w, x, y, z], body -> world
function quatFromBasis(X, Y, Z) {
  const m00 = X[0], m10 = X[1], m20 = X[2];
  const m01 = Y[0], m11 = Y[1], m21 = Y[2];
  const m02 = Z[0], m12 = Z[1], m22 = Z[2];
  const tr = m00 + m11 + m22;
  let w, x, y, z;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = s / 4; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s; x = s / 4; y = (m01 + m10) / s; z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s; x = (m01 + m10) / s; y = s / 4; z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = s / 4;
  }
  return [w, x, y, z];
}
function quatMul(a, b) {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}
function quatRotate(q, v) {
  const [w, x, y, z] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}
function quatIntegrate(q, w, dt) {
  const mag = len(w);
  const ang = mag * dt;
  if (ang < 1e-12) return q;
  const s = Math.sin(ang / 2) / mag;
  const dq = [Math.cos(ang / 2), w[0] * s, w[1] * s, w[2] * s];
  const r = quatMul(dq, q);
  const l = Math.hypot(r[0], r[1], r[2], r[3]);
  return [r[0] / l, r[1] / l, r[2] / l, r[3] / l];
}

// seeded random numbers so a delivery can be replayed exactly
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussian(rng) {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

// ------------------------------------------------------------------ atmosphere
// Moist-air density from the ideal gas law for the dry-air / water-vapour
// mixture; viscosity from Sutherland's law. Pressure from the ISA barometric
// formula for the ground's altitude.
export function airProperties({ tempC = 20, humidity = 50, altitude = 0 } = {}) {
  const T = tempC + 273.15;
  const p = 101325 * Math.pow(1 - 2.25577e-5 * altitude, 5.25588);
  const pSat = 610.94 * Math.exp((17.625 * tempC) / (tempC + 243.04));
  const pV = clamp(humidity, 0, 100) / 100 * pSat;
  const rho = (p - pV) / (287.058 * T) + pV / (461.495 * T);
  const mu = 1.716e-5 * Math.pow(T / 273.15, 1.5) * (273.15 + 110.4) / (T + 110.4);
  return { rho, mu, nu: mu / rho, pressure: p, vapourPressure: pV };
}

// Small-scale turbulence in the air the ball flies through. Sunshine on a warm
// outfield drives convective micro-turbulence; cloud cover suppresses it. This
// is the James, MacDonald & Hart (2012) explanation for why overcast days help
// swing: humidity itself barely matters, still air does. Treated as a modest
// effect because it is a hypothesis, not a measured coefficient.
export function turbulenceIntensity({ tempC = 20, cloud = 50, windKmh = 0 } = {}) {
  const sun = 1 - clamp(cloud, 0, 100) / 100;
  const heat = clamp((tempC - 8) / 24, 0, 1);
  const convective = 0.0019 * sun * (0.35 + 0.65 * heat);
  const mechanical = 0.00004 * clamp(windKmh / 3.6, 0, 14);
  return convective + mechanical;
}

export function makeEnvironment(weather = {}) {
  const air = airProperties(weather);
  const Tu = turbulenceIntensity(weather);
  const W = (weather.windKmh || 0) / 3.6;
  const dir = (weather.windDir || 0) * D2R;
  // windDir 0 = headwind (blowing from the batter toward the bowler),
  // 90 = blowing from the off side toward the leg side, 180 = tailwind.
  const wind = [-W * Math.cos(dir), -W * Math.sin(dir), 0];
  return { ...air, Tu, wind };
}

// ------------------------------------------------------------------------ ball
// Leather wear 0..1 maps to the critical Reynolds number of that hemisphere.
// 0 is a new lacquered ball: its bare leather goes turbulent on its own at
// about 137 km/h in still 18 C air. 1 is a badly scuffed 80-over ball that does
// so near 75 km/h. The equivalent sand-grain roughness follows from the fit to
// Achenbach's rough-sphere data, Re_crit ~ 6000 / sqrt(k/d).
const RE_CRIT_NEW = 1.82e5;
const RE_CRIT_WORN = 1.0e5;
export function criticalReynolds(wear) {
  const w = clamp(wear, 0, 1);
  return Math.exp(lerp(Math.log(RE_CRIT_NEW), Math.log(RE_CRIT_WORN), w));
}
export function relativeRoughness(wear) {
  const rc = criticalReynolds(wear);
  return (6000 / rc) ** 2;
}

export function makeBall({ wearOff = 0, wearLeg = 0, seamCondition = 100 } = {}) {
  const prom = clamp(seamCondition, 0, 100) / 100;
  return {
    // hemisphere A is the one the seam normal points into. With an upright
    // seam at release that is the off-side half; B is the leg-side half.
    reCritA: criticalReynolds(wearOff / 100),
    reCritB: criticalReynolds(wearLeg / 100),
    kdA: relativeRoughness(wearOff / 100),
    kdB: relativeRoughness(wearLeg / 100),
    seamProminence: prom,
    seamHeight: (0.25 + 0.6 * prom) * 1e-3, // m, stitches proud of the leather
  };
}

// ---------------------------------------------------------------- aerodynamics
const NPSI = 32; // meridian strips around the flight axis
const DTH = 2.5; // deg, step along a strip
const NTH = 50; // strip sampled to 125 deg
const TH = new Float64Array(NTH);
const SINT = new Float64Array(NTH);
const COST = new Float64Array(NTH);
const SIN4 = new Float64Array(NTH);
for (let i = 0; i < NTH; i++) {
  TH[i] = (i + 0.5) * DTH;
  SINT[i] = Math.sin(TH[i] * D2R);
  COST[i] = Math.cos(TH[i] * D2R);
  SIN4[i] = TH[i] >= 90 ? 1 : SINT[i] ** 4;
}
const CPSI = new Float64Array(NPSI);
const SPSI = new Float64Array(NPSI);
for (let j = 0; j < NPSI; j++) {
  const psi = (j * 2 * Math.PI) / NPSI;
  CPSI[j] = Math.cos(psi);
  SPSI[j] = Math.sin(psi);
}

export const AERO = {
  thetaLaminar: 82, // deg, laminar separation
  thetaTurbulent: 120, // deg, best-case turbulent separation
  thetaRef: 88, // deg, transition here costs nothing
  earlyPenalty: 0.12, // deg of separation lost per deg of early transition
  roughPenalty: 45, // deg lost per deg of turbulent run, per unit k/d
  critLoss: 2500, // deg lost per unit k/d when leather roughness itself causes transition
  tripPenalty: 16, // deg lost to the seam's own wake, scaled by local dynamic pressure
  fencePenalty: 10, // deg lost when a turbulent layer crosses a proud seam
  fenceCap: 1.6, // max multiple of fencePenalty for flow running along the seam
  seamBandInner: Math.sin(10 * D2R), // stitches: fully in the band
  seamBandOuter: Math.sin(16 * D2R), // outer stitch rows fade out
  tripLow: 300, // roughness Reynolds number where the seam starts to trip
  tripHigh: 1300, // ... and where it trips reliably
  natLow: 0.84, // Re/Re_crit where natural transition starts to appear
  natHigh: 1.16, // ... and where it is complete
  turbulenceGain: 60, // critical-Re sensitivity to free-stream turbulence
  kappaLaminar: 1.75, // suction strength, Cp = 1 - kappa sin^2(theta)
  kappaTurbulent: 2.2,
  cpBaseLaminar: -0.36, // wake pressure, subcritical
  cpBaseTurbulent: -0.14, // wake pressure, supercritical
  frictionDrag: 0.012,
  sideGain: 1.15, // calibration to measured peak side-force coefficient (~0.3)
};

// Turbulent separation angle for a layer that became turbulent at thetaT on
// the strip described by kd[] (leather roughness) and ws[] (seam weight).
function turbulentSeparation(thetaT, kd, ws, fence, prom) {
  let pen = AERO.earlyPenalty * Math.max(0, AERO.thetaRef - thetaT);
  // A seam that trips the layer also leaves a momentum deficit behind it. That
  // deficit grows with the local dynamic pressure (sin^2 theta), so a trip far
  // round the ball, close to the adverse pressure gradient, costs the most.
  if (!fence) pen += AERO.tripPenalty * prom * Math.sin(thetaT * D2R) ** 2;
  // Rougher leather goes turbulent sooner but with a thicker layer: Achenbach's
  // rough spheres never reach the low drag of a smooth one after the crisis.
  else pen += AERO.critLoss * kd[Math.min(NTH - 1, Math.max(0, Math.round(thetaT / DTH - 0.5)))];
  const fenceRate = (AERO.fencePenalty * prom) / 26; // band is ~26 deg wide
  const fenceMax = AERO.fenceCap * AERO.fencePenalty * prom;
  let fenceAcc = 0;
  let prevTheta = thetaT;
  let prevG = thetaT + pen - AERO.thetaTurbulent;
  let i = Math.max(0, Math.ceil(thetaT / DTH - 0.5));
  if (TH[i] <= thetaT) i++;
  for (; i < NTH; i++) {
    const seg = TH[i] - prevTheta;
    pen += seg * AERO.roughPenalty * kd[i];
    if (fence && fenceAcc < fenceMax) {
      const a = Math.min(seg * fenceRate * ws[i], fenceMax - fenceAcc);
      fenceAcc += a;
      pen += a;
    }
    const g = TH[i] + pen - AERO.thetaTurbulent;
    if (g >= 0) return prevTheta + (seg * -prevG) / (g - prevG);
    prevTheta = TH[i];
    prevG = g;
  }
  return TH[NTH - 1];
}

const _ws = new Float64Array(NTH);
const _kd = new Float64Array(NTH);
const _X = new Float64Array(NTH);
const _T = new Float64Array(NTH);
// per-strip scenario storage: up to 3 outcomes (seam-tripped, natural, laminar)
const _scP = new Float64Array(NPSI * 3);
const _scTh = new Float64Array(NPSI * 3);

/**
 * Aerodynamic coefficients for the ball moving through the air along unit
 * vector f with seam-plane normal n (both in world axes) at airspeed U.
 * Returns the drag coefficient and the side-force coefficient vector (world
 * axes, perpendicular to f), both referred to the frontal area.
 */
export function aeroCoefficients(env, ball, f, n, U, wantDetail = false) {
  const Re = (U * BALL.diameter) / env.nu;
  const ReEff = Re * (1 + AERO.turbulenceGain * env.Tu);
  const rA = ReEff / ball.reCritA;
  const rB = ReEff / ball.reCritB;
  const rek0 = (1.5 * U * ball.seamHeight) / env.nu;
  const prom = ball.seamProminence;

  // lateral basis: a is horizontal and to the left of the motion, b completes it
  let a = cross([0, 0, 1], f);
  if (len(a) < 1e-6) a = [0, 1, 0];
  a = norm(a);
  const b = cross(f, a);
  const fn = dot(f, n), an = dot(a, n), bn = dot(b, n);

  let sumTheta = 0;
  const detail = wantDetail
    ? { sep: new Float64Array(NPSI), turb: new Float64Array(NPSI), trans: new Float64Array(NPSI) }
    : null;

  for (let j = 0; j < NPSI; j++) {
    const en = CPSI[j] * an + SPSI[j] * bn;
    let xMax = 0, tMax = 0;
    for (let i = 0; i < NTH; i++) {
      const s = COST[i] * fn + SINT[i] * en; // sine of latitude from the seam plane
      const w = 1 - smoothstep(AERO.seamBandInner, AERO.seamBandOuter, Math.abs(s));
      const h = smoothstep(-0.06, 0.06, s);
      _ws[i] = w;
      _kd[i] = ball.kdB + (ball.kdA - ball.kdB) * h;
      const x = TH[i] <= 95 ? (rB + (rA - rB) * h) * SIN4[i] : 0;
      const t = TH[i] <= 85 ? w * rek0 * SINT[i] : 0;
      _X[i] = x;
      _T[i] = t;
      if (x > xMax) xMax = x;
      if (t > tMax) tMax = t;
    }

    // natural (roughness / Reynolds number) transition
    const eNat = smoothstep(AERO.natLow, AERO.natHigh, xMax);
    let thNat = 90;
    if (eNat > 0) {
      const thr = Math.min(1, xMax * 0.999);
      for (let i = 0; i < NTH; i++) {
        if (_X[i] >= thr) {
          thNat = i === 0 ? TH[0] : TH[i - 1] + (DTH * (thr - _X[i - 1])) / (_X[i] - _X[i - 1]);
          break;
        }
      }
    }
    // seam trip
    const eSeam = smoothstep(AERO.tripLow, AERO.tripHigh, tMax);
    let thSeam = 200;
    if (eSeam > 0) {
      const thr = Math.min(0.5 * (AERO.tripLow + AERO.tripHigh), tMax * 0.98);
      for (let i = 0; i < NTH; i++) {
        if (_T[i] >= thr) {
          thSeam = i === 0 ? TH[0] : TH[i - 1] + (DTH * (thr - _T[i - 1])) / (_T[i] - _T[i - 1]);
          break;
        }
      }
    }

    let pSeam, pNat;
    if (thSeam <= thNat) {
      pSeam = eSeam;
      pNat = (1 - eSeam) * eNat;
    } else {
      pNat = eNat;
      pSeam = (1 - eNat) * eSeam;
    }
    const pLam = 1 - pSeam - pNat;
    const thA = pSeam > 1e-6 ? turbulentSeparation(thSeam, _kd, _ws, false, prom) : 0;
    const thB = pNat > 1e-6 ? turbulentSeparation(thNat, _kd, _ws, true, prom) : 0;
    const k = j * 3;
    _scP[k] = pSeam; _scTh[k] = thA;
    _scP[k + 1] = pNat; _scTh[k + 1] = thB;
    _scP[k + 2] = pLam; _scTh[k + 2] = AERO.thetaLaminar;
    const mean = pSeam * thA + pNat * thB + pLam * AERO.thetaLaminar;
    sumTheta += mean;
    if (detail) {
      detail.sep[j] = mean;
      detail.turb[j] = pSeam + pNat;
      detail.trans[j] = pSeam + pNat > 1e-6 ? (pSeam * thSeam + pNat * thNat) / (pSeam + pNat) : NaN;
    }
  }

  // wake (base) pressure follows the mean separation line
  const span = AERO.thetaTurbulent - AERO.thetaLaminar;
  const meanTheta = sumTheta / NPSI;
  const cpB = lerp(AERO.cpBaseLaminar, AERO.cpBaseTurbulent, clamp((meanTheta - AERO.thetaLaminar) / span, 0, 1));

  let cd = 0, ca = 0, cb = 0;
  const dpsi = (2 * Math.PI) / NPSI;
  for (let j = 0; j < NPSI; j++) {
    let ix = 0, id = 0;
    for (let s = 0; s < 3; s++) {
      const p = _scP[j * 3 + s];
      if (p <= 1e-6) continue;
      const thDeg = _scTh[j * 3 + s];
      const th = thDeg * D2R;
      const kappa = lerp(AERO.kappaLaminar, AERO.kappaTurbulent, clamp((thDeg - AERO.thetaLaminar) / span, 0, 1));
      const s1 = Math.sin(th), s2 = Math.sin(2 * th), s4 = Math.sin(4 * th);
      const sq = s1 * s1;
      // integrals of Cp sin(theta) cos(theta) and Cp sin^2(theta) over the strip
      ix += p * ((sq / 2) * (1 - cpB) - (kappa * sq * sq) / 4);
      id += p * (th / 2 - s2 / 4 - kappa * ((3 * th) / 8 - s2 / 4 + s4 / 32) + cpB * ((Math.PI - th) / 2 + s2 / 4));
    }
    cd += (dpsi / Math.PI) * ix;
    ca -= (dpsi / Math.PI) * id * CPSI[j];
    cb -= (dpsi / Math.PI) * id * SPSI[j];
  }
  ca *= AERO.sideGain;
  cb *= AERO.sideGain;
  const out = {
    cd: cd + AERO.frictionDrag,
    side: [ca * a[0] + cb * b[0], ca * a[1] + cb * b[1], ca * a[2] + cb * b[2]],
    sideLeft: ca, // component toward the left of the motion (+y for a ball going down the pitch)
    sideUp: cb,
    Re,
    meanSeparation: meanTheta,
  };
  if (detail) {
    out.detail = detail;
    out.basis = { a, b };
  }
  return out;
}

// Magnus lift coefficient vs spin parameter S = R*omega/U (Nathan 2008 fit to
// sphere and baseball data, valid for S below about 0.4).
export function magnusCoefficient(S) {
  return S > 1e-5 ? 1 / (2.32 + 0.4 / S) : 0;
}

// ----------------------------------------------------------------------- pitch
export function makePitch({ hardness = 70, grass = 30, moisture = 15, wear = 15 } = {}) {
  const H = clamp(hardness, 0, 100) / 100;
  const Gr = clamp(grass, 0, 100) / 100;
  const M = clamp(moisture, 0, 100) / 100;
  const W = clamp(wear, 0, 100) / 100;
  return {
    restitution: clamp(0.45 + 0.19 * H - 0.09 * M, 0.3, 0.68), // at 6 m/s normal speed
    friction: clamp(0.3 + 0.2 * W + 0.12 * M - 0.04 * Gr + 0.03 * (1 - H), 0.2, 0.7),
    seamGrip: 0.03 + 0.2 * Gr + 0.06 * M + 0.05 * W,
    deviationSigma: (0.08 + 1.1 * W) * D2R, // random sideways kick off cracks
    restitutionSigma: 0.008 + 0.07 * W, // uneven bounce
  };
}

// Rigid-sphere impact with the pitch. The normal impulse is fed in small
// increments; each increment applies Coulomb friction against the current slip
// of the contact point, so the ball can slide throughout (fast bowling) or
// bite and start rolling (slow, steep deliveries). If the seam is on the
// ground, friction across the seam is higher than along it.
function bounce(v, w, n, pitch, ball, rng) {
  const m = BALL.mass, R = BALL.radius, I = BALL.inertia;
  const vn = -v[2];
  let e = pitch.restitution - 0.012 * (vn - 6);
  let mu = pitch.friction;
  let kick = 0;
  if (rng) {
    e += pitch.restitutionSigma * gaussian(rng);
    mu *= 1 + 0.6 * pitch.restitutionSigma * gaussian(rng);
    kick = pitch.deviationSigma * gaussian(rng);
  }
  e = clamp(e, 0.2, 0.78);
  mu = clamp(mu, 0.1, 0.9);

  // seam contact: 1 when the seam band is on the ground
  let wc = 0, t = [1, 0, 0], c = [0, 1, 0];
  if (n) {
    const beta = Math.asin(clamp(Math.abs(n[2]), 0, 1)) * R2D;
    wc = 1 - smoothstep(12, 24, beta);
    const tt = cross([0, 0, 1], n);
    if (len(tt) > 1e-6) {
      t = norm(tt);
      c = cross([0, 0, 1], t);
    } else wc = 0;
  }
  const prom = ball ? ball.seamProminence : 0;
  const muT = mu * (1 + 0.12 * wc * prom);
  const muC = muT + wc * prom * pitch.seamGrip;

  const vx0 = v[0], vy0 = v[1];
  let vx = v[0], vy = v[1];
  let wx = w[0], wy = w[1];
  const steps = 60;
  const dJn = (m * (1 + e) * vn) / steps;
  const k = 1 / m + (R * R) / I;
  let gripped = false;
  for (let s = 0; s < steps; s++) {
    const ux = vx - R * wy, uy = vy + R * wx; // contact-point slip
    const sp = Math.hypot(ux, uy);
    if (sp < 1e-6) { gripped = true; break; }
    const hx = ux / sp, hy = uy / sp;
    const ut = hx * t[0] + hy * t[1];
    const uc = hx * c[0] + hy * c[1];
    let jx = -dJn * (muT * ut * t[0] + muC * uc * c[0]);
    let jy = -dJn * (muT * ut * t[1] + muC * uc * c[1]);
    // do not let friction reverse the slip within one increment
    const along = -(jx * hx + jy * hy) * k;
    if (along > sp) {
      jx = -ux / k; jy = -uy / k;
      gripped = true;
    }
    vx += jx / m; vy += jy / m;
    wx += (R * jy) / I; wy += (-R * jx) / I;
    if (gripped) break;
  }
  if (kick) {
    const cs = Math.cos(kick), sn = Math.sin(kick);
    const nx = vx * cs - vy * sn, ny = vx * sn + vy * cs;
    vx = nx; vy = ny;
  }
  return {
    v: [vx, vy, e * vn],
    w: [wx, wy, w[2]],
    restitution: e,
    friction: mu,
    seamContact: wc,
    gripped,
    headingBefore: Math.atan2(vy0, vx0),
    headingAfter: Math.atan2(vy, vx),
  };
}

// --------------------------------------------------------------------- release
function directionFrom(elev, azim) {
  return [Math.cos(elev) * Math.cos(azim), Math.cos(elev) * Math.sin(azim), Math.sin(elev)];
}

// Seam and spin geometry at release. Angles in degrees.
//   angle  : seam yaw from the flight line, + toward the off side (+y)
//   tilt   : seam lean, + means the top of the seam leans toward the off side
//   wobble : misalignment between the spin axis and the seam normal
//   spin   : backspin, rev/s
function releaseOrientation(azim, seam) {
  const yaw = azim + (seam.angle || 0) * D2R;
  const tilt = (seam.tilt || 0) * D2R;
  const wob = (seam.wobble || 0) * D2R;
  const s = [Math.cos(yaw), Math.sin(yaw), 0];
  const nh = [-Math.sin(yaw), Math.cos(yaw), 0];
  const nNom = [nh[0] * Math.cos(tilt), nh[1] * Math.cos(tilt), -Math.sin(tilt)];
  const up = cross(s, nNom);
  // spin axis is the nominal seam normal; backspin makes the top of the ball move backward
  const omega = scale(nNom, -(seam.spin || 0) * 2 * Math.PI);
  const n0 = norm(sub(scale(nNom, Math.cos(wob)), scale(s, Math.sin(wob))));
  const X = norm(cross(n0, up));
  const q = quatFromBasis(X, n0, up);
  return { q, omega };
}

const DT = 0.002;
const X_END = PITCH.length + 2.2;

// One flight. mode.side === false gives the reference delivery: same drag and
// lift, but no sideways aerodynamic force and a plain bounce.
function fly(init, env, ball, pitch, mode) {
  const { side = true, record = true, stopAtBounce = false, seed = 1 } = mode;
  const rng = side ? mulberry32(seed) : null;
  let p = init.p.slice(), v = init.v.slice(), q = init.q.slice(), w = init.omega.slice();
  let t = 0;
  const kq = (0.5 * env.rho * BALL.area) / BALL.mass;
  const samples = [];
  const bounces = [];
  let stumps = null, crease = null;
  let hitStumps = false;
  const R = BALL.radius;

  const accel = (vel, C) => {
    const rx = vel[0] - env.wind[0], ry = vel[1] - env.wind[1], rz = vel[2] - env.wind[2];
    const u2 = rx * rx + ry * ry + rz * rz;
    return [kq * u2 * C[0], kq * u2 * C[1], kq * u2 * C[2] - G];
  };

  for (let step = 0; step < 4000; step++) {
    const n = quatRotate(q, [0, 1, 0]);
    const vr = sub(v, env.wind);
    const U = len(vr);
    const f = scale(vr, 1 / U);
    const ac = aeroCoefficients(env, ball, f, n, U);
    // Magnus lift from the spin component perpendicular to the flight line
    const wxf = cross(w, f);
    const wPerp = len(wxf);
    const S = (R * wPerp) / U;
    const cl = magnusCoefficient(S);
    let lift = wPerp > 1e-9 ? scale(wxf, cl / wPerp) : [0, 0, 0];
    let sideC = ac.side;
    if (!side) {
      sideC = [0, 0, 0];
      const h = norm(cross([0, 0, 1], f));
      lift = sub(lift, scale(h, dot(lift, h)));
    }
    const C = [
      -ac.cd * f[0] + sideC[0] + lift[0],
      -ac.cd * f[1] + sideC[1] + lift[1],
      -ac.cd * f[2] + sideC[2] + lift[2],
    ];
    if (record) {
      samples.push({
        t, p: p.slice(), v: v.slice(), q: q.slice(),
        speed: len(v), airspeed: U, cd: ac.cd, cs: ac.sideLeft, csUp: ac.sideUp,
        cl, Re: ac.Re, spin: len(w) / (2 * Math.PI),
      });
    }
    // midpoint step with the coefficients frozen over the step
    const a1 = accel(v, C);
    const vm = [v[0] + 0.5 * DT * a1[0], v[1] + 0.5 * DT * a1[1], v[2] + 0.5 * DT * a1[2]];
    const a2 = accel(vm, C);
    let pn = [p[0] + DT * vm[0], p[1] + DT * vm[1], p[2] + DT * vm[2]];
    let vn = [v[0] + DT * a2[0], v[1] + DT * a2[1], v[2] + DT * a2[2]];
    let qn = quatIntegrate(q, w, DT);

    // plane crossings (popping crease, stumps) by linear interpolation
    const crossing = (xPlane) => {
      if (p[0] < xPlane && pn[0] >= xPlane) {
        const s = (xPlane - p[0]) / (pn[0] - p[0]);
        return {
          t: t + s * DT,
          y: lerp(p[1], pn[1], s), z: lerp(p[2], pn[2], s),
          v: [lerp(v[0], vn[0], s), lerp(v[1], vn[1], s), lerp(v[2], vn[2], s)],
          frac: s,
        };
      }
      return null;
    };

    // ground contact inside this step
    if (pn[2] < R && vn[2] < 0 && p[2] >= R - 1e-9) {
      const s = clamp((p[2] - R) / (p[2] - pn[2]), 0, 1);
      const pc = [lerp(p[0], pn[0], s), lerp(p[1], pn[1], s), R];
      const vc = [lerp(v[0], vn[0], s), lerp(v[1], vn[1], s), lerp(v[2], vn[2], s)];
      const qc = quatIntegrate(q, w, s * DT);
      const tc = t + s * DT;
      const nC = quatRotate(qc, [0, 1, 0]);
      const b = bounce(vc, w, side ? nC : null, pitch, side ? ball : null, rng);
      const ev = {
        t: tc, p: pc, vIn: vc, vOut: b.v.slice(), index: samples.length,
        speedIn: len(vc), speedOut: len(b.v),
        deviation: b.headingAfter - b.headingBefore,
        seamContact: b.seamContact, restitution: b.restitution, friction: b.friction,
        angleIn: Math.atan2(-vc[2], Math.hypot(vc[0], vc[1])),
      };
      bounces.push(ev);
      if (record) {
        samples.push({
          t: tc, p: pc.slice(), v: vc.slice(), q: qc.slice(), speed: len(vc), airspeed: U,
          cd: ac.cd, cs: ac.sideLeft, csUp: ac.sideUp, cl, Re: ac.Re, spin: len(w) / (2 * Math.PI), bounce: true,
        });
      }
      if (stopAtBounce) return { samples, bounces };
      w = b.w;
      const rest = (1 - s) * DT;
      vn = [b.v[0], b.v[1], b.v[2] - G * rest];
      pn = [pc[0] + b.v[0] * rest, pc[1] + b.v[1] * rest, Math.max(R, pc[2] + b.v[2] * rest)];
      qn = quatIntegrate(qc, w, rest);
      // crossings during the remainder of this step are rare enough to skip
    } else {
      if (!crease) {
        const c = crossing(PITCH.length - PITCH.crease);
        if (c) crease = c;
      }
      if (!stumps) {
        const c = crossing(PITCH.length);
        if (c) {
          stumps = c;
          const inLine = Math.abs(c.y) <= PITCH.stumpsHalfWidth + 0.85 * R;
          const inHeight = c.z <= PITCH.stumpHeight + 0.012 + 0.7 * R;
          if (inLine && inHeight) {
            hitStumps = true;
            if (record) {
              samples.push({
                t: c.t, p: [PITCH.length, c.y, c.z], v: c.v, q: qn.slice(), speed: len(c.v), airspeed: U,
                cd: ac.cd, cs: ac.sideLeft, csUp: ac.sideUp, cl, Re: ac.Re, spin: len(w) / (2 * Math.PI),
              });
            }
            break;
          }
        }
      }
    }
    p = pn; v = vn; q = qn;
    t += DT;
    if (p[0] > X_END || t > 4 || bounces.length >= 4 || len(v) < 1 || Math.abs(p[1]) > 12) {
      if (record) {
        samples.push({
          t, p: p.slice(), v: v.slice(), q: q.slice(), speed: len(v), airspeed: len(sub(v, env.wind)),
          cd: ac.cd, cs: ac.sideLeft, csUp: ac.sideUp, cl, Re: ac.Re, spin: len(w) / (2 * Math.PI),
        });
      }
      break;
    }
  }
  return { samples, bounces, stumps, crease, hitStumps };
}

// Find the launch direction that makes the reference delivery (no sideways
// aerodynamic force) pitch on the requested line and length. That is the
// bowler's aim; everything the real delivery does differently is movement.
function solveAim(cfg, env, ball, pitch) {
  const d = cfg.delivery;
  const speed = d.speedKmh / 3.6;
  const p0 = [PITCH.crease, d.releaseY, d.releaseHeight];
  const target = [PITCH.length - d.length, d.line / 100];
  const dx = target[0] - p0[0];
  const tFlat = dx / speed;
  let elev = Math.atan2(-(p0[2] - BALL.radius) + 0.5 * G * tFlat * tFlat, dx);
  let azim = Math.atan2(target[1] - p0[1], dx);
  const land = (el, az) => {
    const o = releaseOrientation(az, cfg.seam);
    const r = fly({ p: p0, v: scale(directionFrom(el, az), speed), q: o.q, omega: o.omega }, env, ball, pitch,
      { side: false, record: false, stopAtBounce: true });
    return r.bounces.length ? r.bounces[0].p : null;
  };
  let prevEl = null, prevX = null;
  for (let it = 0; it < 12; it++) {
    const b = land(elev, azim);
    if (!b) { elev -= 0.02; continue; }
    const ex = b[0] - target[0];
    const ey = b[1] - target[1];
    if (Math.abs(ex) < 0.002 && Math.abs(ey) < 0.001) break;
    azim -= Math.atan2(ey, b[0] - p0[0]);
    let slope;
    if (prevEl !== null && Math.abs(elev - prevEl) > 1e-7 && Math.abs(b[0] - prevX) > 1e-6) {
      slope = (b[0] - prevX) / (elev - prevEl);
    } else {
      // landing distance per radian of elevation, from the descent geometry
      const range = b[0] - p0[0];
      slope = (range * range) / Math.max(0.3, p0[2]);
    }
    prevEl = elev; prevX = b[0];
    elev -= clamp(ex / slope, -0.05, 0.05);
  }
  return { p0, elev, azim, speed, target };
}

function interpAtX(samples, x) {
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    if (a.p[0] <= x && b.p[0] >= x && b.p[0] > a.p[0]) {
      const s = (x - a.p[0]) / (b.p[0] - a.p[0]);
      return {
        y: lerp(a.p[1], b.p[1], s), z: lerp(a.p[2], b.p[2], s),
        heading: Math.atan2(lerp(a.v[1], b.v[1], s), lerp(a.v[0], b.v[0], s)),
        t: lerp(a.t, b.t, s),
      };
    }
  }
  return null;
}

export function lengthName(metres) {
  if (metres < 0) return 'Full toss';
  if (metres < 2.5) return 'Yorker';
  if (metres < 6) return 'Full';
  if (metres < 8) return 'Good length';
  if (metres < 10) return 'Back of a length';
  return 'Short';
}

/**
 * Simulate one delivery. Returns the recorded flight, the reference flight
 * with no sideways movement, and summary measurements.
 */
export function simulate(cfg) {
  const env = makeEnvironment(cfg.weather);
  const ball = makeBall({ ...cfg.ball, seamCondition: cfg.seam.condition });
  const pitch = makePitch(cfg.pitch);
  const aim = solveAim(cfg, env, ball, pitch);
  const o = releaseOrientation(aim.azim, cfg.seam);
  const init = { p: aim.p0, v: scale(directionFrom(aim.elev, aim.azim), aim.speed), q: o.q, omega: o.omega };
  const main = fly(init, env, ball, pitch, { side: true, seed: cfg.seed ?? 1 });
  const ref = fly(init, env, ball, pitch, { side: false });

  const b = main.bounces[0] || null;
  const pitchedBeforeStumps = b && b.p[0] < PITCH.length;
  const xSwing = pitchedBeforeStumps ? b.p[0] : PITCH.length;
  const refAt = interpAtX(ref.samples, xSwing - 1e-6);
  const mainAt = pitchedBeforeStumps
    ? { y: b.p[1], heading: Math.atan2(b.vIn[1], b.vIn[0]) }
    : interpAtX(main.samples, xSwing - 1e-6);
  const swing = mainAt && refAt ? mainAt.y - refAt.y : 0;
  const swingAngle = mainAt && refAt ? (mainAt.heading - refAt.heading) * R2D : 0;
  const refStumps = ref.stumps;
  const s = main.stumps;

  const metrics = {
    releaseSpeed: aim.speed * 3.6,
    releaseElevation: aim.elev * R2D,
    releaseAzimuth: aim.azim * R2D,
    swing, // m, sideways movement in the air up to pitching (+ toward off)
    swingAngle, // deg, change of heading in the air
    pitched: pitchedBeforeStumps
      ? {
          length: PITCH.length - b.p[0], line: b.p[1], name: lengthName(PITCH.length - b.p[0]),
          speedIn: b.speedIn * 3.6, speedOut: b.speedOut * 3.6,
          deviation: b.deviation * R2D, seamContact: b.seamContact,
          restitution: b.restitution, friction: b.friction, angleIn: b.angleIn * R2D, t: b.t,
        }
      : null,
    atStumps: s ? { y: s.y, z: s.z, speed: len(s.v) * 3.6, t: s.t } : null,
    atCrease: main.crease ? { y: main.crease.y, z: main.crease.z, speed: len(main.crease.v) * 3.6, t: main.crease.t } : null,
    totalMovement: s && refStumps ? s.y - refStumps.y : null,
    hitStumps: main.hitStumps,
    flightTime: main.samples.length ? main.samples[main.samples.length - 1].t : 0,
    air: { rho: env.rho, nu: env.nu, Tu: env.Tu },
    pitch,
    ball,
  };
  return { main, ref, metrics, env, ball, pitch, aim, init };
}

/**
 * Side-force coefficient (positive toward the off side) and drag coefficient
 * as a function of speed for the current ball, seam and air, averaged over one
 * revolution of the ball so a wobbling seam is represented fairly.
 */
export function swingCurve(cfg, speedsKmh) {
  const env = makeEnvironment(cfg.weather);
  const ball = makeBall({ ...cfg.ball, seamCondition: cfg.seam.condition });
  const o = releaseOrientation(0, cfg.seam);
  const f = [1, 0, 0];
  const phases = (cfg.seam.wobble || 0) > 0.5 && (cfg.seam.spin || 0) > 0.1 ? 16 : 1;
  const wmag = len(o.omega);
  const out = [];
  for (const kmh of speedsKmh) {
    const U = kmh / 3.6;
    let cs = 0, cd = 0;
    for (let k = 0; k < phases; k++) {
      const q = phases > 1 ? quatIntegrate(o.q, o.omega, ((2 * Math.PI) / wmag) * (k / phases)) : o.q;
      const n = quatRotate(q, [0, 1, 0]);
      const a = aeroCoefficients(env, ball, f, n, U);
      cs += a.sideLeft;
      cd += a.cd;
    }
    out.push({ kmh, cs: cs / phases, cd: cd / phases });
  }
  return out;
}

/**
 * Boundary-layer picture in the horizontal plane through the ball for one
 * instant: where each side's layer turns turbulent and where it separates.
 */
export function flowSnapshot(cfg, sample) {
  const env = makeEnvironment(cfg.weather);
  const ball = makeBall({ ...cfg.ball, seamCondition: cfg.seam.condition });
  const vr = sub(sample.v, env.wind);
  const U = len(vr);
  const f = scale(vr, 1 / U);
  const n = quatRotate(sample.q, [0, 1, 0]);
  const a = aeroCoefficients(env, ball, f, n, U, true);
  const half = NPSI / 2;
  const d = a.detail;
  return {
    U, Re: a.Re, cd: a.cd, cs: a.sideLeft, csUp: a.sideUp,
    seamNormal: n, flight: f, basis: a.basis,
    // seam yaw as seen from above: + means the seam points toward the off side
    seamYaw: Math.atan2(-dot(n, f), dot(n, a.basis.a)) * R2D,
    left: { sep: d.sep[0], turb: d.turb[0], trans: d.trans[0] }, // off side
    right: { sep: d.sep[half], turb: d.turb[half], trans: d.trans[half] }, // leg side
    criticalSpeedOff: (ball.reCritA * env.nu) / BALL.diameter / (1 + AERO.turbulenceGain * env.Tu),
    criticalSpeedLeg: (ball.reCritB * env.nu) / BALL.diameter / (1 + AERO.turbulenceGain * env.Tu),
  };
}

export const DEFAULTS = {
  delivery: { speedKmh: 132, length: 6.5, line: 20, releaseHeight: 2.15, releaseY: 0.45 },
  seam: { angle: 20, tilt: 0, spin: 12, wobble: 0, condition: 100 },
  ball: { wearOff: 0, wearLeg: 0 },
  weather: { tempC: 18, humidity: 70, altitude: 50, cloud: 80, windKmh: 0, windDir: 0 },
  pitch: { hardness: 70, grass: 35, moisture: 15, wear: 10 },
  seed: 1,
};

export const _internal = { bounce, releaseOrientation, quatRotate, quatIntegrate, fly, solveAim, NPSI };

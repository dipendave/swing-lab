// Challenge mode rules: the scenarios, the over, and who won. Pure logic.
import { DEFAULTS, PITCH } from './physics.js';

/**
 * Each scenario fixes what a bowler cannot choose: the ball, the pitch, the
 * weather, the field and the match situation.
 *   goal 'chase'   the batting side needs `need` runs from the over
 *   goal 'wicket'  the batting side only has to survive; one wicket wins it
 */
export const SCENARIOS = [
  {
    id: 'last-over',
    title: 'Eight off the last over',
    story: 'The final of a twenty-over competition. They need eight to win and have three wickets in hand.',
    goal: 'chase', need: 8, wickets: 3, field: 'spread',
    ballAge: '19 overs old, one side still shiny', pitchNote: 'Flat and true', skyNote: 'Humid evening',
    ball: { wearOff: 40, wearLeg: 15 }, seamCondition: 70,
    pitch: { hardness: 80, grass: 8, moisture: 5, wear: 15 },
    weather: { tempC: 28, humidity: 75, altitude: 10, cloud: 40, windKmh: 6, windDir: 90 },
  },
  {
    id: 'save-the-test',
    title: 'One wicket to win the Test',
    story: 'Last over of the fifth day. Nine wickets down, and the final pair only has to survive.',
    goal: 'wicket', need: Infinity, wickets: 1, field: 'slips', aggression: 0.06,
    ballAge: '70 overs old and scuffed on one side', pitchNote: 'Cracked, with uneven bounce', skyNote: 'Hot and clear',
    ball: { wearOff: 85, wearLeg: 30 }, seamCondition: 50,
    pitch: { hardness: 50, grass: 0, moisture: 0, wear: 85 },
    weather: { tempC: 32, humidity: 30, altitude: 100, cloud: 15, windKmh: 8, windDir: 200 },
  },
  {
    id: 'new-ball',
    title: 'New ball under grey skies',
    story: 'The first over of the match on a green pitch. The openers are watchful but will punish anything loose.',
    goal: 'wicket', need: Infinity, wickets: 1, field: 'slips', aggression: 0.3,
    ballAge: 'Brand new', pitchNote: 'Green, with moisture in it', skyNote: 'Cold and overcast',
    ball: { wearOff: 0, wearLeg: 0 }, seamCondition: 100,
    pitch: { hardness: 68, grass: 85, moisture: 35, wear: 0 },
    weather: { tempC: 14, humidity: 82, altitude: 50, cloud: 95, windKmh: 8, windDir: 300 },
  },
  {
    id: 'deny-the-hundred',
    title: 'Deny the hundred',
    story: 'The last over before lunch. The set batter is on 96 and badly wants a hundred before the break.',
    goal: 'chase', need: 4, wickets: 1, field: 'slips',
    ballAge: '30 overs old', pitchNote: 'Good for batting', skyNote: 'Warm, broken cloud',
    ball: { wearOff: 50, wearLeg: 15 }, seamCondition: 75,
    pitch: { hardness: 75, grass: 15, moisture: 5, wear: 20 },
    weather: { tempC: 26, humidity: 45, altitude: 50, cloud: 30, windKmh: 5, windDir: 0 },
  },
  {
    id: 'reverse-at-the-death',
    title: 'Six to win, last pair in',
    story: 'A fifty-over game going to the wire on a dry, abrasive square. The ball is old enough to reverse.',
    goal: 'chase', need: 6, wickets: 1, field: 'spread',
    ballAge: '49 overs old, rough on one side', pitchNote: 'Dry and abrasive', skyNote: 'Hot and clear',
    ball: { wearOff: 88, wearLeg: 28 }, seamCondition: 55,
    pitch: { hardness: 70, grass: 4, moisture: 0, wear: 55 },
    weather: { tempC: 31, humidity: 40, altitude: 200, cloud: 20, windKmh: 5, windDir: 0 },
  },
  {
    id: 'super-over',
    title: 'Super over',
    story: 'Scores level after forty overs, so it comes down to six balls. They need nine and will swing at everything.',
    goal: 'chase', need: 9, wickets: 2, field: 'spread',
    ballAge: '5 overs old', pitchNote: 'Hard and fast', skyNote: 'Mild, some cloud',
    ball: { wearOff: 10, wearLeg: 5 }, seamCondition: 95,
    pitch: { hardness: 85, grass: 10, moisture: 0, wear: 10 },
    weather: { tempC: 24, humidity: 55, altitude: 20, cloud: 50, windKmh: 4, windDir: 180 },
  },
];

export const scenarioById = (id) => SCENARIOS.find((s) => s.id === id) || SCENARIOS[0];

/** The settings a scenario imposes, laid over the bowler's own delivery and seam choices. */
export function applyScenario(cfg, scenario) {
  const out = JSON.parse(JSON.stringify(cfg));
  out.ball = { ...scenario.ball };
  out.seam.condition = scenario.seamCondition;
  out.pitch = { ...scenario.pitch };
  out.weather = { ...scenario.weather };
  return out;
}

export function newOver(scenario) {
  return {
    scenario,
    runs: 0, // conceded so far
    wickets: 0, // taken so far
    balls: 0, // legal balls bowled
    log: [], // one entry per delivery, including wides and no-balls
    done: false,
    result: null, // 'won' | 'lost' | 'tied', from the bowler's side
  };
}

/** What the batter needs to know before facing the next ball. */
export function situation(over) {
  const s = over.scenario;
  return {
    need: s.goal === 'chase' ? s.need - over.runs : Infinity,
    ballsLeft: 6 - over.balls,
    wicketsLeft: s.wickets - over.wickets,
    field: s.field,
    aggression: s.aggression,
  };
}

/**
 * Record one delivery and decide whether the over is finished.
 *   outcome: what faceBall() returned
 * Mutates and returns `over`.
 */
export function recordBall(over, outcome) {
  if (over.done) return over;
  const s = over.scenario;
  const r = outcome.result;
  over.runs += r.runs;
  if (r.wicket) over.wickets += 1;
  if (outcome.legal) over.balls += 1;
  over.log.push({
    legal: outcome.legal, extra: outcome.extra, runs: r.runs, wicket: r.wicket,
    mark: r.wicket ? 'W' : outcome.extra === 'wide' ? 'wd' : outcome.extra === 'noball' ? 'nb' : r.runs === 0 ? '0' : String(r.runs),
  });

  const allOut = over.wickets >= s.wickets;
  if (s.goal === 'chase') {
    if (over.runs >= s.need) { over.done = true; over.result = 'lost'; }
    else if (allOut) { over.done = true; over.result = 'won'; }
    else if (over.balls >= 6) { over.done = true; over.result = over.runs === s.need - 1 ? 'tied' : 'won'; }
  } else {
    if (allOut) { over.done = true; over.result = 'won'; }
    else if (over.balls >= 6) { over.done = true; over.result = 'lost'; }
  }
  return over;
}

/** One line on where the over stands, written to fit the scoreboard. */
export function standing(over) {
  const s = over.scenario;
  const left = 6 - over.balls;
  const balls = `${left} ball${left === 1 ? '' : 's'}`;
  if (s.goal === 'wicket') return over.done ? (over.result === 'won' ? 'Wicket taken' : 'They survived') : `One wicket needed, ${balls} left`;
  const need = s.need - over.runs;
  if (over.done) {
    if (over.result === 'lost') return 'They got there';
    if (over.result === 'tied') return 'Scores level: a tie';
    return over.wickets >= s.wickets ? 'All out' : `Defended by ${need - 1} run${need - 1 === 1 ? '' : 's'}`;
  }
  return `They need ${need} from ${balls}`;
}

function gaussian(rng) {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/**
 * Nobody lands every ball exactly where they aim. This turns the settings the
 * bowler chose into the ball that actually leaves the hand: a good bowler's
 * scatter, a few centimetres of line and a third of a metre of length.
 */
export function deliver(cfg, rng, seed) {
  const out = JSON.parse(JSON.stringify(cfg));
  const d = out.delivery, m = out.seam;
  // The scatter is in the angle of release. The same small error in angle
  // moves a full ball much further along the pitch than a short one, which is
  // why the yorker is the hardest ball to land: miss by a little and it is a
  // full toss or a half-volley.
  const carry = Math.max(4, PITCH.length - PITCH.crease - d.length) / 12.4; // 1 for a good length
  d.line = clamp(d.line + 6 * carry * gaussian(rng), -60, 80);
  d.length = clamp(d.length + 0.3 * carry * carry * gaussian(rng), 0, 14);
  d.speedKmh = clamp(d.speedKmh + 1.2 * gaussian(rng), 60, 160);
  m.angle = clamp(m.angle + 3 * gaussian(rng), -45, 45);
  m.wobble = clamp(Math.abs(m.wobble + 3 * gaussian(rng)), 0, 90);
  m.spin = clamp(m.spin + 0.8 * gaussian(rng), 0, 40);
  out.seed = seed;
  return out;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const FREE_PLAY_DEFAULTS = DEFAULTS;

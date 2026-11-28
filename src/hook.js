// What a check can read and drive: the game-state hook, window.game. Players
// never see any of it.
//
//   window.game   scene, state, press(code), hold(code, on), step(n, draw)
//   ?manual=1     the loop does not run; only step() moves the game
//   ?seed=<n>     the seed for the challenge's dice, instead of the clock's
//
// Wired to this game: Space bowls; the arrow keys turn the seam (they act on
// the ball close-up, as they do for a person who has focused it). Any other
// key code does nothing.

/** The address options. */
export const params = new URLSearchParams(location.search);

/** True when ?manual=1 is in the address: the loop does not run. */
export const manual = params.get('manual') === '1';

/** The seed from ?seed=, else the fallback. */
export function seedFrom(fallback) {
  return Number(params.get('seed')) || fallback;
}

const ARROWS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

/**
 * Puts the hook on window.game.
 *   io.scene()    the name of the mode on screen
 *   io.state()    a plain-data snapshot of the game
 *   io.advance(dt) runs the game by dt seconds without drawing
 *   io.draw(dt)   draws the stage
 *   io.target(code) the element a key goes to
 */
export function install(io) {
  const send = (type, code) => {
    const e = new KeyboardEvent(type, { code, key: ARROWS.has(code) ? code : code === 'Space' ? ' ' : code, bubbles: true, cancelable: true });
    io.target(code).dispatchEvent(e);
  };
  let pressed = [];
  const release = () => { for (const code of pressed) send('keyup', code); pressed = []; };
  window.game = {
    get scene() { return io.scene(); },
    get state() { return io.state(); },
    /** The key (a KeyboardEvent.code) goes down for one step. */
    press(code) { send('keydown', code); pressed.push(code); },
    /** The key is held down, or let go. */
    hold(code, on) { send(on ? 'keydown' : 'keyup', code); },
    /** Runs n steps of 1/60 s, then draws unless draw is false. */
    step(n = 1, draw = true) {
      for (let i = 0; i < n; i++) {
        io.advance(1 / 60);
        if (i === 0) release();
      }
      if (draw) io.draw(1 / 60);
    },
  };
}

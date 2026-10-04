/**
 * NOCTIS GP - on-screen driving controls for touch devices.
 *
 * Pointer Events, not touch events, so mouse and pen work through the same
 * path. Each button captures its own pointer, which is what makes multi-touch
 * work at all: steering left while holding the throttle is the single most
 * common thing a player does, and a naive "is any button down" model makes
 * those two presses cancel each other.
 *
 * Nothing here knows about the game. It reports which controls are held, and
 * the main loop merges that with the keyboard state, so keyboard and touch
 * can be used together.
 */

import type { DriveInput, ItemKind } from '../sim/types';

export interface TouchControlsOptions {
  /** Called when the on-screen pause button is tapped. */
  onPause(): void;
}

export interface TouchControls {
  /** True when the device reports touch support. */
  readonly supported: boolean;
  /** Which controls are currently held. */
  readonly held: TouchState;
  /** Merge the held controls into an existing input object. */
  applyTo(input: DriveInput): DriveInput;
  /** True once per press of the power-up button, then cleared. */
  consumeItemTap(): boolean;
  /** Reflect live game state (boost meter, carried item) on the buttons. */
  setBoost(available: number): void;
  setItem(item: ItemKind): void;
  setPaused(paused: boolean): void;
  destroy(): void;
}

export interface TouchState {
  left: boolean;
  right: boolean;
  throttle: boolean;
  brake: boolean;
  boost: boolean;
  item: boolean;
  handbrake: boolean;
}

const BTN = (label: string, cls: string, glyph: string): HTMLButtonElement => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `tbtn tbtn--${cls}`;
  b.setAttribute('aria-label', label);
  b.innerHTML = `<span class="tbtn__glyph">${glyph}</span>`;
  return b;
};

export function createTouchControls(opts: TouchControlsOptions): TouchControls {
  const supported =
    typeof window !== 'undefined' &&
    ('ontouchstart' in window || (navigator.maxTouchPoints ?? 0) > 0);

  const held: TouchState = {
    left: false,
    right: false,
    throttle: false,
    brake: false,
    boost: false,
    item: false,
    handbrake: false,
  };

  const layer = document.createElement('div');
  layer.className = 'touch-layer';
  layer.setAttribute('aria-hidden', 'true');

  /**
   * One-shot actions are latched on press rather than read as a held state.
   * A quick tap can begin and end between two rendered frames, which on a
   * phone at 30 fps is a realistic ~33 ms window; a held-state read would
   * silently swallow it.
   */
  let itemTap = false;

  // ---- build ---------------------------------------------------------------
  const leftCluster = document.createElement('div');
  leftCluster.className = 'tpad tpad--left';

  const rightCluster = document.createElement('div');
  rightCluster.className = 'tpad tpad--right';

  const topRight = document.createElement('div');
  topRight.className = 'ttop';

  const btnLeft = BTN('Steer left', 'steer', '&#9664;');
  const btnRight = BTN('Steer right', 'steer', '&#9654;');
  const btnThrottle = BTN('Throttle', 'go', '&#9650;');
  const btnBrake = BTN('Brake', 'brake', '&#9660;');
  const btnHandbrake = BTN('Handbrake', 'hand', 'H');
  const btnBoost = BTN('Boost', 'boost', '&#9650;');
  const btnItem = BTN('Use power-up', 'item', '&#9679;');
  const btnPause = BTN('Pause', 'pause', '&#10073;&#10073;');

  leftCluster.append(btnLeft, btnRight);
  rightCluster.append(btnThrottle, btnBrake, btnHandbrake);
  topRight.append(btnBoost, btnItem, btnPause);
  layer.append(leftCluster, rightCluster, topRight);

  const host = document.getElementById('ui') ?? document.body;
  host.appendChild(layer);

  // ---- wiring --------------------------------------------------------------
  /**
   * Bind one button to one boolean in `held`.
   *
   * Pointer capture matters: without it, dragging a thumb slightly off a
   * button while still on the glass would drop the input mid-corner. The
   * `pointercancel` case is the one that actually bites - a phone call or a
   * system gesture cancels the pointer, and if that did not clear the flag the
   * throttle would stick on.
   */
  const bind = (btn: HTMLButtonElement, flag: keyof TouchState, onFire?: () => void): void => {
    const down = (e: PointerEvent): void => {
      e.preventDefault();
      held[flag] = true;
      btn.classList.add('is-down');
      try {
        btn.setPointerCapture(e.pointerId);
      } catch {
        /* capture is an optimisation, not a requirement */
      }
      onFire?.();
    };
    const up = (e: PointerEvent): void => {
      e.preventDefault();
      held[flag] = false;
      btn.classList.remove('is-down');
      try {
        btn.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
    };
    btn.addEventListener('pointerdown', down);
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('lostpointercapture', up);
    // Long-press on iOS otherwise pops the callout and text selection.
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  };

  bind(btnLeft, 'left');
  bind(btnRight, 'right');
  bind(btnThrottle, 'throttle');
  bind(btnBrake, 'brake');
  bind(btnHandbrake, 'handbrake');
  bind(btnBoost, 'boost');
  bind(btnItem, 'item', () => {
    itemTap = true;
  });
  // Pause is an action, not a hold.
  btnPause.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    opts.onPause();
  });

  // A touch anywhere else must not scroll, rubber-band or pinch-zoom the page
  // out from under the controls.
  const stopGesture = (e: Event): void => e.preventDefault();
  layer.addEventListener('touchstart', stopGesture, { passive: false });
  layer.addEventListener('touchmove', stopGesture, { passive: false });
  layer.addEventListener('gesturestart', stopGesture as EventListener, { passive: false });

  // Losing focus mid-corner would otherwise leave the throttle stuck open.
  const releaseAll = (): void => {
    for (const k of Object.keys(held) as (keyof TouchState)[]) held[k] = false;
    itemTap = false;
    for (const b of layer.querySelectorAll('.is-down')) b.classList.remove('is-down');
  };
  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', releaseAll);

  if (supported) document.documentElement.classList.add('has-touch');

  return {
    supported,
    held,
    applyTo(input: DriveInput): DriveInput {
      input.throttle = Math.max(input.throttle, held.throttle ? 1 : 0);
      input.brake = Math.max(input.brake, held.brake ? 1 : 0);
      input.handbrake = input.handbrake || held.handbrake;
      input.boost = input.boost || held.boost;
      // Keyboard and touch can be used at once, so never let touch zero out a
      // steering value the keyboard is already applying.
      if (held.left) input.steer = 1;
      else if (held.right) input.steer = -1;
      return input;
    },
    /** True once per press, then cleared. Wire this to the use-item action. */
    consumeItemTap(): boolean {
      const t = itemTap;
      itemTap = false;
      return t;
    },
    setBoost(available: number): void {
      const ok = available > 0.001;
      btnBoost.classList.toggle('is-empty', !ok);
      btnBoost.disabled = !ok;
    },
    setItem(item: ItemKind): void {
      btnItem.classList.toggle('is-ready', !!item);
      btnItem.dataset.item = item ?? '';
      btnItem.disabled = !item;
    },
    setPaused(paused: boolean): void {
      btnPause.classList.toggle('is-paused', paused);
    },
    destroy(): void {
      window.removeEventListener('blur', releaseAll);
      document.removeEventListener('visibilitychange', releaseAll);
      layer.remove();
      document.documentElement.classList.remove('has-touch');
    },
  };
}

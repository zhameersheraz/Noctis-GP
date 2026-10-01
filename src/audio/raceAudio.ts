/**
 * NOCTIS GP - fully synthesized race audio. No audio assets.
 *
 * Every sound is generated from oscillators and filtered noise at runtime, so
 * the whole soundtrack costs nothing to download. The context is only created
 * on the first user gesture, which is what browsers require.
 *
 * Every public method is a no-op until ensure() has run, so the class is safe
 * to construct in a headless verifier.
 */

import type { CarSim } from '../sim/car';

export class RaceAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private enabled = true;

  private engineOsc: OscillatorNode | null = null;
  private engineOsc2: OscillatorNode | null = null;
  private engineSub: OscillatorNode | null = null;
  private engineGain: GainNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private rivalGain: GainNode | null = null;
  private rivalOsc: OscillatorNode | null = null;

  /** Create (or resume) the audio context. Must be called from a gesture. */
  ensure(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    // No window means no audio device: the headless verifier constructs this
    // class and must be able to call every method harmlessly.
    if (typeof window === 'undefined') return;
    const w = window as typeof window & { webkitAudioContext?: typeof AudioContext };
    const AC = window.AudioContext ?? w.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.enabled ? 0.5 : 0;
    this.master.connect(this.ctx.destination);

    // Engine: a detuned sawtooth pair plus a sub sine through a lowpass.
    this.engineFilter = this.ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 600;
    this.engineGain = this.ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineFilter.connect(this.engineGain).connect(this.master);

    this.engineOsc = this.ctx.createOscillator();
    this.engineOsc.type = 'sawtooth';
    this.engineOsc2 = this.ctx.createOscillator();
    this.engineOsc2.type = 'sawtooth';
    this.engineOsc2.detune.value = 7;
    this.engineSub = this.ctx.createOscillator();
    this.engineSub.type = 'sine';
    this.engineOsc.connect(this.engineFilter);
    this.engineOsc2.connect(this.engineFilter);
    this.engineSub.connect(this.engineGain);
    this.engineOsc.start();
    this.engineOsc2.start();
    this.engineSub.start();

    // Rival pass-by voice.
    this.rivalOsc = this.ctx.createOscillator();
    this.rivalOsc.type = 'sawtooth';
    const rf = this.ctx.createBiquadFilter();
    rf.type = 'lowpass';
    rf.frequency.value = 500;
    this.rivalGain = this.ctx.createGain();
    this.rivalGain.gain.value = 0;
    this.rivalOsc.connect(rf).connect(this.rivalGain).connect(this.master);
    this.rivalOsc.start();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(on ? 0.5 : 0, this.ctx.currentTime, 0.05);
  }

  /** Pull the mix down behind menus, without muting it entirely. */
  duck(on: boolean): void {
    if (!this.ctx || !this.master || !this.enabled) return;
    this.master.gain.setTargetAtTime(on ? 0.06 : 0.5, this.ctx.currentTime, 0.15);
  }

  updateEngine(car: CarSim, nearest: { dist: number; speed: number } | null, _dt: number): void {
    if (!this.ctx || !this.enabled || !this.engineOsc || !this.engineOsc2 || !this.engineSub) return;
    if (!this.engineFilter || !this.engineGain || !this.rivalGain || !this.rivalOsc) return;
    const t = this.ctx.currentTime;
    const sp01 = Math.min(1, car.speed / 85);
    const thr = car.throttleViz;
    const f = 38 + sp01 * 118 + thr * 34 + (car.boosting ? 26 : 0);
    this.engineOsc.frequency.setTargetAtTime(f, t, 0.05);
    this.engineOsc2.frequency.setTargetAtTime(f * 1.5, t, 0.05);
    this.engineSub.frequency.setTargetAtTime(f * 0.5, t, 0.05);
    this.engineFilter.frequency.setTargetAtTime(350 + sp01 * 2600 + thr * 1200, t, 0.08);
    const vol =
      (car.disabled ? 0.015 : 0.03) + thr * 0.075 + sp01 * 0.05 + (car.boosting ? 0.05 : 0) + (car.grounded ? 0 : -0.02);
    this.engineGain.gain.setTargetAtTime(Math.max(0.004, vol), t, 0.09);

    if (nearest && nearest.dist < 90) {
      const k = Math.max(0, 1 - nearest.dist / 90);
      this.rivalOsc.frequency.setTargetAtTime(40 + Math.min(1, nearest.speed / 85) * 110, t, 0.1);
      this.rivalGain.gain.setTargetAtTime(k * k * 0.09, t, 0.12);
    } else {
      this.rivalGain.gain.setTargetAtTime(0, t, 0.2);
    }
  }

  private beep(freq: number, dur: number, gain: number, type: OscillatorType = 'square'): void {
    if (!this.ctx || !this.master || !this.enabled) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private noiseBurst(dur: number, f0: number, f1: number, gain: number, type: BiquadFilterType = 'bandpass'): void {
    if (!this.ctx || !this.master || !this.enabled) return;
    const t = this.ctx.currentTime;
    const size = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, size, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < size; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / size);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
  }

  countdown(n: number): void {
    if (n === 0) {
      this.beep(1320, 0.3, 0.14, 'square');
      setTimeout(() => this.beep(1760, 0.35, 0.1, 'square'), 90);
    } else {
      this.beep(660, 0.11, 0.11);
    }
  }

  checkpoint(): void {
    this.beep(990, 0.08, 0.07, 'sine');
    setTimeout(() => this.beep(1320, 0.1, 0.06, 'sine'), 70);
  }

  boostPad(): void {
    this.beep(520, 0.09, 0.09, 'triangle');
    setTimeout(() => this.beep(780, 0.12, 0.08, 'triangle'), 60);
  }

  finish(): void {
    [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this.beep(f, 0.28, 0.11, 'square'), i * 130));
  }

  whoosh(): void {
    this.noiseBurst(0.45, 300, 2200, 0.14);
  }

  itemPickup(): void {
    this.beep(1175, 0.07, 0.09, 'square');
    setTimeout(() => this.beep(1568, 0.1, 0.08, 'square'), 60);
  }

  rocketLaunch(): void {
    this.noiseBurst(0.3, 900, 200, 0.1);
  }

  explosion(): void {
    this.noiseBurst(0.55, 180, 40, 0.22, 'lowpass');
    this.beep(70, 0.4, 0.12, 'sine');
  }

  shieldUp(): void {
    this.beep(523, 0.18, 0.08, 'sine');
    setTimeout(() => this.beep(784, 0.22, 0.07, 'sine'), 100);
  }

  shieldBlock(): void {
    this.beep(392, 0.12, 0.09, 'triangle');
  }

  splat(): void {
    this.beep(220, 0.08, 0.08, 'sine');
    setTimeout(() => this.beep(160, 0.1, 0.07, 'sine'), 50);
  }

  turbo(): void {
    this.noiseBurst(0.5, 400, 2600, 0.12);
  }
}

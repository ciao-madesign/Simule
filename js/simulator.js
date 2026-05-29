// Engine simulazione: traduce input movimento in posizione sul percorso
import debug from './debug.js';
import { gradeAt, lookaheadGrade, interpolateAtDist } from './grade-calc.js';
import store from './store.js';

const TICK_MS = 250;

function getBearing(a, b) {
  const φ1 = a.lat * Math.PI / 180;
  const φ2 = b.lat * Math.PI / 180;
  const Δλ = (b.lon - a.lon) * Math.PI / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

class Simulator {
  constructor() {
    this._route = null;
    this._options = {};
    this._currentDist = 0;
    this._startTime = null;
    this._elapsedTime = 0;
    this._lastTick = null;
    this._playing = false;
    this._speedMs = 0;
    this._multiplier = 1.0;
    this._tickInterval = null;
    this._callbacks = [];
    this._alertThreshold = 8;
    this._lookaheadDist = 500;
  }

  init(route, options = {}) {
    this._route = route;
    this._options = options;
    this._currentDist = options.startDist || 0;
    this._elapsedTime = 0;
    this._startTime = null;
    this._lastTick = null;
    this._playing = false;
    this._alertThreshold = store.prefs.grade_alert_threshold ?? 8;
    this._lookaheadDist = store.prefs.lookahead_dist_m ?? 500;
    this._multiplier = store.speedMultiplier || 1.0;
    debug.log('Simulator inizializzato:', route.length, 'punti');
    this._emitUpdate();
  }

  onUpdate(cb) {
    this._callbacks.push(cb);
    return () => { this._callbacks = this._callbacks.filter(f => f !== cb); };
  }

  setSpeed(speed_ms) {
    this._speedMs = Math.max(0, speed_ms);
  }

  play() {
    if (this._playing) return;
    this._playing = true;
    this._lastTick = performance.now();
    this._startTime = this._startTime ?? Date.now();
    this._tickInterval = setInterval(() => this._tick(), TICK_MS);
    store.set('isPlaying', true);
    debug.log('Simulator: play');
  }

  pause() {
    if (!this._playing) return;
    this._playing = false;
    clearInterval(this._tickInterval);
    this._tickInterval = null;
    store.set('isPlaying', false);
    debug.log('Simulator: pause');
  }

  toggle() {
    this._playing ? this.pause() : this.play();
  }

  seekTo(distMeters) {
    if (!this._route) return;
    const total = this._route[this._route.length - 1].dist_from_start;
    this._currentDist = Math.max(0, Math.min(total, distMeters));
    this._emitUpdate();
    debug.log('Seek a', this._currentDist, 'm');
  }

  seekBy(deltaMeters) {
    this.seekTo(this._currentDist + deltaMeters);
  }

  setMultiplier(n) {
    this._multiplier = n;
    store.set('speedMultiplier', n);
  }

  isPlaying() { return this._playing; }

  getCurrentDist() { return this._currentDist; }

  _tick() {
    const now = performance.now();
    const dt = (now - (this._lastTick ?? now)) / 1000;
    this._lastTick = now;
    this._elapsedTime += dt;

    const delta = this._speedMs * dt * this._multiplier;
    const total = this._route[this._route.length - 1].dist_from_start;
    this._currentDist = Math.min(this._currentDist + delta, total);

    if (this._currentDist >= total) {
      this.pause();
      debug.log('Percorso completato');
    }

    this._emitUpdate();
  }

  _emitUpdate() {
    if (!this._route) return;
    const total = this._route[this._route.length - 1].dist_from_start;
    const currentPoint = interpolateAtDist(this._route, this._currentDist);
    const nextPoint = interpolateAtDist(this._route, Math.min(this._currentDist + 20, total));
    const currentGrade = gradeAt(this._route, this._currentDist);
    const lookahead = lookaheadGrade(
      this._route,
      this._currentDist,
      this._lookaheadDist,
      this._alertThreshold
    );

    const pace = this._speedMs > 0 ? (1000 / this._speedMs) / 60 : 0;

    const state = {
      current_dist: this._currentDist,
      remaining_dist: total - this._currentDist,
      current_point: currentPoint,
      next_point: nextPoint,
      heading: getBearing(currentPoint, nextPoint),
      current_grade: parseFloat(currentGrade.toFixed(1)),
      lookahead_grade: lookahead,
      speed_ms: this._speedMs,
      pace_min_km: pace,
      elapsed_time: this._elapsedTime,
      multiplier: this._multiplier,
      is_playing: this._playing,
      total_dist: total
    };

    store.set('currentPosition', state);
    this._callbacks.forEach(cb => { try { cb(state); } catch (e) { debug.error(e); } });
  }
}

const simulator = new Simulator();
export default simulator;

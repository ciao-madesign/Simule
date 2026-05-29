// Conta-passi via DeviceMotion API
import debug from './debug.js';

const SAMPLE_RATE_MS = 50;
const MIN_STEP_INTERVAL_MS = 250;
const BUFFER_SIZE = 8;

export class Pedometer {
  constructor({ strideLength = 0.78, threshold = 1.2 } = {}) {
    this.strideLength = strideLength;
    this.threshold = threshold;

    this._buffer = [];
    this._lastStepTime = 0;
    this._stepCount = 0;
    this._totalDistance = 0;
    this._lastSpeed = 0;
    this._lastSampleTime = 0;
    this._sampleTimer = null;
    this._onUpdate = null;
    this._active = false;
    this._lastAccZ = 0;
    this._prevSmoothed = 0;
    this._rising = false;
  }

  setStrideLength(m) {
    this.strideLength = m;
  }

  setThreshold(t) {
    this.threshold = t;
  }

  onUpdate(cb) {
    this._onUpdate = cb;
  }

  async requestPermission() {
    if (typeof DeviceMotionEvent === 'undefined') {
      throw new Error('DeviceMotion non supportato in questo browser');
    }
    // iOS 13+ richiede permesso esplicito
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      const permission = await DeviceMotionEvent.requestPermission();
      if (permission !== 'granted') {
        throw new Error('Permesso DeviceMotion negato');
      }
    }
  }

  start() {
    if (this._active) return;
    this._active = true;
    this._buffer = [];
    this._rising = false;
    this._prevSmoothed = 0;
    window.addEventListener('devicemotion', this._handleMotion);
    debug.log('Pedometro avviato');
  }

  stop() {
    this._active = false;
    window.removeEventListener('devicemotion', this._handleMotion);
    debug.log('Pedometro fermato');
  }

  reset() {
    this._stepCount = 0;
    this._totalDistance = 0;
    this._lastSpeed = 0;
    this._lastStepTime = 0;
    this._buffer = [];
  }

  _handleMotion = (event) => {
    if (!this._active) return;

    const now = Date.now();
    if (now - this._lastSampleTime < SAMPLE_RATE_MS) return;
    this._lastSampleTime = now;

    const acc = event.accelerationIncludingGravity || event.acceleration;
    if (!acc) return;

    // Usa l'ampiezza totale dell'accelerazione per maggiore compatibilità
    const magnitude = Math.sqrt((acc.x||0)**2 + (acc.y||0)**2 + (acc.z||0)**2);

    this._buffer.push(magnitude);
    if (this._buffer.length > BUFFER_SIZE) this._buffer.shift();

    const smoothed = this._buffer.reduce((a, b) => a + b, 0) / this._buffer.length;

    // Rilevamento picco: la curva stava salendo e ora scende sopra la soglia
    const GRAVITY = 9.81;
    const normalized = smoothed / GRAVITY;

    if (normalized > this.threshold && this._prevSmoothed <= this.threshold) {
      this._rising = true;
    }

    if (this._rising && normalized < this.threshold) {
      this._rising = false;
      const elapsed = now - this._lastStepTime;
      if (elapsed >= MIN_STEP_INTERVAL_MS) {
        this._registerStep(now, elapsed);
      }
    }

    this._prevSmoothed = normalized;
  }

  _registerStep(now, elapsed) {
    this._stepCount++;
    this._totalDistance += this.strideLength;

    // Velocità istantanea da intervallo tra passi
    const speed = elapsed > 0 ? this.strideLength / (elapsed / 1000) : 0;
    this._lastSpeed = Math.min(speed, 8);
    this._lastStepTime = now;

    const pace = this._lastSpeed > 0 ? (1000 / this._lastSpeed) / 60 : 0;

    debug.log(`Passo ${this._stepCount}: ${(this._lastSpeed * 3.6).toFixed(1)} km/h`);

    if (this._onUpdate) {
      this._onUpdate({
        speed_ms: this._lastSpeed,
        distance_m: this._totalDistance,
        pace_min_km: pace,
        timestamp: now,
        source: 'pedometer',
        step_count: this._stepCount
      });
    }
  }

  getStats() {
    return {
      step_count: this._stepCount,
      total_distance_m: this._totalDistance,
      current_speed_ms: this._lastSpeed
    };
  }
}

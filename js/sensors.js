// Interfaccia unificata per tutte le sorgenti di movimento
import debug from './debug.js';
import { Pedometer } from './pedometer.js';
import store from './store.js';

// UUID GATT
const FTMS_SERVICE = 0x1826;
const FTMS_TREADMILL_DATA = 0x2ACD;
const RSC_SERVICE = 0x1814;
const RSC_MEASUREMENT = 0x2A53;

const MAX_RUNNER_SPEED = 8; // m/s — filtro spike GPS

function speedToPace(speed_ms) {
  if (speed_ms <= 0) return 0;
  return (1000 / speed_ms) / 60;
}

class SensorManager {
  constructor() {
    this._callbacks = [];
    this._connected = false;
    this._type = null;
    this._bleDevice = null;
    this._bleChar = null;
    this._gpsWatchId = null;
    this._pedometer = null;
    this._manualInterval = null;
    this._lastGpsPos = null;
    this._lastGpsTime = null;
    this._totalDistance = 0;
    this._manualSpeedMs = 0;
  }

  onUpdate(cb) {
    this._callbacks.push(cb);
    return () => { this._callbacks = this._callbacks.filter(f => f !== cb); };
  }

  _emit(data) {
    this._callbacks.forEach(cb => { try { cb(data); } catch {} });
  }

  isConnected() { return this._connected; }

  getAvailableSources() {
    const sources = [];
    if (navigator.bluetooth) {
      sources.push('ble-ftms');
      sources.push('ble-hrm-rsc');
    }
    if (navigator.geolocation) sources.push('gps');
    if (typeof DeviceMotionEvent !== 'undefined') sources.push('pedometer');
    sources.push('manual-pace');
    sources.push('manual-speed');
    return sources;
  }

  async connect(type, options = {}) {
    await this.disconnect();
    this._type = type;
    this._totalDistance = 0;
    this._connected = true;

    debug.log(`Connessione sensore: ${type}`, options);

    switch (type) {
      case 'ble-ftms':
        await this._connectFTMS();
        break;
      case 'ble-hrm-rsc':
        await this._connectRSC();
        break;
      case 'gps':
        this._connectGPS();
        break;
      case 'pedometer':
        await this._connectPedometer(options);
        break;
      case 'manual-pace':
        this._connectManualPace();
        break;
      case 'manual-speed':
        this._connectManualSpeed(options.speed_ms || 0);
        break;
      default:
        throw new Error('Tipo sensore sconosciuto: ' + type);
    }
  }

  async disconnect() {
    if (!this._connected) return;
    this._connected = false;

    if (this._bleDevice?.gatt?.connected) {
      try { this._bleDevice.gatt.disconnect(); } catch {}
    }
    if (this._gpsWatchId !== null) {
      navigator.geolocation.clearWatch(this._gpsWatchId);
      this._gpsWatchId = null;
    }
    if (this._pedometer) {
      this._pedometer.stop();
      this._pedometer = null;
    }
    if (this._manualInterval) {
      clearInterval(this._manualInterval);
      this._manualInterval = null;
    }

    this._bleDevice = null;
    this._bleChar = null;
    this._type = null;
    this._lastGpsPos = null;
    debug.log('Sensore disconnesso');
  }

  // ---- BLE FTMS ----
  async _connectFTMS() {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth non disponibile');
    this._bleDevice = await navigator.bluetooth.requestDevice({
      filters: [{ services: [FTMS_SERVICE] }],
      optionalServices: [FTMS_SERVICE]
    });
    const server = await this._bleDevice.gatt.connect();
    const service = await server.getPrimaryService(FTMS_SERVICE);
    this._bleChar = await service.getCharacteristic(FTMS_TREADMILL_DATA);
    await this._bleChar.startNotifications();
    this._bleChar.addEventListener('characteristicvaluechanged', (e) => {
      this._parseFTMS(e.target.value);
    });
    this._bleDevice.addEventListener('gattserverdisconnected', () => {
      debug.warn('FTMS disconnesso inaspettatamente');
      this._connected = false;
    });
    debug.log('FTMS connesso:', this._bleDevice.name);
  }

  _parseFTMS(dataView) {
    // Treadmill Data Characteristic — Bluetooth GATT spec
    const flags = dataView.getUint16(0, true);
    let offset = 2;
    // Bit 0: Instantaneous Speed presente
    let speed_ms = 0;
    if ((flags & 0x01) === 0) {
      speed_ms = dataView.getUint16(offset, true) / 100;
      offset += 2;
    }
    speed_ms = Math.min(speed_ms, MAX_RUNNER_SPEED);
    this._totalDistance += speed_ms * 0.25;
    this._emit({
      speed_ms,
      distance_m: this._totalDistance,
      pace_min_km: speedToPace(speed_ms),
      timestamp: Date.now(),
      source: 'ble-ftms'
    });
  }

  // ---- BLE RSC ----
  async _connectRSC() {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth non disponibile');
    this._bleDevice = await navigator.bluetooth.requestDevice({
      filters: [{ services: [RSC_SERVICE] }],
      optionalServices: [RSC_SERVICE]
    });
    const server = await this._bleDevice.gatt.connect();
    const service = await server.getPrimaryService(RSC_SERVICE);
    this._bleChar = await service.getCharacteristic(RSC_MEASUREMENT);
    await this._bleChar.startNotifications();
    this._bleChar.addEventListener('characteristicvaluechanged', (e) => {
      this._parseRSC(e.target.value);
    });
    this._bleDevice.addEventListener('gattserverdisconnected', () => {
      debug.warn('RSC disconnesso inaspettatamente');
      this._connected = false;
    });
    debug.log('RSC connesso:', this._bleDevice.name);
  }

  _parseRSC(dataView) {
    const flags = dataView.getUint8(0);
    const speed_ms = dataView.getUint16(1, true) / 256;
    const cadence = dataView.getUint8(3);
    this._totalDistance += speed_ms * 0.25;
    this._emit({
      speed_ms: Math.min(speed_ms, MAX_RUNNER_SPEED),
      distance_m: this._totalDistance,
      pace_min_km: speedToPace(speed_ms),
      cadence_spm: cadence,
      timestamp: Date.now(),
      source: 'ble-hrm-rsc'
    });
  }

  // ---- GPS ----
  _connectGPS() {
    this._gpsWatchId = navigator.geolocation.watchPosition(
      (pos) => this._handleGPS(pos),
      (err) => debug.warn('GPS errore:', err.message),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 5000 }
    );
    debug.log('GPS watch avviato');
  }

  _handleGPS(pos) {
    const now = Date.now();
    let speed_ms = pos.coords.speed ?? 0;

    // Fallback: calcola da delta posizione
    if (speed_ms === null || speed_ms < 0) {
      if (this._lastGpsPos && this._lastGpsTime) {
        const dt = (now - this._lastGpsTime) / 1000;
        const dx = pos.coords.longitude - this._lastGpsPos.longitude;
        const dy = pos.coords.latitude - this._lastGpsPos.latitude;
        const R = 6371000;
        const d = Math.sqrt((dx * R * Math.cos(pos.coords.latitude * Math.PI/180))**2 + (dy * R)**2) / 180 * Math.PI;
        speed_ms = dt > 0 ? d / dt : 0;
      } else {
        speed_ms = 0;
      }
    }

    // Filtra spike impossibili
    speed_ms = Math.min(speed_ms, MAX_RUNNER_SPEED);
    this._totalDistance += speed_ms * ((now - (this._lastGpsTime || now)) / 1000);
    this._lastGpsPos = pos.coords;
    this._lastGpsTime = now;

    this._emit({
      speed_ms,
      distance_m: this._totalDistance,
      pace_min_km: speedToPace(speed_ms),
      timestamp: now,
      source: 'gps',
      coords: { lat: pos.coords.latitude, lon: pos.coords.longitude }
    });
  }

  // ---- Pedometro ----
  async _connectPedometer(options) {
    const strideLength = options.stride_length ?? store.getEffectiveStrideLength();
    this._pedometer = new Pedometer({ strideLength, threshold: options.threshold ?? 1.2 });
    await this._pedometer.requestPermission();
    this._pedometer.onUpdate((data) => {
      this._totalDistance = data.distance_m;
      this._emit({ ...data });
    });
    this._pedometer.start();
  }

  // ---- Manuale Pace ----
  _connectManualPace() {
    const tick = () => {
      if (!this._connected) return;
      const paceS = store.prefs.manual_pace_s || 360;
      const speed_ms = 1000 / paceS;
      this._totalDistance += speed_ms * 0.25;
      this._emit({
        speed_ms,
        distance_m: this._totalDistance,
        pace_min_km: paceS / 60,
        timestamp: Date.now(),
        source: 'manual-pace'
      });
    };
    this._manualInterval = setInterval(tick, 250);
  }

  // ---- Manuale Velocità ----
  _connectManualSpeed(initialSpeed = 0) {
    this._manualSpeedMs = initialSpeed;
    const tick = () => {
      if (!this._connected) return;
      const speed_ms = this._manualSpeedMs;
      this._totalDistance += speed_ms * 0.25;
      this._emit({
        speed_ms,
        distance_m: this._totalDistance,
        pace_min_km: speedToPace(speed_ms),
        timestamp: Date.now(),
        source: 'manual-speed'
      });
    };
    this._manualInterval = setInterval(tick, 250);
  }

  setManualSpeed(speed_ms) {
    this._manualSpeedMs = Math.max(0, Math.min(MAX_RUNNER_SPEED, speed_ms));
  }

  adjustPace(deltaSeconds) {
    const current = store.prefs.manual_pace_s || 360;
    const next = Math.max(180, Math.min(900, current + deltaSeconds));
    store.setPref('manual_pace_s', next);
  }
}

const sensors = new SensorManager();
export default sensors;

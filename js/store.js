// Stato globale condiviso — singleton importato ovunque
import debug from './debug.js';

const PREFS_KEY = 'simule_preferences';
const ROUTES_KEY = 'simule_recent_routes';
const MAX_RECENT = 5;

const defaultPrefs = {
  runner_height_cm: null,
  stride_length_cm: null,
  stride_length_source: 'auto',
  grade_alert_threshold: 8,
  lookahead_dist_m: 500,
  manual_pace_s: 360,
  zoom_offset: 0,
  video_layout: 'pip',
  avatar: 'default',
  mapillary_token: 'MLY|28141066488815866|c57b4a9e334632eca4efd0748905287e'
};

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? { ...defaultPrefs, ...JSON.parse(raw) } : { ...defaultPrefs };
  } catch {
    return { ...defaultPrefs };
  }
}

function loadRecentRoutes() {
  try {
    const raw = localStorage.getItem(ROUTES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

const listeners = {};

const store = {
  route: null,
  routeMeta: {},
  sensorType: sessionStorage.getItem('simule_sensor_type') || null,
  sensorOptions: {},
  speedMultiplier: 1.0,
  isPlaying: false,
  currentPosition: null,
  prefs: loadPrefs(),
  recentRoutes: loadRecentRoutes(),

  set(key, value) {
    this[key] = value;
    debug.log(`store.set(${key})`, value);
    this._notify(key, value);

    if (key === 'prefs') this._savePrefs();
    if (key === 'recentRoutes') this._saveRecentRoutes();
    if (key === 'sensorType') sessionStorage.setItem('simule_sensor_type', value || '');
  },

  setPref(key, value) {
    this.prefs[key] = value;
    this._savePrefs();
    this._notify('prefs:' + key, value);
    debug.log(`store.setPref(${key})`, value);
  },

  onchange(key, cb) {
    if (!listeners[key]) listeners[key] = [];
    listeners[key].push(cb);
    return () => {
      listeners[key] = listeners[key].filter(fn => fn !== cb);
    };
  },

  addRecentRoute(routeObj) {
    this.recentRoutes = this.recentRoutes.filter(r => r.id !== routeObj.id);
    this.recentRoutes.unshift(routeObj);
    if (this.recentRoutes.length > MAX_RECENT) {
      this.recentRoutes = this.recentRoutes.slice(0, MAX_RECENT);
    }
    this._saveRecentRoutes();
    this._notify('recentRoutes', this.recentRoutes);
  },

  removeRecentRoute(id) {
    this.recentRoutes = this.recentRoutes.filter(r => r.id !== id);
    this._saveRecentRoutes();
    this._notify('recentRoutes', this.recentRoutes);
  },

  getEffectiveStrideLength() {
    if (this.prefs.stride_length_source === 'manual' && this.prefs.stride_length_cm) {
      return this.prefs.stride_length_cm / 100;
    }
    if (this.prefs.runner_height_cm) {
      return (this.prefs.runner_height_cm * 0.415) / 100;
    }
    return 0.78;
  },

  _savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs));
    } catch (e) {
      debug.warn('Impossibile salvare preferenze:', e);
    }
  },

  _saveRecentRoutes() {
    try {
      localStorage.setItem(ROUTES_KEY, JSON.stringify(this.recentRoutes));
    } catch (e) {
      debug.warn('Impossibile salvare percorsi recenti:', e);
    }
  },

  _notify(key, value) {
    if (listeners[key]) {
      listeners[key].forEach(cb => { try { cb(value); } catch (e) { debug.error(e); } });
    }
    if (listeners['*']) {
      listeners['*'].forEach(cb => { try { cb(key, value); } catch (e) { debug.error(e); } });
    }
  }
};

export default store;

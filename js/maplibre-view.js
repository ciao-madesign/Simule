// Vista satellite 2D: Esri World Imagery per road e trail
import debug from './debug.js';
import store from './store.js';

const BASE_ZOOM  = { road: 18, offroad: 16 };
const BASE_PITCH = { road: 25, offroad: 40 };

function buildSatStyle() {
  return {
    version: 8,
    sources: {
      satellite: {
        type: 'raster',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        maxzoom: 19,
        attribution: '© Esri, Maxar, Earthstar Geographics'
      }
    },
    layers: [{ id: 'sat', type: 'raster', source: 'satellite' }]
  };
}

function routeToGeoJSON(points) {
  return {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: points.map(p => [p.lon, p.lat]) },
    properties: {}
  };
}

function createRunnerMarker(color) {
  const el = document.createElement('div');
  // ID filtro univoco per evitare conflitti tra istanze multiple
  const fid = `rmf${Math.random().toString(36).slice(2)}`;
  el.innerHTML = `<svg width="30" height="38" viewBox="0 0 30 38" fill="none" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <filter id="${fid}" x="-80%" y="-80%" width="260%" height="260%">
        <feGaussianBlur stdDeviation="2.5" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    <!-- freccia direzionale (punta verso l'alto = direzione di marcia) -->
    <polygon points="15,1 22,14 15,11 8,14"
             fill="${color}" stroke="white" stroke-width="1.5" stroke-linejoin="round"
             filter="url(#${fid})"/>
    <!-- alone posizione -->
    <circle cx="15" cy="27" r="12" fill="${color}" opacity="0.18"/>
    <!-- cerchio principale -->
    <circle cx="15" cy="27" r="8" fill="${color}" stroke="white" stroke-width="2.5"
            filter="url(#${fid})"/>
  </svg>`;
  return el;
}

class MaplibreView {
  constructor() {
    this._map = null;
    this._marker = null;
    this._ready = false;
    this._pendingUpdate = null;
    this._mode = 'offroad';
    this._zoomOffset = store.prefs.zoom_offset ?? 0;
  }

  async init(container, points, mode = 'offroad') {
    this._mode = mode;
    this._zoomOffset = store.prefs.zoom_offset ?? 0;
    const style = buildSatStyle();
    const zoom  = BASE_ZOOM[mode]  + this._zoomOffset;
    const pitch = BASE_PITCH[mode];
    const start = points[0];

    return new Promise((resolve, reject) => {
      try {
        this._map = new maplibregl.Map({
          container, style,
          center: [start.lon, start.lat],
          zoom, pitch, bearing: 0,
          antialias: true
        });

        this._map.on('load', () => {
          this._map.addSource('route', { type: 'geojson', data: routeToGeoJSON(points) });
          const lineColor = mode === 'road' ? '#00b8ff' : '#00e5a0';

          this._map.addLayer({
            id: 'route-glow', type: 'line', source: 'route',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': lineColor, 'line-width': 10, 'line-opacity': 0.25 }
          });
          this._map.addLayer({
            id: 'route-line', type: 'line', source: 'route',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': lineColor, 'line-width': 4, 'line-opacity': 1 }
          });

          // Runner marker — SVG direzionale
          const el = createRunnerMarker(lineColor);
          this._marker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
            .setLngLat([start.lon, start.lat])
            .addTo(this._map);

          this._addDot(start, lineColor);
          this._addDot(points[points.length - 1], '#ff4444');

          this._ready = true;
          if (this._pendingUpdate) {
            this.update(this._pendingUpdate);
            this._pendingUpdate = null;
          }
          debug.log(`MapLibre pronto — ${mode} / zoom ${zoom}`);
          resolve();
        });

        this._map.on('error', e => debug.warn('MapLibre error:', e.error?.message));
      } catch (e) {
        debug.error('MapLibre init:', e);
        reject(e);
      }
    });
  }

  _addDot(pt, color) {
    const el = document.createElement('div');
    el.style.cssText = `width:10px;height:10px;background:${color};border:2px solid white;border-radius:50%;opacity:0.85;`;
    new maplibregl.Marker({ element: el }).setLngLat([pt.lon, pt.lat]).addTo(this._map);
  }

  update({ current_point, heading }) {
    if (!this._ready) { this._pendingUpdate = { current_point, heading }; return; }
    this._map.easeTo({
      center: [current_point.lon, current_point.lat],
      zoom: BASE_ZOOM[this._mode] + this._zoomOffset,
      bearing: heading,
      pitch: BASE_PITCH[this._mode],
      duration: 400,
      easing: t => t * (2 - t)
    });
    this._marker.setLngLat([current_point.lon, current_point.lat]);
  }

  addZoom(delta) {
    this._zoomOffset = Math.max(-4, Math.min(4, this._zoomOffset + delta));
    store.setPref('zoom_offset', this._zoomOffset);
    if (this._ready) {
      this._map.easeTo({ zoom: BASE_ZOOM[this._mode] + this._zoomOffset, duration: 250 });
    }
  }

  resize() { this._map?.resize(); }

  destroy() {
    this._map?.remove();
    this._map = null;
    this._ready = false;
  }
}

export default MaplibreView;

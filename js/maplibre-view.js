// Vista satellite 2D: Esri World Imagery per road e trail — niente terrain 3D
import debug from './debug.js';
import store from './store.js';

// Esri World Imagery — gratuito, no API key, copertura globale
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

class MaplibreView {
  constructor() {
    this._map = null;
    this._marker = null;
    this._ready = false;
    this._pendingUpdate = null;
    this._mode = 'offroad';
  }

  async init(container, points, mode = 'offroad') {
    this._mode = mode;
    const style = buildSatStyle();

    // Road: più vicino e meno inclinato (runner su strada)
    // Trail: un po' più lontano e inclinato per vedere il terreno circostante
    const zoom  = mode === 'road' ? 17 : 15;
    const pitch = mode === 'road' ? 25 : 40;

    const start = points[0];

    return new Promise((resolve, reject) => {
      try {
        this._map = new maplibregl.Map({
          container,
          style,
          center: [start.lon, start.lat],
          zoom,
          pitch,
          bearing: 0,
          antialias: true
        });

        this._map.on('load', () => {
          // Traccia GPX
          this._map.addSource('route', { type: 'geojson', data: routeToGeoJSON(points) });

          const lineColor = mode === 'road' ? '#00b8ff' : '#00e5a0';

          this._map.addLayer({
            id: 'route-glow',
            type: 'line',
            source: 'route',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': lineColor, 'line-width': 10, 'line-opacity': 0.25 }
          });
          this._map.addLayer({
            id: 'route-line',
            type: 'line',
            source: 'route',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': lineColor, 'line-width': 4, 'line-opacity': 1 }
          });

          // Marker posizione corrente
          const el = document.createElement('div');
          el.style.cssText = `width:18px;height:18px;background:${lineColor};border:3px solid white;border-radius:50%;box-shadow:0 0 0 4px ${lineColor}55,0 0 16px ${lineColor}99;`;
          this._marker = new maplibregl.Marker({ element: el })
            .setLngLat([start.lon, start.lat])
            .addTo(this._map);

          this._addDot(start, lineColor);
          this._addDot(points[points.length - 1], '#ff4444');

          this._ready = true;
          if (this._pendingUpdate) {
            this.update(this._pendingUpdate);
            this._pendingUpdate = null;
          }
          debug.log(`MapLibre satellite pronto — ${mode} / Esri`);
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
      zoom: this._mode === 'road' ? 17 : 15,
      bearing: heading,
      pitch: this._mode === 'road' ? 25 : 40,
      duration: 400,
      easing: t => t * (2 - t)
    });
    this._marker.setLngLat([current_point.lon, current_point.lat]);
  }

  resize() { this._map?.resize(); }

  destroy() {
    this._map?.remove();
    this._map = null;
    this._ready = false;
  }
}

export default MaplibreView;

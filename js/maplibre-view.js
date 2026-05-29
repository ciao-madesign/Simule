// Vista 3D offroad: MapLibre flythrough con terrain
import debug from './debug.js';
import store from './store.js';

const STADIA_STYLE = 'https://tiles.stadiamaps.com/styles/alidade_smooth_dark.json';

function routeToGeoJSON(points) {
  return {
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: points.map(p => [p.lon, p.lat, p.ele || 0])
    },
    properties: {}
  };
}

class MaplibreView {
  constructor() {
    this._map = null;
    this._marker = null;
    this._ready = false;
    this._pendingUpdate = null;
  }

  async init(container, points) {
    const key = store.prefs.maptiler_key;
    const style = key
      ? `https://api.maptiler.com/maps/outdoor-v2/style.json?key=${key}`
      : STADIA_STYLE;

    const start = points[0];

    return new Promise((resolve, reject) => {
      try {
        this._map = new maplibregl.Map({
          container,
          style,
          center: [start.lon, start.lat],
          zoom: 14,
          pitch: 65,
          bearing: 0,
          antialias: true
        });

        this._map.on('load', () => {
          if (key) {
            this._map.addSource('terrain', {
              type: 'raster-dem',
              url: `https://api.maptiler.com/tiles/terrain-rgb-v2/tiles.json?key=${key}`,
              tileSize: 256
            });
            this._map.setTerrain({ source: 'terrain', exaggeration: 1.5 });
          }

          this._map.addSource('route', {
            type: 'geojson',
            data: routeToGeoJSON(points)
          });

          this._map.addLayer({
            id: 'route-line',
            type: 'line',
            source: 'route',
            paint: {
              'line-color': '#00e5a0',
              'line-width': 3,
              'line-opacity': 0.85
            }
          });

          // Marker posizione corrente
          const el = document.createElement('div');
          el.style.cssText = `
            width:16px;height:16px;background:#00e5a0;
            border:3px solid white;border-radius:50%;
            box-shadow:0 0 12px rgba(0,229,160,0.8);
          `;
          this._marker = new maplibregl.Marker({ element: el })
            .setLngLat([start.lon, start.lat])
            .addTo(this._map);

          this._ready = true;
          if (this._pendingUpdate) {
            this.update(this._pendingUpdate);
            this._pendingUpdate = null;
          }
          debug.log('MapLibre view pronta');
          resolve();
        });

        this._map.on('error', (e) => {
          debug.warn('MapLibre errore:', e.error?.message);
          // Non rifiutare — mappa potrebbe comunque funzionare
        });
      } catch (e) {
        debug.error('MapLibre init fallita:', e);
        reject(e);
      }
    });
  }

  update({ current_point, next_point, heading }) {
    if (!this._ready) {
      this._pendingUpdate = { current_point, next_point, heading };
      return;
    }

    const center = [current_point.lon, current_point.lat];

    this._map.easeTo({
      center,
      bearing: heading,
      pitch: 65,
      duration: 280,
      easing: t => t
    });

    this._marker.setLngLat(center);
  }

  resize() {
    this._map?.resize();
  }

  destroy() {
    this._map?.remove();
    this._map = null;
    this._ready = false;
  }
}

export default MaplibreView;

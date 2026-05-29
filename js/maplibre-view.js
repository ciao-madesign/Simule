// Vista 3D offroad: MapLibre flythrough con terrain
import debug from './debug.js';
import store from './store.js';

// CARTO Dark Matter — gratuito, nessuna API key richiesta
const CARTO_DARK = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

// Terrain gratuito via AWS Open Data (formato Terrarium, no auth)
const AWS_TERRAIN_TILES = [
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
];

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
    this._currentZoom = 15;
  }

  async init(container, points) {
    const key = store.prefs.maptiler_key;

    // Con chiave MapTiler usa outdoor con terrain integrato; altrimenti CARTO + AWS terrain
    const style = key
      ? `https://api.maptiler.com/maps/outdoor-v2/style.json?key=${key}`
      : CARTO_DARK;

    const start = points[0];

    return new Promise((resolve, reject) => {
      try {
        this._map = new maplibregl.Map({
          container,
          style,
          center: [start.lon, start.lat],
          zoom: 15,
          pitch: 62,
          bearing: 0,
          antialias: true,
          maxPitch: 85
        });

        this._map.on('load', () => {
          // Terrain: MapTiler se disponibile, altrimenti AWS Terrarium gratuito
          if (key) {
            this._map.addSource('terrain', {
              type: 'raster-dem',
              url: `https://api.maptiler.com/tiles/terrain-rgb-v2/tiles.json?key=${key}`,
              tileSize: 256
            });
          } else {
            this._map.addSource('terrain', {
              type: 'raster-dem',
              tiles: AWS_TERRAIN_TILES,
              tileSize: 256,
              encoding: 'terrarium',
              minzoom: 0,
              maxzoom: 14
            });
          }

          this._map.setTerrain({ source: 'terrain', exaggeration: 1.8 });
          this._map.setFog({ color: '#1a2028', 'high-color': '#0a0c0f', 'horizon-blend': 0.04 });

          // Traccia GPX
          this._map.addSource('route', {
            type: 'geojson',
            data: routeToGeoJSON(points)
          });

          // Contorno (glow)
          this._map.addLayer({
            id: 'route-glow',
            type: 'line',
            source: 'route',
            paint: {
              'line-color': '#00e5a0',
              'line-width': 6,
              'line-opacity': 0.25,
              'line-blur': 4
            }
          });

          // Linea principale
          this._map.addLayer({
            id: 'route-line',
            type: 'line',
            source: 'route',
            paint: {
              'line-color': '#00e5a0',
              'line-width': 2.5,
              'line-opacity': 0.9
            }
          });

          // Marker posizione corrente
          const el = document.createElement('div');
          el.style.cssText = `
            width:18px;height:18px;
            background:#00e5a0;
            border:3px solid white;
            border-radius:50%;
            box-shadow:0 0 0 4px rgba(0,229,160,0.35),0 0 16px rgba(0,229,160,0.7);
          `;
          this._marker = new maplibregl.Marker({ element: el })
            .setLngLat([start.lon, start.lat])
            .addTo(this._map);

          // Marker start
          const startEl = document.createElement('div');
          startEl.style.cssText = 'width:10px;height:10px;background:#00e5a0;border:2px solid white;border-radius:50%;opacity:0.7;';
          new maplibregl.Marker({ element: startEl }).setLngLat([start.lon, start.lat]).addTo(this._map);

          // Marker finish
          const endPt = points[points.length - 1];
          const endEl = document.createElement('div');
          endEl.style.cssText = 'width:10px;height:10px;background:#ff4444;border:2px solid white;border-radius:50%;opacity:0.7;';
          new maplibregl.Marker({ element: endEl }).setLngLat([endPt.lon, endPt.lat]).addTo(this._map);

          this._ready = true;
          if (this._pendingUpdate) {
            this.update(this._pendingUpdate);
            this._pendingUpdate = null;
          }
          debug.log('MapLibre view pronta (terrain:', key ? 'MapTiler' : 'AWS Terrarium', ')');
          resolve();
        });

        this._map.on('error', (e) => {
          debug.warn('MapLibre errore stile:', e.error?.message);
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
      zoom: 15,
      bearing: heading,
      pitch: 62,
      duration: 400,
      easing: t => t * (2 - t)   // ease-out per movimento più fluido
    });

    this._marker.setLngLat(center);
  }

  resize() { this._map?.resize(); }

  destroy() {
    this._map?.remove();
    this._map = null;
    this._ready = false;
  }
}

export default MaplibreView;

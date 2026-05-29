// Vista 3D: satellite per trail, city per road — MapLibre GL JS
import debug from './debug.js';
import store from './store.js';

// Satellite Esri World Imagery — gratuito, no API key
function buildSatStyle() {
  return {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      satellite: {
        type: 'raster',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        maxzoom: 19,
        attribution: '© Esri, Maxar, GeoEye, Earthstar Geographics'
      }
    },
    layers: [{ id: 'sat', type: 'raster', source: 'satellite' }]
  };
}

// Terrain AWS Open Data — gratuito, no auth, formato Terrarium
const AWS_TERRAIN = {
  type: 'raster-dem',
  tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
  tileSize: 256,
  encoding: 'terrarium',
  minzoom: 0,
  maxzoom: 14
};

function routeToGeoJSON(points) {
  return {
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: points.map(p => [p.lon, p.lat])
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
    this._mode = 'offroad';
  }

  async init(container, points, mode = 'offroad') {
    this._mode = mode;
    const key = store.prefs.maptiler_key;

    let style, pitch, exaggeration;

    if (mode === 'road') {
      // Modalità city: mappa scura 3D per seguire il runner quando streetview non c'è
      pitch = 45;
      exaggeration = 0; // no terrain per strade pianeggianti
      style = key
        ? `https://api.maptiler.com/maps/streets-v2-dark/style.json?key=${key}`
        : 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
    } else {
      // Modalità satellite: Esri + terrain 3D AWS
      pitch = 65;
      exaggeration = 2.0;
      style = key
        ? `https://api.maptiler.com/maps/outdoor-v2/style.json?key=${key}`
        : buildSatStyle();
    }

    const start = points[0];

    return new Promise((resolve, reject) => {
      try {
        this._map = new maplibregl.Map({
          container,
          style,
          center: [start.lon, start.lat],
          zoom: 15,
          pitch,
          bearing: 0,
          antialias: true,
          maxPitch: 85
        });

        this._map.on('load', () => {
          // Terrain 3D (solo offroad o con MapTiler key)
          if (exaggeration > 0) {
            try {
              const terrainSrc = key
                ? { type: 'raster-dem', url: `https://api.maptiler.com/tiles/terrain-rgb-v2/tiles.json?key=${key}`, tileSize: 256 }
                : AWS_TERRAIN;
              this._map.addSource('terrain', terrainSrc);
              this._map.setTerrain({ source: 'terrain', exaggeration });
            } catch (e) {
              debug.warn('Terrain non disponibile:', e.message);
            }
          }

          // Traccia GPX — alone + linea principale
          this._map.addSource('route', {
            type: 'geojson',
            data: routeToGeoJSON(points)
          });

          const lineColor = mode === 'road' ? '#00b8ff' : '#00e5a0';

          this._map.addLayer({
            id: 'route-glow',
            type: 'line',
            source: 'route',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': lineColor, 'line-width': 12, 'line-opacity': 0.2 }
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
          el.style.cssText = `
            width:18px;height:18px;background:${lineColor};
            border:3px solid white;border-radius:50%;
            box-shadow:0 0 0 4px ${lineColor}55,0 0 16px ${lineColor}99;
          `;
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
          debug.log(`MapLibre pronto — ${mode} / ${key ? 'MapTiler' : (mode === 'offroad' ? 'satellite+AWS' : 'CARTO')}`);
          resolve();
        });

        this._map.on('error', e => debug.warn('MapLibre:', e.error?.message));
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
    if (!this._ready) {
      this._pendingUpdate = { current_point, heading };
      return;
    }
    this._map.easeTo({
      center: [current_point.lon, current_point.lat],
      zoom: 15,
      bearing: heading,
      pitch: this._mode === 'road' ? 45 : 65,
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

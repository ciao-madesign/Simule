// Vista satellite 2D + supporto avatar 3D (Three.js custom layer)
import debug from './debug.js';
import store from './store.js';

const BASE_ZOOM  = { road: 18, offroad: 16 };
const BASE_PITCH = { road: 25, offroad: 40 };

// Placeholder animati (Khronos glTF samples, CC-BY 4.0).
// Per usare i modelli Sketchfab: scarica il .glb, mettilo in /assets/models/
// e sostituisci l'url corrispondente.
export const AVATAR_DEFS = {
  runner1: {
    label: 'Runner',
    url: 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/main/2.0/CesiumMan/glTF-Binary/CesiumMan.glb',
    sketchfab: 'https://sketchfab.com/3d-models/runner-4e15585a113c4548bea1696be502891b',
    heightM: 8
  },
  runner2: {
    label: 'Runner (grigio)',
    url: 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/main/2.0/RiggedFigure/glTF-Binary/RiggedFigure.glb',
    sketchfab: 'https://sketchfab.com/3d-models/runner-in-gray-e5ef28baa0554c54bc3c75ff33be69fb',
    heightM: 8
  },
  boar: {
    label: 'Cinghiale',
    url: 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/main/2.0/Fox/glTF-Binary/Fox.glb',
    sketchfab: 'https://sketchfab.com/3d-models/realistic-boar-javali-3d-model-0d6510a6e21b430fa31a345b3fa90a6f',
    heightM: 6
  }
};

function buildSatStyle() {
  return {
    version: 8,
    sources: {
      satellite: {
        type: 'raster',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256, maxzoom: 19,
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
  const fid = `rmf${Math.random().toString(36).slice(2)}`;
  el.innerHTML = `<svg width="30" height="38" viewBox="0 0 30 38" fill="none" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <filter id="${fid}" x="-80%" y="-80%" width="260%" height="260%">
        <feGaussianBlur stdDeviation="2.5" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    <polygon points="15,1 22,14 15,11 8,14"
             fill="${color}" stroke="white" stroke-width="1.5" stroke-linejoin="round"
             filter="url(#${fid})"/>
    <circle cx="15" cy="27" r="12" fill="${color}" opacity="0.18"/>
    <circle cx="15" cy="27" r="8" fill="${color}" stroke="white" stroke-width="2.5"
            filter="url(#${fid})"/>
  </svg>`;
  return el;
}

// ---- Three.js lazy loader ----
async function loadThreeJS() {
  if (window.THREE?.GLTFLoader) return;
  if (!window.THREE) {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/three@0.134.0/build/three.min.js';
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  await new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/three@0.134.0/examples/js/loaders/GLTFLoader.js';
    s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
}

// ---- Custom MapLibre layer per modello 3D ----
class ModelLayer {
  constructor(url, heightM) {
    this.id = 'avatar-3d';
    this.type = 'custom';
    this.renderingMode = '3d';
    this._url = url;
    this._heightM = heightM;
    this._model = null;
    this._mixer = null;
    this._nativeHeight = 1;
    this._pos = null;
    this._heading = 0;
    this._lastTime = 0;
    this._camera = null;
    this._scene = null;
    this._renderer = null;
    this._map = null;
  }

  onAdd(map, gl) {
    this._map = map;
    const THREE = window.THREE;

    this._camera = new THREE.Camera();
    this._scene = new THREE.Scene();
    this._scene.add(new THREE.AmbientLight(0xffffff, 1.2));
    const dir = new THREE.DirectionalLight(0xffffff, 0.7);
    dir.position.set(0, 10, 6);
    this._scene.add(dir);

    this._renderer = new THREE.WebGLRenderer({
      canvas: map.getCanvas(),
      context: gl,
      antialias: true
    });
    this._renderer.autoClear = false;

    const loader = new THREE.GLTFLoader();
    loader.load(this._url, gltf => {
      this._model = gltf.scene;
      const box = new THREE.Box3().setFromObject(this._model);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      this._model.position.x -= center.x;
      this._model.position.z -= center.z;
      this._model.position.y -= box.min.y;
      this._nativeHeight = size.y || 1;
      if (gltf.animations?.length) {
        this._mixer = new THREE.AnimationMixer(this._model);
        this._mixer.clipAction(gltf.animations[0]).play();
      }
      this._scene.add(this._model);
      map.triggerRepaint();
      debug.log('Avatar 3D caricato:', this._url);
    }, undefined, err => debug.warn('Avatar load error (uso SVG fallback):', err));
  }

  setPosition(lng, lat, heading) {
    this._pos = [lng, lat];
    this._heading = heading;
    if (this._map) this._map.triggerRepaint();
  }

  render(gl, matrix) {
    if (!this._model || !this._pos) return;
    const THREE = window.THREE;

    const now = performance.now();
    const delta = Math.min((now - this._lastTime) / 1000, 0.1);
    this._lastTime = now;
    if (this._mixer) this._mixer.update(delta);

    const mc = maplibregl.MercatorCoordinate.fromLngLat(this._pos, 0);
    const mpu = mc.meterInMercatorCoordinateUnits();
    const sc = (this._heightM / this._nativeHeight) * mpu;

    const rotX = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    const rotY = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(0, 1, 0), (this._heading * Math.PI) / 180);

    const m = new THREE.Matrix4().fromArray(matrix);
    const l = new THREE.Matrix4()
      .makeTranslation(mc.x, mc.y, mc.z)
      .scale(new THREE.Vector3(sc, -sc, sc))
      .multiply(rotX)
      .multiply(rotY);

    this._camera.projectionMatrix = m.multiply(l);
    this._renderer.resetState();
    this._renderer.render(this._scene, this._camera);
    this._map.triggerRepaint();
  }
}

// ---- MaplibreView ----
class MaplibreView {
  constructor() {
    this._map = null;
    this._marker = null;
    this._modelLayer = null;
    this._ready = false;
    this._pendingUpdate = null;
    this._mode = 'offroad';
    this._zoomOffset = store.prefs.zoom_offset ?? 0;
  }

  async init(container, points, mode = 'offroad') {
    this._mode = mode;
    this._zoomOffset = store.prefs.zoom_offset ?? 0;
    const style = buildSatStyle();
    const zoom  = BASE_ZOOM[mode] + this._zoomOffset;
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

          // Marker SVG (default) — nascosto se si usa avatar 3D
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

          // Carica avatar 3D se selezionato
          const avatar = store.prefs.avatar || 'default';
          if (avatar !== 'default' && AVATAR_DEFS[avatar]) {
            this._load3DAvatar(avatar);
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

  _load3DAvatar(avatarKey) {
    const def = AVATAR_DEFS[avatarKey];
    if (!def || !this._ready) return;
    loadThreeJS()
      .then(() => {
        this._modelLayer = new ModelLayer(def.url, def.heightM);
        this._map.addLayer(this._modelLayer);
        // Nascondi SVG marker
        this._marker.getElement().style.display = 'none';
        debug.log(`Avatar 3D in caricamento: ${def.label}`);
      })
      .catch(e => debug.warn('Three.js load failed, uso SVG marker:', e));
  }

  _addDot(pt, color) {
    const el = document.createElement('div');
    el.style.cssText = `width:10px;height:10px;background:${color};border:2px solid white;border-radius:50%;opacity:0.85;`;
    new maplibregl.Marker({ element: el }).setLngLat([pt.lon, pt.lat]).addTo(this._map);
  }

  update({ current_point, heading }) {
    if (!this._ready) { this._pendingUpdate = { current_point, heading }; return; }

    if (this._modelLayer) {
      this._modelLayer.setPosition(current_point.lon, current_point.lat, heading);
    } else {
      this._marker.setLngLat([current_point.lon, current_point.lat]);
    }

    this._map.easeTo({
      center: [current_point.lon, current_point.lat],
      zoom: BASE_ZOOM[this._mode] + this._zoomOffset,
      bearing: heading,
      pitch: BASE_PITCH[this._mode],
      duration: 400,
      easing: t => t * (2 - t)
    });
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
    this._modelLayer = null;
  }
}

export default MaplibreView;

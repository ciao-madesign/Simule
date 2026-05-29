// Vista road: Mapillary (token) → Panoramax (no auth) → satellite
import debug from './debug.js';
import store from './store.js';

const MAPILLARY_URL = 'https://graph.mapillary.com/images';
// Panoramax: progetto open street imagery (IGN + community) — no autenticazione
const PANORAMAX_INSTANCES = [
  'https://api.panoramax.xyz/api',
  'https://panoramax.ign.fr/api'
];

function angleDiff(a, b) {
  return Math.abs(((a - b) + 180) % 360 - 180);
}

async function fetchMapillary(lat, lon, heading) {
  const token = store.prefs.mapillary_token;
  if (!token) return null;
  try {
    const bbox = `${lon - 0.0005},${lat - 0.0005},${lon + 0.0005},${lat + 0.0005}`;
    const url = `${MAPILLARY_URL}?fields=id,geometry,thumb_1024_url,computed_compass_angle&bbox=${bbox}&limit=20&access_token=${token}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data.data?.length) return null;
    let best = null, bestScore = Infinity;
    for (const img of data.data) {
      const score = heading !== undefined ? angleDiff(img.computed_compass_angle || 0, heading) : 0;
      if (score < bestScore) { bestScore = score; best = img; }
    }
    return best ? { url: best.thumb_1024_url, id: best.id, heading: best.computed_compass_angle || 0, source: 'mapillary' } : null;
  } catch { return null; }
}

async function fetchPanoramax(lat, lon, heading) {
  const margin = 0.0006;
  const bbox = `${lon - margin},${lat - margin},${lon + margin},${lat + margin}`;
  for (const base of PANORAMAX_INSTANCES) {
    try {
      const url = `${base}/collections/pictures/items?bbox=${bbox}&limit=15`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) continue;
      const data = await resp.json();
      if (!data.features?.length) continue;

      let best = null, bestScore = Infinity;
      for (const f of data.features) {
        // pers:kappa = angolo bussola in gradi da nord (standard STAC extension)
        const kappa = f.properties?.['pers:kappa'] ?? f.properties?.heading ?? 0;
        const score = heading !== undefined ? angleDiff(kappa, heading) : 0;
        if (score < bestScore) { bestScore = score; best = f; }
      }
      if (!best) continue;

      // Cerca URL immagine in assets (hd > sd > thumb) oppure nei links
      const imgUrl = best.assets?.hd?.href
        || best.assets?.sd?.href
        || best.assets?.thumb?.href
        || best.links?.find(l => l.rel === 'enclosure' || l.type?.startsWith('image/'))?.href;
      if (!imgUrl) continue;

      const kappa = best.properties?.['pers:kappa'] ?? best.properties?.heading ?? 0;
      return { url: imgUrl, heading: kappa, source: 'panoramax' };
    } catch { continue; }
  }
  return null;
}

export async function fetchNearbyImage(lat, lon, heading) {
  return await fetchMapillary(lat, lon, heading)
      || await fetchPanoramax(lat, lon, heading)
      || null;
}

export async function checkCoverage(points) {
  const SAMPLE_M = 250;
  const total = points[points.length - 1].dist_from_start;
  const samples = [];
  for (let d = 0; d <= total; d += SAMPLE_M) {
    const idx = points.findIndex(p => p.dist_from_start >= d);
    if (idx >= 0) samples.push(points[idx]);
  }

  let covered = 0;
  const sourceMap = [];
  const batch = samples.slice(0, 16);
  await Promise.allSettled(batch.map(async pt => {
    const img = await fetchMapillary(pt.lat, pt.lon)
             || await fetchPanoramax(pt.lat, pt.lon);
    if (img) { covered++; sourceMap.push({ dist: pt.dist_from_start, source: img.source }); }
  }));
  return {
    percent: batch.length > 0 ? Math.round((covered / batch.length) * 100) : 0,
    source_map: sourceMap
  };
}

class StreetView {
  constructor() {
    this._imgEl = null;
    this._badgeEl = null;
    this._wrapEl = null;
    this._mlyEl = null;
    this._mlyViewer = null;
    this._mlyCurrentId = null;
    this._cache = new Map();
    this._noImageStreak = 0;
  }

  init(imgElement, badgeElement, wrapElement = null, mlyElement = null) {
    this._imgEl = imgElement;
    this._badgeEl = badgeElement;
    this._wrapEl = wrapElement;
    this._mlyEl = mlyElement;
    if (this._wrapEl) this._wrapEl.style.background = 'transparent';
    this._showBadge('🗺 Satellite');
  }

  setMapillaryViewer(viewer) {
    this._mlyViewer = viewer;
  }

  async update({ current_point, heading }) {
    const { lat, lon } = current_point;
    const cacheKey = `${lat.toFixed(4)},${lon.toFixed(4)}`;

    let img = this._cache.get(cacheKey);
    if (img === undefined) {
      img = await fetchMapillary(lat, lon, heading)
         || await fetchPanoramax(lat, lon, heading)
         || null;
      this._cache.set(cacheKey, img);
    }

    if (img) {
      this._noImageStreak = 0;
      if (this._wrapEl) this._wrapEl.style.background = '#000';
      this._hideBadge();

      if (img.source === 'mapillary' && img.id && this._mlyViewer) {
        // Viewer 360° interattivo Mapillary
        if (this._mlyEl) this._mlyEl.style.visibility = 'visible';
        this._imgEl.style.display = 'none';
        if (img.id !== this._mlyCurrentId) {
          this._mlyCurrentId = img.id;
          this._mlyViewer.moveTo(img.id).catch(() => {});
        }
      } else {
        // Immagine statica (Panoramax o Mapillary senza viewer)
        if (this._mlyEl) this._mlyEl.style.visibility = 'hidden';
        this._imgEl.src = img.url;
        this._imgEl.style.display = 'block';
      }

      // Prefetch punto successivo
      const nextLat = lat + 0.00015 * Math.cos(heading * Math.PI / 180);
      const nextLon = lon + 0.00015 * Math.sin(heading * Math.PI / 180);
      const nextKey = `${nextLat.toFixed(4)},${nextLon.toFixed(4)}`;
      if (!this._cache.has(nextKey)) {
        this._cache.set(nextKey, undefined);
        Promise.any([
          fetchMapillary(nextLat, nextLon, heading),
          fetchPanoramax(nextLat, nextLon, heading)
        ]).then(ni => this._cache.set(nextKey, ni || null)).catch(() => this._cache.set(nextKey, null));
      }
    } else {
      this._noImageStreak++;
      if (this._noImageStreak >= 2) {
        if (this._wrapEl) this._wrapEl.style.background = 'transparent';
        if (this._mlyEl) this._mlyEl.style.visibility = 'hidden';
        this._imgEl.style.display = 'none';
        const hint = store.prefs.mapillary_token ? '🗺 Satellite' : '🗺 Satellite · aggiungi token Mapillary in Impostazioni';
        this._showBadge(hint);
      }
    }

    if (this._cache.size > 80) {
      this._cache.delete(this._cache.keys().next().value);
    }
  }

  _showBadge(text) {
    if (!this._badgeEl) return;
    this._badgeEl.textContent = text;
    this._badgeEl.style.display = 'block';
  }

  _hideBadge() {
    if (this._badgeEl) this._badgeEl.style.display = 'none';
  }
}

export default StreetView;

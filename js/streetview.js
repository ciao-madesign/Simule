// Vista road: Mapillary come unica sorgente (copertura globale)
// KartaView rimosso — copertura insufficiente
import debug from './debug.js';
import store from './store.js';

const MAPILLARY_URL = 'https://graph.mapillary.com/images';

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
    return best ? { url: best.thumb_1024_url, heading: best.computed_compass_angle || 0, source: 'mapillary' } : null;
  } catch { return null; }
}

export async function checkCoverage(points) {
  const token = store.prefs.mapillary_token;
  if (!token) return { percent: 0, source_map: [] };

  const SAMPLE_M = 250;
  const total = points[points.length - 1].dist_from_start;
  const samples = [];
  for (let d = 0; d <= total; d += SAMPLE_M) {
    const idx = points.findIndex(p => p.dist_from_start >= d);
    if (idx >= 0) samples.push(points[idx]);
  }

  let covered = 0;
  const sourceMap = [];
  const batch = samples.slice(0, 24);
  await Promise.allSettled(batch.map(async pt => {
    const img = await fetchMapillary(pt.lat, pt.lon);
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
    this._cache = new Map();
    this._noImageStreak = 0;
  }

  init(imgElement, badgeElement, wrapElement = null) {
    this._imgEl = imgElement;
    this._badgeEl = badgeElement;
    this._wrapEl = wrapElement;

    // Senza token Mapillary mostra subito satellite con suggerimento
    if (!store.prefs.mapillary_token) {
      this._showBadge('🗺 Satellite · aggiungi token Mapillary in Impostazioni per streetview');
      if (this._wrapEl) this._wrapEl.style.background = 'transparent';
    }
  }

  async update({ current_point, heading }) {
    if (!store.prefs.mapillary_token) return; // satellite visibile sotto

    const { lat, lon } = current_point;
    const cacheKey = `${lat.toFixed(4)},${lon.toFixed(4)}`;

    let img = this._cache.get(cacheKey);
    if (img === undefined) {
      img = await fetchMapillary(lat, lon, heading) || null;
      this._cache.set(cacheKey, img);
    }

    if (img) {
      this._noImageStreak = 0;
      if (this._wrapEl) this._wrapEl.style.background = '#000';
      this._imgEl.src = img.url;
      this._imgEl.style.display = 'block';
      this._hideBadge();

      // Prefetch punto successivo
      const nextLat = lat + 0.00015 * Math.cos(heading * Math.PI / 180);
      const nextLon = lon + 0.00015 * Math.sin(heading * Math.PI / 180);
      const nextKey = `${nextLat.toFixed(4)},${nextLon.toFixed(4)}`;
      if (!this._cache.has(nextKey)) {
        this._cache.set(nextKey, undefined);
        fetchMapillary(nextLat, nextLon, heading).then(ni => this._cache.set(nextKey, ni || null));
      }
    } else {
      this._noImageStreak++;
      if (this._noImageStreak >= 2) {
        if (this._wrapEl) this._wrapEl.style.background = 'transparent';
        this._imgEl.style.display = 'none';
        this._showBadge('🗺 Satellite');
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

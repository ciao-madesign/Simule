// Vista road: KartaView + Mapillary fallback
import debug from './debug.js';
import store from './store.js';

const KARTAVIEW_URL = 'https://api.openstreetcam.org/2.0/photo/';
const MAPILLARY_URL = 'https://graph.mapillary.com/images';

function angleDistance(a, b) {
  const diff = Math.abs(((a - b) + 180) % 360 - 180);
  return diff;
}

async function fetchKartaView(lat, lon) {
  try {
    const url = `${KARTAVIEW_URL}?lat=${lat}&lng=${lon}&radius=0.03`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();
    const photos = data?.result?.data;
    if (!photos?.length) return null;
    const photo = photos[0];
    return {
      url: photo.fileurlProc || photo.fileurl,
      heading: parseFloat(photo.heading) || 0,
      source: 'kartaview'
    };
  } catch {
    return null;
  }
}

async function fetchMapillary(lat, lon, heading) {
  const token = store.prefs.mapillary_token;
  if (!token) return null;
  try {
    const bbox = `${lon-0.0003},${lat-0.0003},${lon+0.0003},${lat+0.0003}`;
    const url = `${MAPILLARY_URL}?fields=id,geometry,thumb_1024_url,computed_compass_angle&bbox=${bbox}&access_token=${token}`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data.data?.length) return null;

    // Scegli l'immagine con heading più vicino alla direzione di marcia
    let best = null, bestScore = Infinity;
    for (const img of data.data) {
      const score = heading !== undefined
        ? angleDistance(img.computed_compass_angle || 0, heading)
        : 0;
      if (score < bestScore) { bestScore = score; best = img; }
    }

    return best ? {
      url: best.thumb_1024_url,
      heading: best.computed_compass_angle || 0,
      source: 'mapillary'
    } : null;
  } catch {
    return null;
  }
}

export async function checkCoverage(points) {
  const SAMPLE_M = 200;
  const total = points[points.length - 1].dist_from_start;
  const samples = [];

  for (let d = 0; d <= total; d += SAMPLE_M) {
    const idx = points.findIndex(p => p.dist_from_start >= d);
    if (idx >= 0) samples.push(points[idx]);
  }

  let covered = 0;
  const sourceMap = [];

  // Limita a 20 richieste per non bloccare troppo
  const batch = samples.slice(0, 20);
  await Promise.all(batch.map(async pt => {
    const img = await fetchKartaView(pt.lat, pt.lon) || await fetchMapillary(pt.lat, pt.lon);
    if (img) {
      covered++;
      sourceMap.push({ dist: pt.dist_from_start, source: img.source });
    }
  }));

  return {
    percent: batch.length > 0 ? Math.round((covered / batch.length) * 100) : 0,
    source_map: sourceMap
  };
}

class StreetView {
  constructor() {
    this._imgEl = null;
    this._fallbackEl = null;
    this._cache = new Map();
    this._currentHeading = 0;
    this._noImageCount = 0;
  }

  init(imgElement, fallbackElement) {
    this._imgEl = imgElement;
    this._fallbackEl = fallbackElement;
  }

  async update({ current_point, heading }) {
    this._currentHeading = heading;
    const { lat, lon } = current_point;

    const cacheKey = `${lat.toFixed(4)},${lon.toFixed(4)}`;

    let img = this._cache.get(cacheKey);
    if (!img) {
      img = await fetchKartaView(lat, lon)
           || await fetchMapillary(lat, lon, heading);
      if (img) this._cache.set(cacheKey, img);
    }

    if (img) {
      this._noImageCount = 0;
      this._imgEl.src = img.url;
      this._imgEl.style.display = 'block';
      if (this._fallbackEl) this._fallbackEl.classList.add('hidden');

      // Prefetch frame successivo
      const nextLat = lat + 0.0001;
      const nextKey = `${nextLat.toFixed(4)},${lon.toFixed(4)}`;
      if (!this._cache.has(nextKey)) {
        fetchKartaView(nextLat, lon).then(ni => {
          if (ni) this._cache.set(nextKey, ni);
        });
      }
    } else {
      this._noImageCount++;
      if (this._noImageCount >= 3) {
        this._imgEl.style.display = 'none';
        if (this._fallbackEl) this._fallbackEl.classList.remove('hidden');
      }
    }

    // Pulizia cache (max 50 entry)
    if (this._cache.size > 50) {
      const firstKey = this._cache.keys().next().value;
      this._cache.delete(firstKey);
    }
  }
}

export default StreetView;

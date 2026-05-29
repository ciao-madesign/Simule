// Vista road: KartaView + Mapillary fallback
import debug from './debug.js';
import store from './store.js';

// KartaView ha rinominato il dominio (ex OpenStreetCam)
const KARTAVIEW_URLS = [
  'https://api.kartaview.org/2.0/photo/',
  'https://api.openstreetcam.org/2.0/photo/'
];
const MAPILLARY_URL = 'https://graph.mapillary.com/images';

function angleDiff(a, b) {
  return Math.abs(((a - b) + 180) % 360 - 180);
}

async function fetchKartaView(lat, lon) {
  for (const baseUrl of KARTAVIEW_URLS) {
    try {
      const url = `${baseUrl}?lat=${lat}&lng=${lon}&radius=0.05`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) continue;
      const data = await resp.json();
      const photos = data?.result?.data;
      if (!photos?.length) continue;

      // Preferisce foto con thumbUri o fileurlProc
      const photo = photos[0];
      const imgUrl = photo.fileurlProc || photo.fileurl || photo.thumbUri;
      if (!imgUrl) continue;

      return {
        url: imgUrl,
        heading: parseFloat(photo.heading) || 0,
        source: 'kartaview'
      };
    } catch { continue; }
  }
  return null;
}

async function fetchMapillary(lat, lon, heading) {
  const token = store.prefs.mapillary_token;
  if (!token) return null;
  try {
    const bbox = `${lon - 0.0004},${lat - 0.0004},${lon + 0.0004},${lat + 0.0004}`;
    const url = `${MAPILLARY_URL}?fields=id,geometry,thumb_1024_url,computed_compass_angle&bbox=${bbox}&limit=10&access_token=${token}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data.data?.length) return null;

    // Sceglie l'immagine con heading più vicino alla direzione di marcia
    let best = null, bestScore = Infinity;
    for (const img of data.data) {
      const score = heading !== undefined
        ? angleDiff(img.computed_compass_angle || 0, heading)
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
    const img = await fetchKartaView(pt.lat, pt.lon)
               || await fetchMapillary(pt.lat, pt.lon);
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
    this._noImgEl = null;
    this._cache = new Map();
    this._noImageStreak = 0;
  }

  init(imgElement, noImgElement) {
    this._imgEl = imgElement;
    this._noImgEl = noImgElement;
  }

  async update({ current_point, heading }) {
    const { lat, lon } = current_point;
    const cacheKey = `${lat.toFixed(4)},${lon.toFixed(4)}`;

    let img = this._cache.get(cacheKey);
    if (img === undefined) {
      // undefined = non ancora cercato; null = cercato e non trovato
      img = await fetchKartaView(lat, lon)
            || await fetchMapillary(lat, lon, heading)
            || null;
      this._cache.set(cacheKey, img);
    }

    if (img) {
      this._noImageStreak = 0;
      this._imgEl.src = img.url;
      this._imgEl.style.display = 'block';
      this._noImgEl?.classList.add('hidden');

      // Prefetch prossima posizione
      const nextLat = lat + 0.00015 * Math.cos(heading * Math.PI / 180);
      const nextLon = lon + 0.00015 * Math.sin(heading * Math.PI / 180);
      const nextKey = `${nextLat.toFixed(4)},${nextLon.toFixed(4)}`;
      if (!this._cache.has(nextKey)) {
        this._cache.set(nextKey, undefined);
        fetchKartaView(nextLat, nextLon).then(ni => {
          this._cache.set(nextKey, ni || null);
        });
      }
    } else {
      this._noImageStreak++;
      if (this._noImageStreak >= 2) {
        this._imgEl.style.display = 'none';
        this._noImgEl?.classList.remove('hidden');
      }
    }

    // Pulizia cache
    if (this._cache.size > 80) {
      const first = this._cache.keys().next().value;
      this._cache.delete(first);
    }
  }
}

export default StreetView;

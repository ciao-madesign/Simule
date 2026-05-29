// Parsing GPX → array punti normalizzati
import debug from './debug.js';

const GRADE_WINDOW_M = 50;

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(Δφ/2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function interpolateElevation(points) {
  // Colma le quote mancanti con interpolazione lineare tra punti noti
  let lastKnownIdx = -1;
  for (let i = 0; i < points.length; i++) {
    if (points[i].ele !== null) {
      if (lastKnownIdx >= 0 && i - lastKnownIdx > 1) {
        const startEle = points[lastKnownIdx].ele;
        const endEle = points[i].ele;
        const steps = i - lastKnownIdx;
        for (let j = lastKnownIdx + 1; j < i; j++) {
          const t = (j - lastKnownIdx) / steps;
          points[j].ele = startEle + (endEle - startEle) * t;
        }
      }
      lastKnownIdx = i;
    }
  }
  // Punti residui senza elevazione → 0
  for (const pt of points) {
    if (pt.ele === null) pt.ele = 0;
  }
}

function smoothGrades(points) {
  // Finestra mobile 50m per smussare il rumore GPS nelle pendenze
  for (let i = 0; i < points.length; i++) {
    const distA = Math.max(0, points[i].dist_from_start - GRADE_WINDOW_M / 2);
    const distB = points[i].dist_from_start + GRADE_WINDOW_M / 2;

    let ptA = points[0], ptB = points[points.length - 1];
    for (const p of points) {
      if (p.dist_from_start <= distA) ptA = p;
      if (p.dist_from_start >= distB) { ptB = p; break; }
    }

    const hDist = Math.max(ptB.dist_from_start - ptA.dist_from_start, 1);
    const grade = ((ptB.ele - ptA.ele) / hDist) * 100;
    points[i].grade = Math.max(-40, Math.min(40, grade));
  }
}

async function fetchElevation(points) {
  // Fallback Open-Elevation per GPX senza quota
  const CHUNK = 100;
  debug.log('Fetching elevazione da Open-Elevation...');
  for (let i = 0; i < points.length; i += CHUNK) {
    const chunk = points.slice(i, i + CHUNK);
    const locations = chunk.map(p => ({ latitude: p.lat, longitude: p.lon }));
    try {
      const resp = await fetch('https://api.open-elevation.com/api/v1/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locations })
      });
      if (!resp.ok) throw new Error('Open-Elevation ' + resp.status);
      const data = await resp.json();
      data.results.forEach((r, j) => { chunk[j].ele = r.elevation; });
    } catch (e) {
      debug.warn('Open-Elevation fallback fallito:', e);
      chunk.forEach(p => { if (p.ele === null) p.ele = 0; });
    }
  }
}

export async function parseGPX(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const result = await _parse(e.target.result);
        resolve(result);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error('Impossibile leggere il file'));
    reader.readAsText(file);
  });
}

export async function parseGPXString(text) {
  return _parse(text);
}

// ---- Multi-format support ----

function rawPointsToGPX(raw) {
  const trkpts = raw
    .filter(p => !isNaN(p.lat) && !isNaN(p.lon))
    .map(p => `<trkpt lat="${p.lat}" lon="${p.lon}">${p.ele != null && !isNaN(p.ele) ? `<ele>${p.ele}</ele>` : ''}</trkpt>`)
    .join('');
  return `<?xml version="1.0"?><gpx version="1.1"><trk><trkseg>${trkpts}</trkseg></trk></gpx>`;
}

function tcxToGPX(xmlStr) {
  const doc = new DOMParser().parseFromString(xmlStr, 'text/xml');
  const raw = Array.from(doc.querySelectorAll('Trackpoint')).map(tp => ({
    lat: parseFloat(tp.querySelector('LatitudeDegrees')?.textContent),
    lon: parseFloat(tp.querySelector('LongitudeDegrees')?.textContent),
    ele: parseFloat(tp.querySelector('AltitudeMeters')?.textContent) || null
  }));
  if (!raw.filter(p => !isNaN(p.lat)).length) throw new Error('Nessun punto trovato nel file TCX');
  return rawPointsToGPX(raw);
}

function kmlToGPX(xmlStr) {
  const doc = new DOMParser().parseFromString(xmlStr, 'text/xml');
  const raw = [];
  doc.querySelectorAll('coordinates').forEach(el => {
    el.textContent.trim().split(/\s+/).forEach(pt => {
      const [lonS, latS, eleS] = pt.split(',');
      const lat = parseFloat(latS), lon = parseFloat(lonS), ele = parseFloat(eleS);
      if (!isNaN(lat) && !isNaN(lon)) raw.push({ lat, lon, ele: isNaN(ele) ? null : ele });
    });
  });
  if (!raw.length) throw new Error('Nessun punto trovato nel file KML');
  return rawPointsToGPX(raw);
}

export async function parseRouteText(text) {
  let gpxStr;
  if (text.includes('<TrainingCenterDatabase')) gpxStr = tcxToGPX(text);
  else if (text.trimStart().startsWith('<kml') || text.includes('opengis.net/kml')) gpxStr = kmlToGPX(text);
  else gpxStr = text;
  return _parse(gpxStr);
}

export async function loadRouteFromURL(url) {
  debug.log('Caricamento da URL:', url);
  const tryFetch = async (fetchUrl) => {
    const resp = await fetch(fetchUrl, { signal: AbortSignal.timeout(12000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.text();
  };
  let text;
  try {
    text = await tryFetch(url);
  } catch (e) {
    debug.log('Fetch diretto fallito —', e.message, '— provo corsproxy.io');
    try {
      text = await tryFetch(`https://corsproxy.io/?${encodeURIComponent(url)}`);
    } catch {
      throw new Error('Impossibile scaricare il file: errore CORS o rete. Scarica il file e caricalo direttamente.');
    }
  }
  return parseRouteText(text);
}

async function _parse(text) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('XML non valido');
  } catch (e) {
    throw new Error('File GPX malformato: ' + e.message);
  }

  // Raccogli tutti i trkpt da tutti i trkseg
  const trkpts = Array.from(doc.querySelectorAll('trkpt'));
  if (trkpts.length < 2) throw new Error('Il file GPX non contiene un tracciato valido');

  debug.log(`Trovati ${trkpts.length} punti GPX`);

  // Struttura raw
  let raw = trkpts.map(pt => {
    const lat = parseFloat(pt.getAttribute('lat'));
    const lon = parseFloat(pt.getAttribute('lon'));
    const eleEl = pt.querySelector('ele');
    const timeEl = pt.querySelector('time');
    const ele = eleEl ? parseFloat(eleEl.textContent) : null;
    const ts = timeEl ? new Date(timeEl.textContent).getTime() : null;
    return { lat, lon, ele, timestamp: ts };
  }).filter(p => !isNaN(p.lat) && !isNaN(p.lon));

  // Deduplicazione punti identici
  raw = raw.filter((p, i) => {
    if (i === 0) return true;
    return p.lat !== raw[i-1].lat || p.lon !== raw[i-1].lon;
  });

  if (raw.length < 2) throw new Error('Tracciato troppo breve dopo la deduplicazione');

  // Calcola distanza progressiva
  let cumDist = 0;
  const points = raw.map((p, i) => {
    if (i > 0) {
      cumDist += haversineDistance(raw[i-1].lat, raw[i-1].lon, p.lat, p.lon);
    }
    return { ...p, dist_from_start: cumDist, grade: 0 };
  });

  // Gestione elevazione mancante
  const missingEle = points.some(p => p.ele === null);
  if (missingEle) {
    interpolateElevation(points);
    const stillMissing = points.some(p => p.ele === null || p.ele === 0);
    if (stillMissing) {
      try { await fetchElevation(points); } catch { /* fallback già applicato */ }
    }
  }

  interpolateElevation(points);
  smoothGrades(points);

  debug.log(`Parsing completato: ${points.length} punti, ${(cumDist/1000).toFixed(2)} km`);
  return points;
}

export function computeRouteMeta(points, filename) {
  const totalDist = points[points.length - 1].dist_from_start;
  let elevGain = 0, elevLoss = 0;
  for (let i = 1; i < points.length; i++) {
    const diff = points[i].ele - points[i-1].ele;
    if (diff > 0) elevGain += diff;
    else elevLoss += Math.abs(diff);
  }
  const eles = points.map(p => p.ele);
  const maxEle = Math.max(...eles);
  const grades = points.map(p => Math.abs(p.grade));
  const maxGrade = Math.max(...grades);
  const avgGrade = grades.reduce((a, b) => a + b, 0) / grades.length;

  return {
    name: filename ? filename.replace(/\.gpx$/i, '') : 'Percorso',
    distance_km: totalDist / 1000,
    elevation_gain: Math.round(elevGain),
    elevation_loss: Math.round(elevLoss),
    max_elevation: Math.round(maxEle),
    max_grade: parseFloat(maxGrade.toFixed(1)),
    avg_grade: parseFloat(avgGrade.toFixed(1))
  };
}

// Classifica road vs offroad tramite OSM Overpass API
import debug from './debug.js';

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const ROAD_TYPES = new Set([
  'primary','secondary','tertiary','residential','service',
  'pedestrian','living_street','unclassified','trunk','motorway'
]);
const OFFROAD_TYPES = new Set([
  'footway','path','track','bridleway','steps','cycleway'
]);
const SAMPLE_INTERVAL_M = 500;
const TIMEOUT_MS = 8000;

async function classifyPoint(lat, lon) {
  const radius = 25;
  const query = `[out:json][timeout:6];
way(around:${radius},${lat},${lon})[highway];
out tags 1;`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch(OVERPASS_URL, {
      method: 'POST',
      body: 'data=' + encodeURIComponent(query),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data.elements?.length) return null;
    const hw = data.elements[0].tags?.highway;
    if (ROAD_TYPES.has(hw)) return 'road';
    if (OFFROAD_TYPES.has(hw)) return 'offroad';
    return null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

export async function classifyRoute(points) {
  const totalDist = points[points.length - 1].dist_from_start;
  const samples = [];

  // Campiona 1 punto ogni SAMPLE_INTERVAL_M
  for (let d = 0; d <= totalDist; d += SAMPLE_INTERVAL_M) {
    const idx = points.findIndex(p => p.dist_from_start >= d);
    if (idx >= 0) samples.push(points[idx]);
  }
  if (samples.length === 0) samples.push(points[Math.floor(points.length / 2)]);

  debug.log(`Classificazione percorso: ${samples.length} campioni`);

  // Limita a max 8 richieste Overpass per non sovraccaricare
  const toQuery = samples.slice(0, 8);
  const results = await Promise.allSettled(
    toQuery.map(pt => classifyPoint(pt.lat, pt.lon))
  );

  const classifications = results.map(r => r.status === 'fulfilled' ? r.value : null);
  const roadCount = classifications.filter(c => c === 'road').length;
  const offCount = classifications.filter(c => c === 'offroad').length;
  const totalKnown = roadCount + offCount;

  debug.log(`Classificazione: ${roadCount} road, ${offCount} offroad, ${classifications.filter(c=>!c).length} sconosciuto`);

  let mode;
  if (totalKnown === 0) {
    mode = 'road'; // fallback a road: percorsi urbani sono più comuni
  } else {
    mode = (roadCount / totalKnown) >= 0.7 ? 'road' : 'offroad';
  }

  const confidence = totalKnown > 0 ? Math.max(roadCount, offCount) / totalKnown : 0.5;

  // Costruisce array segmenti per colorare la mappa
  const segments = buildSegments(points, classifications, samples);

  return { mode, confidence: parseFloat(confidence.toFixed(2)), segments };
}

function buildSegments(points, classifications, samples) {
  const segments = [];
  let currentType = null;
  let segStart = 0;

  for (let i = 0; i < samples.length; i++) {
    const type = classifications[i] || currentType || 'offroad';
    if (type !== currentType) {
      if (currentType !== null) {
        const endDist = samples[i].dist_from_start;
        segments.push({ type: currentType, start_dist: segStart, end_dist: endDist });
      }
      currentType = type;
      segStart = samples[i].dist_from_start;
    }
  }
  if (currentType) {
    segments.push({
      type: currentType,
      start_dist: segStart,
      end_dist: points[points.length - 1].dist_from_start
    });
  }

  return segments;
}

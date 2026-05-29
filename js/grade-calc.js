// Calcolo pendenza istantanea con finestra mobile e lookahead
import debug from './debug.js';

function interpolateAtDist(points, dist) {
  if (dist <= 0) return points[0];
  if (dist >= points[points.length - 1].dist_from_start) return points[points.length - 1];

  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].dist_from_start <= dist) lo = mid;
    else hi = mid;
  }
  const a = points[lo], b = points[hi];
  const span = b.dist_from_start - a.dist_from_start;
  if (span === 0) return a;
  const t = (dist - a.dist_from_start) / span;
  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lon: a.lon + (b.lon - a.lon) * t,
    ele: a.ele + (b.ele - a.ele) * t,
    dist_from_start: dist
  };
}

export function gradeAt(points, currentDist, windowM = 50) {
  const distA = Math.max(0, currentDist - windowM / 2);
  const distB = Math.min(points[points.length - 1].dist_from_start, currentDist + windowM / 2);

  const ptA = interpolateAtDist(points, distA);
  const ptB = interpolateAtDist(points, distB);

  const hDist = Math.max(ptB.dist_from_start - ptA.dist_from_start, 1);
  const grade = ((ptB.ele - ptA.ele) / hDist) * 100;
  return Math.max(-40, Math.min(40, grade));
}

export function lookaheadGrade(points, currentDist, scanDist = 1000, threshold = 8) {
  const totalDist = points[points.length - 1].dist_from_start;
  const step = 25;
  let inSection = false;
  let sectionStart = null;
  let sectionGrades = [];

  for (let d = currentDist + step; d <= Math.min(currentDist + scanDist, totalDist); d += step) {
    const g = gradeAt(points, d, 50);
    if (g >= threshold) {
      if (!inSection) {
        inSection = true;
        sectionStart = d;
        sectionGrades = [];
      }
      sectionGrades.push(g);
    } else {
      if (inSection && sectionGrades.length >= 2) {
        const avgGrade = sectionGrades.reduce((a, b) => a + b, 0) / sectionGrades.length;
        return {
          grade: parseFloat(avgGrade.toFixed(1)),
          dist_from_here: Math.round(sectionStart - currentDist)
        };
      }
      inSection = false;
      sectionGrades = [];
    }
  }

  if (inSection && sectionGrades.length >= 2) {
    const avgGrade = sectionGrades.reduce((a, b) => a + b, 0) / sectionGrades.length;
    return {
      grade: parseFloat(avgGrade.toFixed(1)),
      dist_from_here: Math.round(sectionStart - currentDist)
    };
  }

  return null;
}

export function buildElevationProfile(points, windowStart, windowM = 5000) {
  // Restituisce array di { dist, ele } per il profilo altimetrico
  const end = Math.min(points[points.length - 1].dist_from_start, windowStart + windowM);
  const samples = 120;
  const step = (end - windowStart) / samples;
  const profile = [];
  for (let i = 0; i <= samples; i++) {
    const d = windowStart + i * step;
    const pt = interpolateAtDist(points, d);
    profile.push({ dist: d, ele: pt.ele });
  }
  return profile;
}

export { interpolateAtDist };

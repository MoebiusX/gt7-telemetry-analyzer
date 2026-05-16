// Telemetry metadata helpers: carCode lookup, track fingerprinting, session type.
//
// The GT7 telemetry packet carries carCode directly but no track name and no
// session-type field. This module:
//   - resolves carCode to a human-readable name from data/cars.json
//   - fingerprints a track from accumulated position bounds + estimated lap
//     distance, matches against data/tracks.json, and auto-registers unknowns
//   - infers session type from lapsInRace / totalCars
//
// Files are re-read on each lookup so editing cars.json / tracks.json takes
// effect without restarting capture.

const fs   = require('node:fs');
const path = require('node:path');

const DATA_DIR    = path.resolve(__dirname, '..', '..', 'data');
const CARS_PATH   = path.join(DATA_DIR, 'cars.json');
const TRACKS_PATH = path.join(DATA_DIR, 'tracks.json');

function loadCars() {
  try {
    const raw = JSON.parse(fs.readFileSync(CARS_PATH, 'utf8'));
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith('_')) continue;
      out[k] = v;
    }
    return out;
  } catch { return {}; }
}

function loadTracks() {
  try {
    const raw = JSON.parse(fs.readFileSync(TRACKS_PATH, 'utf8'));
    return {
      tolerance: raw.tolerance || { boundsM: 150, lapDistancePct: 8 },
      tracks:    raw.tracks    || [],
    };
  } catch {
    return { tolerance: { boundsM: 150, lapDistancePct: 8 }, tracks: [] };
  }
}

function lookupCar(carCode) {
  if (!carCode) return null;
  return loadCars()[String(carCode)] || null;
}

// Best-effort heuristic. GT7's packet doesn't actually tell us "this is qualifying."
function detectSessionType(p) {
  if (!p || p.lapsInRace == null || p.totalCars == null) return 'unknown';
  if (p.lapsInRace === 0 || p.lapsInRace > 50)            return 'qualifying';
  if (p.totalCars > 1)                                    return 'race';
  return 'time-trial';
}

class Fingerprinter {
  constructor() {
    this.xMin = Infinity; this.xMax = -Infinity;
    this.yMin = Infinity; this.yMax = -Infinity;
    this.zMin = Infinity; this.zMax = -Infinity;
    this.samples = 0;
    this.speedSum = 0;
    this.movingSamples = 0;
    this.bestLapMs = 0;
  }
  accumulate(p) {
    const pos = p?.position;
    if (!pos) return;
    if (Number.isFinite(pos.x)) { if (pos.x < this.xMin) this.xMin = pos.x; if (pos.x > this.xMax) this.xMax = pos.x; }
    if (Number.isFinite(pos.y)) { if (pos.y < this.yMin) this.yMin = pos.y; if (pos.y > this.yMax) this.yMax = pos.y; }
    if (Number.isFinite(pos.z)) { if (pos.z < this.zMin) this.zMin = pos.z; if (pos.z > this.zMax) this.zMax = pos.z; }
    if (Number.isFinite(p.speedKph)) {
      this.samples++;
      // Only count "moving" samples for the average that drives lap-distance
      // estimation — pit/grid/idle at <30 km/h drags the mean down enough to
      // produce a lap-distance estimate ~40% short of reality.
      if (p.speedKph > 30) {
        this.speedSum += p.speedKph;
        this.movingSamples++;
      }
    }
    if (p.bestLapTimeMs > 0 && (this.bestLapMs === 0 || p.bestLapTimeMs < this.bestLapMs)) {
      this.bestLapMs = p.bestLapTimeMs;
    }
  }
  // Ready once we've seen at least ~30s of telemetry AND one full lap clocked.
  ready() {
    return this.samples > 1800 && this.bestLapMs > 0;
  }
  fingerprint() {
    const avgKph = this.movingSamples ? this.speedSum / this.movingSamples : 0;
    const lapDistM = this.bestLapMs > 0
      ? Math.round((avgKph / 3.6) * (this.bestLapMs / 1000))
      : 0;
    return {
      bounds: {
        xMin: Math.round(this.xMin), xMax: Math.round(this.xMax),
        yMin: Math.round(this.yMin), yMax: Math.round(this.yMax),
        zMin: Math.round(this.zMin), zMax: Math.round(this.zMax),
      },
      lapDistanceM: lapDistM,
      bestLapMs:    this.bestLapMs,
      avgSpeedKph:  Math.round(avgKph),
      samples:      this.samples,
    };
  }
}

function matchTrack(fp) {
  if (!fp || !fp.bounds) return null;
  const { tolerance, tracks } = loadTracks();
  const tol = tolerance.boundsM;
  const lapPct = tolerance.lapDistancePct / 100;
  for (const t of tracks) {
    if (!t.bounds) continue;
    const b = t.bounds;
    const boundsOk =
      Math.abs(fp.bounds.xMin - b.xMin) < tol &&
      Math.abs(fp.bounds.xMax - b.xMax) < tol &&
      Math.abs(fp.bounds.zMin - b.zMin) < tol &&
      Math.abs(fp.bounds.zMax - b.zMax) < tol;
    const lapOk = fp.lapDistanceM > 0 && t.lapDistanceM > 0
      ? Math.abs(fp.lapDistanceM - t.lapDistanceM) / t.lapDistanceM < lapPct
      : false;
    if (boundsOk && lapOk) return t;
  }
  return null;
}

function registerUnknownTrack(fp) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(TRACKS_PATH, 'utf8')); }
  catch { raw = { tolerance: { boundsM: 150, lapDistancePct: 8 }, tracks: [] }; }
  raw.tracks = raw.tracks || [];
  const id = `unknown-${Date.now()}`;
  const entry = {
    id,
    name: `Unknown track (rename me) - lap ${fp.lapDistanceM}m`,
    bounds: fp.bounds,
    lapDistanceM: fp.lapDistanceM,
    _addedAt: new Date().toISOString(),
    _samples: fp.samples,
  };
  raw.tracks.push(entry);
  fs.writeFileSync(TRACKS_PATH, JSON.stringify(raw, null, 2) + '\n');
  return entry;
}

module.exports = {
  lookupCar,
  detectSessionType,
  Fingerprinter,
  matchTrack,
  registerUnknownTrack,
};

// Ghost lap store.
//
// A "ghost" is a saved lap trace pinned for comparison on /track.
// Stored as data/ghost.json:
//   {
//     label, sourceFile, lapNumber, completedMs, carCode, trackId,
//     trace: [{ t, x, z, speedKph, throttle, brake, gear }, ...]
//   }
// The trace is sampled at ~50ms (20Hz), same cadence as the live PB trace.

const fs   = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const DATA_DIR = path.resolve(__dirname, '..', '..', 'data');
const GHOST_FILE = path.join(DATA_DIR, 'ghost.json');
const RECORD_DIR = path.resolve(__dirname, '..', '..', 'recordings');

let cache = null;
let cacheMTime = 0;

function load() {
  try {
    const stat = fs.statSync(GHOST_FILE);
    if (cache && stat.mtimeMs === cacheMTime) return cache;
    cache = JSON.parse(fs.readFileSync(GHOST_FILE, 'utf8'));
    cacheMTime = stat.mtimeMs;
    return cache;
  } catch (e) {
    cache = null;
    return null;
  }
}

function clear() {
  try { fs.unlinkSync(GHOST_FILE); } catch {}
  cache = null;
}

// Extract a specific lap's trace from a recording file.
// Match strategy:
//   - by carCode + lapNumber (must be unique within file) — exact
//   - by carCode + nearest completedMs to a target — fuzzy
async function extractLapFromFile({ file, carCode, lapNumber, targetCompletedMs }) {
  const fullPath = path.isAbsolute(file) ? file : path.join(RECORD_DIR, file);
  if (!fs.existsSync(fullPath)) throw new Error(`recording not found: ${fullPath}`);

  const stream = fs.createReadStream(fullPath);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const packets = [];
  const carCounts = new Map();
  for await (const line of rl) {
    try {
      const p = JSON.parse(line);
      if (p.type === 'config' || !p.position || typeof p.lapCount !== 'number') continue;
      if (p.carCode) carCounts.set(p.carCode, (carCounts.get(p.carCode)||0)+1);
      packets.push({
        t: p.t, lap: p.lapCount, lastMs: p.lastLapTimeMs,
        carCode: p.carCode,
        x: p.position.x, z: p.position.z,
        speedKph: p.speedKph,
        throttle: p.throttle, brake: p.brake, gear: p.currentGear,
      });
    } catch {}
  }
  rl.close();

  let cc = carCode;
  if (cc == null) {
    let max = 0;
    for (const [k, n] of carCounts) if (n > max) { max = n; cc = k; }
  }
  const filtered = packets.filter(p => p.carCode === cc);

  // Slice
  const laps = [];
  let cs = 0;
  for (let i = 1; i < filtered.length; i++) {
    if (filtered[i].lap !== filtered[i-1].lap) {
      const c = filtered[i].lastMs;
      const wallMs = filtered[i-1].t - filtered[cs].t;
      if (typeof c === 'number' && c > 30000 && c < 600000 && wallMs > c * 0.85) {
        laps.push({ num: filtered[i-1].lap, startIdx: cs, endIdx: i-1, completedMs: c });
      }
      cs = i;
    }
  }

  let pick = null;
  if (lapNumber != null) {
    pick = laps.find(l => l.num === Number(lapNumber));
  } else if (targetCompletedMs != null) {
    let best = null, bestDiff = Infinity;
    for (const l of laps) {
      const diff = Math.abs(l.completedMs - targetCompletedMs);
      if (diff < bestDiff) { best = l; bestDiff = diff; }
    }
    pick = best;
  } else {
    // Default: fastest valid lap in the file
    let best = null;
    for (const l of laps) if (!best || l.completedMs < best.completedMs) best = l;
    pick = best;
  }
  if (!pick) throw new Error('no matching lap found');

  // Sample at ~50ms cadence
  const trace = [];
  let nextT = 0;
  const startT = filtered[pick.startIdx].t;
  for (let i = pick.startIdx; i <= pick.endIdx; i++) {
    const el = filtered[i].t - startT;
    if (el >= nextT) {
      trace.push({
        t: el,
        x: filtered[i].x, z: filtered[i].z,
        speedKph: filtered[i].speedKph,
        throttle: filtered[i].throttle, brake: filtered[i].brake, gear: filtered[i].gear,
      });
      nextT = el + 50;
    }
  }
  return {
    sourceFile: path.basename(fullPath),
    carCode: cc,
    lapNumber: pick.num,
    completedMs: pick.completedMs,
    trace,
    candidates: laps.length,
  };
}

function set(record) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(GHOST_FILE, JSON.stringify(record, null, 2) + '\n');
  cache = record;
  cacheMTime = fs.statSync(GHOST_FILE).mtimeMs;
}

module.exports = { load, set, clear, extractLapFromFile, GHOST_FILE };

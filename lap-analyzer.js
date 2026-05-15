// Lap analyzer — streams today's recording, slices into laps, computes
// per-sector splits and identifies the PB. Caches the result with a short
// TTL so HTTP endpoints can call it on every request without thrashing.

const fs   = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const driverStore = require('./driver-store');
const ghostStore  = require('./ghost-store');

const RECORD_DIR = path.resolve(__dirname, 'recordings');
const TTL_MS = 30_000; // re-analyze at most every 30s

// Cache keyed by (file, driver-id, ghost-completed-ms) so switching either
// invalidates results.
let cache = { ts: 0, key: null, result: null, inflight: null };

function todayFile() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return path.join(RECORD_DIR, `gt7-${y}-${m}-${dd}.jsonl`);
}

async function analyze(file, activeDriverId) {
  const carCounts = new Map();
  const packets = [];
  const stream = fs.createReadStream(file);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    try {
      const p = JSON.parse(line);
      if (p.type === 'config' || !p.position || typeof p.lapCount !== 'number') continue;
      // Driver filter: keep packets that match the active driver, OR have no
      // driver tag (legacy recordings — assume default Player 1 profile).
      if (activeDriverId && p.driver && p.driver !== activeDriverId) continue;
      if (p.carCode) carCounts.set(p.carCode, (carCounts.get(p.carCode) || 0) + 1);
      packets.push({
        t: p.t, lap: p.lapCount, lastMs: p.lastLapTimeMs,
        carCode: p.carCode, x: p.position.x, z: p.position.z,
        speedKph: p.speedKph, throttle: p.throttle, brake: p.brake, gear: p.currentGear,
      });
    } catch {}
  }
  rl.close();

  let mainCar = null, maxN = 0;
  for (const [cc, n] of carCounts) if (n > maxN) { maxN = n; mainCar = cc; }
  const filtered = packets.filter(p => p.carCode === mainCar);

  // Slice into laps with wall-clock validation
  const candLaps = [];
  let cs = 0;
  for (let i = 1; i < filtered.length; i++) {
    if (filtered[i].lap !== filtered[i-1].lap) {
      const c = filtered[i].lastMs;
      const wallMs = filtered[i-1].t - filtered[cs].t;
      if (typeof c === 'number' && c > 30_000 && c < 600_000 && wallMs > c * 0.9) {
        candLaps.push({ num: filtered[i-1].lap, startIdx: cs, endIdx: i - 1, completedMs: c, startT: filtered[cs].t });
      }
      cs = i;
    }
  }
  // Exclude any lap whose time AND start/end XZ closely match the registered
  // ghost — those are replay-captured laps masquerading as user-driven.
  const ghost = ghostStore.load();
  let candAfterGhost = candLaps;
  if (ghost && ghost.completedMs && ghost.trace && ghost.trace.length > 0) {
    const gT = ghost.trace;
    const gStart = gT[0], gEnd = gT[gT.length - 1];
    candAfterGhost = candLaps.filter(l => {
      if (Math.abs(l.completedMs - ghost.completedMs) > 50) return true;
      const ls = filtered[l.startIdx], le = filtered[l.endIdx];
      const dStart = Math.hypot((ls.x - gStart.x), (ls.z - gStart.z));
      const dEnd   = Math.hypot((le.x - gEnd.x),   (le.z - gEnd.z));
      return !(dStart < 5 && dEnd < 5);
    });
  }
  // 5th-percentile anchor filter
  const sortedTimes = candAfterGhost.map(l => l.completedMs).sort((a,b)=>a-b);
  const anchor = sortedTimes[Math.max(0, Math.floor(sortedTimes.length * 0.05))] || 0;
  const laps = candAfterGhost.filter(l => !anchor || (l.completedMs >= anchor * 0.97 && l.completedMs <= anchor * 1.30));

  if (laps.length === 0) {
    return { mainCar, laps: [], pbMs: null, theoreticalMs: null, pbTrace: null, sectorBoundaries: null };
  }

  // PB
  let pbMs = Infinity;
  for (const l of laps) if (l.completedMs < pbMs) pbMs = l.completedMs;
  const pb = laps.find(l => l.completedMs === pbMs);

  // PB trace (20Hz)
  const pbStartT = filtered[pb.startIdx].t;
  const pbTrace = [];
  let nextT = 0;
  for (let i = pb.startIdx; i <= pb.endIdx; i++) {
    const el = filtered[i].t - pbStartT;
    if (el >= nextT) {
      pbTrace.push({
        t: el, x: filtered[i].x, z: filtered[i].z,
        speedKph: filtered[i].speedKph, throttle: filtered[i].throttle, brake: filtered[i].brake, gear: filtered[i].gear,
      });
      nextT = el + 50;
    }
  }
  const s1EndIdx = Math.floor(pbTrace.length / 3);
  const s2EndIdx = Math.floor(2 * pbTrace.length / 3);

  function sectorsForLap(lap) {
    let lastMatchIdx = 0;
    let currentSector = 1;
    const enterTimes = [0, null, null];
    const startT = filtered[lap.startIdx].t;
    for (let i = lap.startIdx; i <= lap.endIdx; i++) {
      const cx = filtered[i].x, cz = filtered[i].z;
      const lo = Math.max(0, lastMatchIdx - 5);
      const hi = Math.min(pbTrace.length - 1, lastMatchIdx + 60);
      let bestIdx = -1, bestD2 = Infinity;
      for (let j = lo; j <= hi; j++) {
        const dx = pbTrace[j].x - cx, dz = pbTrace[j].z - cz;
        const d2 = dx*dx + dz*dz;
        if (d2 < bestD2) { bestD2 = d2; bestIdx = j; }
      }
      if (bestIdx === -1) continue;
      lastMatchIdx = bestIdx;
      let newSector = currentSector;
      if (bestIdx < s1EndIdx) newSector = 1;
      else if (bestIdx < s2EndIdx) newSector = 2;
      else newSector = 3;
      if (newSector === currentSector + 1) {
        enterTimes[newSector - 1] = filtered[i].t - startT;
        currentSector = newSector;
      }
    }
    if (enterTimes[1] == null || enterTimes[2] == null) return [null, null, null];
    const s1 = enterTimes[1];
    const s2 = enterTimes[2] - enterTimes[1];
    const s3 = lap.completedMs - enterTimes[2];
    if (s1 <= 0 || s2 <= 0 || s3 <= 0) return [null, null, null];
    return [s1, s2, s3];
  }

  // Micro-sectors: N equal-distance slices of the PB trace. For each lap,
  // walk packets forward and record the elapsed time at each boundary crossing.
  //
  // Critically, when a single packet's match crosses MULTIPLE μ-boundaries
  // (high N, fast straights), the time is *interpolated* across them using
  // the previous packet's match-position as the anchor — otherwise every
  // multi-crossed boundary inherits the same elapsed time and the resulting
  // per-μ times collapse to zero, producing an impossibly low theoretical sum.
  //
  // Returns an array of length N with the per-μ-sector durations (ms).
  function microSectorsForLap(lap, n) {
    if (n < 2) return null;
    const boundaries = []; // indices into pbTrace
    for (let k = 1; k <= n; k++) boundaries.push(Math.min(pbTrace.length - 1, Math.floor(pbTrace.length * k / n)));
    const crossings = new Array(n).fill(null); // elapsed-ms at each boundary
    const startT = filtered[lap.startIdx].t;
    let lastMatchIdx = 0;
    let prevMatchIdx = 0;
    let prevElapsed  = 0;
    let nextBoundary = 0;
    let firstPacket = true;
    for (let i = lap.startIdx; i <= lap.endIdx; i++) {
      const cx = filtered[i].x, cz = filtered[i].z;
      const elapsed = filtered[i].t - startT;
      const lo = Math.max(0, lastMatchIdx - 5);
      const hi = Math.min(pbTrace.length - 1, lastMatchIdx + 60);
      let bestIdx = -1, bestD2 = Infinity;
      for (let j = lo; j <= hi; j++) {
        const dx = pbTrace[j].x - cx, dz = pbTrace[j].z - cz;
        const d2 = dx*dx + dz*dz;
        if (d2 < bestD2) { bestD2 = d2; bestIdx = j; }
      }
      if (bestIdx === -1) continue;
      if (firstPacket) {
        prevMatchIdx = bestIdx;
        prevElapsed  = elapsed;
        firstPacket  = false;
        // continue — first packet anchors; no boundary check yet
        lastMatchIdx = bestIdx;
        continue;
      }
      lastMatchIdx = bestIdx;
      // For each boundary we've now crossed, interpolate the crossing time
      // linearly between the previous packet's matched index and this one's.
      while (nextBoundary < n && bestIdx >= boundaries[nextBoundary]) {
        const b = boundaries[nextBoundary];
        const span = Math.max(1, bestIdx - prevMatchIdx);
        const frac = Math.max(0, Math.min(1, (b - prevMatchIdx) / span));
        crossings[nextBoundary] = prevElapsed + frac * (elapsed - prevElapsed);
        nextBoundary++;
      }
      prevMatchIdx = bestIdx;
      prevElapsed  = elapsed;
    }
    // Per-micro-sector times = consecutive crossing differences (with 0 anchor)
    const times = [];
    let prev = 0;
    for (let k = 0; k < n; k++) {
      if (crossings[k] == null) { times.push(null); continue; }
      const dt = crossings[k] - prev;
      times.push(dt > 0 ? dt : null);
      prev = crossings[k];
    }
    return times;
  }

  // Build trace for any lap on demand (used by /track)
  function traceForLap(lap, stepMs = 50) {
    const arr = [];
    let nT = 0;
    const startT = filtered[lap.startIdx].t;
    for (let i = lap.startIdx; i <= lap.endIdx; i++) {
      const el = filtered[i].t - startT;
      if (el >= nT) {
        arr.push({ t: el, x: filtered[i].x, z: filtered[i].z });
        nT = el + stepMs;
      }
    }
    return arr;
  }

  // Sector splits for every lap; theoretical = sum of best across all
  const enriched = laps.map((l, idx) => {
    const sec = sectorsForLap(l);
    return {
      order: idx + 1,
      lapNum: l.num,
      startT: l.startT,
      completedMs: l.completedMs,
      s1: sec[0], s2: sec[1], s3: sec[2],
      isPb: l === pb,
      _lap: l, // internal — used for trace lookup
    };
  });

  // Theoretical best — only sane laps (within 70% of PB-equivalent sectors)
  const pbSec = enriched.find(e => e.isPb);
  let bestS1 = Infinity, bestS2 = Infinity, bestS3 = Infinity;
  let bestS1Order = null, bestS2Order = null, bestS3Order = null;
  for (const e of enriched) {
    if (e.s1 == null) continue;
    if (pbSec.s1 && (e.s1 < pbSec.s1 * 0.7 || e.s2 < pbSec.s2 * 0.7 || e.s3 < pbSec.s3 * 0.7)) continue;
    if (e.s1 < bestS1) { bestS1 = e.s1; bestS1Order = e.order; }
    if (e.s2 < bestS2) { bestS2 = e.s2; bestS2Order = e.order; }
    if (e.s3 < bestS3) { bestS3 = e.s3; bestS3Order = e.order; }
  }
  const theoreticalMs = (bestS1 + bestS2 + bestS3);

  return {
    mainCar,
    laps: enriched,
    pbMs,
    pbOrder: pbSec.order,
    theoreticalMs: isFinite(theoreticalMs) ? theoreticalMs : null,
    bestSectors: {
      s1: { ms: isFinite(bestS1) ? bestS1 : null, lapOrder: bestS1Order },
      s2: { ms: isFinite(bestS2) ? bestS2 : null, lapOrder: bestS2Order },
      s3: { ms: isFinite(bestS3) ? bestS3 : null, lapOrder: bestS3Order },
    },
    pbTrace, // public so /track can use it
    sectorBoundaries: {
      s1End: pbTrace[s1EndIdx],
      s2End: pbTrace[s2EndIdx],
    },
    traceForLap, // function bound to closure
    microSectorsForLap,
    _filtered: filtered,
  };
}

async function get({ force = false } = {}) {
  const file = todayFile();
  const driverId = driverStore.getActive().id;
  const ghost = ghostStore.load();
  const ghostKey = ghost ? `${ghost.completedMs}|${ghost.label}` : 'none';
  const key = `${file}|${driverId}|${ghostKey}`;
  const fresh = key === cache.key && cache.result && (Date.now() - cache.ts) < TTL_MS;
  if (!force && fresh) return cache.result;
  if (cache.inflight) return cache.inflight;
  cache.inflight = (async () => {
    try {
      if (!fs.existsSync(file)) {
        const empty = { mainCar: null, laps: [], pbMs: null, theoreticalMs: null, driverId };
        cache = { ts: Date.now(), key, result: empty, inflight: null };
        return empty;
      }
      const res = await analyze(file, driverId);
      res.driverId = driverId;
      cache = { ts: Date.now(), key, result: res, inflight: null };
      return res;
    } catch (e) {
      cache.inflight = null;
      throw e;
    }
  })();
  return cache.inflight;
}

module.exports = { get, todayFile };

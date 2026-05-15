#!/usr/bin/env node
// Compare a lap from a daily recording vs the WR for zones 4 and 6.
// Usage: node tools/lap-vs-wr.js [recording.jsonl] [cfgVersion]
// Defaults to today's recording, latest cfgV.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const RECORD_DIR = path.resolve(__dirname, '..', 'recordings');
const WR_FILE = path.join(RECORD_DIR, 'gt7-2026-05-06T17-14-57-957Z.jsonl');
const WR_TARGET_MS = 91933;

// CLI args
const argFile = process.argv[2];
const argCfgV = process.argv[3] ? Number(process.argv[3]) : null;

function todayLocal() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const targetFile = argFile
  ? path.resolve(argFile)
  : path.join(RECORD_DIR, `gt7-${todayLocal()}.jsonl`);

if (!fs.existsSync(targetFile)) {
  console.error(`File not found: ${targetFile}`);
  process.exit(1);
}

// --- read all packets from a file ---
async function readPackets(file) {
  const stream = fs.createReadStream(file);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const out = [];
  for await (const line of rl) {
    let p; try { p = JSON.parse(line); } catch { continue; }
    out.push(p);
  }
  return out;
}

// --- extract WR lap (reuse logic from wr-corners.js) ---
function extractWRLap(packets) {
  const PACKETS_PER_LAP = Math.round(WR_TARGET_MS / (1000/60));
  let prev = null;
  const ends = [];
  packets.forEach((p, i) => {
    if (p.type === 'config' || typeof p.lapCount !== 'number') return;
    if (prev && (p.lapCount !== prev.lapCount || p.lastLapTimeMs !== prev.lastLapTimeMs)) {
      if (p.lastLapTimeMs === WR_TARGET_MS) ends.push(i);
    }
    prev = p;
  });
  if (!ends.length) throw new Error('WR end not found');
  let endIdx = ends[ends.length - 1];
  let startIdx = endIdx - 1;
  while (startIdx > 0) {
    const a = packets[startIdx - 1], b = packets[startIdx];
    if (a.lapCount === 0 && b.lapCount === 1) break;
    startIdx--;
  }
  if (endIdx - startIdx < PACKETS_PER_LAP - 100 && ends.length > 1) {
    endIdx = ends[0];
    startIdx = endIdx - 1;
    while (startIdx > 0) {
      const a = packets[startIdx - 1], b = packets[startIdx];
      if (a.lapCount === 0 && b.lapCount === 1) break;
      startIdx--;
    }
  }
  return packets.slice(startIdx, endIdx);
}

// --- find best lap from a daily recording ---
function findBestLapInDaily(packets, cfgV) {
  // Group by complete-lap windows: between (lapCount→lapCount+1) transitions
  // Each transition's lastLapTimeMs is the just-completed lap.
  let prev = null;
  let curStart = null;
  const laps = [];
  packets.forEach((p, i) => {
    if (p.type === 'config' || typeof p.lapCount !== 'number') return;
    if (prev) {
      if (p.lapCount === prev.lapCount + 1 && p.lastLapTimeMs > 30_000 && p.lastLapTimeMs < 600_000) {
        // lap ended; lap was from curStart to i-1
        if (curStart !== null) {
          laps.push({
            startIdx: curStart,
            endIdx: i,
            lapTimeMs: p.lastLapTimeMs,
            lapCount: prev.lapCount,
            cfgV: packets[curStart].cfgV ?? null,
          });
        }
        curStart = i;
      } else if (p.lapCount !== prev.lapCount) {
        // any other lap transition — reset window
        curStart = i;
      }
    } else {
      curStart = i;
    }
    prev = p;
  });
  // Optional cfgV filter
  let filtered = cfgV != null ? laps.filter(l => l.cfgV === cfgV) : laps;
  if (!filtered.length) filtered = laps;
  filtered.sort((a, b) => a.lapTimeMs - b.lapTimeMs);
  return { laps: filtered, best: filtered[0] };
}

// --- cumulative XZ distance for a lap ---
function cumDist(slice) {
  const d = new Array(slice.length).fill(0);
  for (let i = 1; i < slice.length; i++) {
    const a = slice[i-1].position, b = slice[i].position;
    if (!a || !b) { d[i] = d[i-1]; continue; }
    const dx = b.x - a.x, dz = b.z - a.z;
    d[i] = d[i-1] + Math.sqrt(dx*dx + dz*dz);
  }
  return d;
}

// --- find brake zones (same algo as wr-corners.js) ---
function detectBrakeZones(slice) {
  const BRAKE_THRESH = 25;
  const MIN_LEN = 8;
  const zones = [];
  let i = 0;
  while (i < slice.length) {
    if (slice[i].brake > BRAKE_THRESH) {
      let j = i;
      while (j < slice.length && slice[j].brake > BRAKE_THRESH/2) j++;
      if (j - i >= MIN_LEN) {
        let minSpdIdx = i;
        const scanEnd = Math.min(slice.length-1, j-1 + 30);
        for (let k = i; k <= scanEnd; k++)
          if (slice[k].speedKph < slice[minSpdIdx].speedKph) minSpdIdx = k;
        let peak = 0;
        for (let k = i; k < j; k++) if (slice[k].brake > peak) peak = slice[k].brake;
        zones.push({ startIdx: i, endIdx: j-1, minSpdIdx, peakBrake: peak });
      }
      i = j;
    } else i++;
  }
  return zones;
}

// --- match a WR zone to a lap zone by spatial XZ proximity to apex ---
function matchByApex(wrApexX, wrApexZ, lapPackets, lapZones) {
  let best = null, bestDist = Infinity;
  for (const z of lapZones) {
    const ap = lapPackets[z.minSpdIdx].position;
    if (!ap) continue;
    const d = Math.hypot(ap.x - wrApexX, ap.z - wrApexZ);
    if (d < bestDist) { bestDist = d; best = z; }
  }
  return { zone: best, distance: bestDist };
}

(async () => {
  console.log(`Reading WR file…`);
  const wrPackets = await readPackets(WR_FILE);
  const wr = extractWRLap(wrPackets);
  const wrDist = cumDist(wr);
  const wrZones = detectBrakeZones(wr);

  console.log(`Reading lap file: ${path.basename(targetFile)}…`);
  const dailyPackets = await readPackets(targetFile);
  const { laps, best } = findBestLapInDaily(dailyPackets, argCfgV);

  if (!best) {
    console.error('No complete laps in this recording.');
    process.exit(1);
  }
  console.log(`\nFound ${laps.length} complete lap(s)${argCfgV != null ? ` at cfgV=${argCfgV}` : ''}. Best:`);
  console.log(`  lap ${best.lapCount}  time=${(best.lapTimeMs/1000).toFixed(3)}s  cfgV=${best.cfgV}`);
  console.log(`  WR=${(WR_TARGET_MS/1000).toFixed(3)}s  →  delta +${((best.lapTimeMs - WR_TARGET_MS)/1000).toFixed(3)}s\n`);

  const lap = dailyPackets.slice(best.startIdx, best.endIdx);
  const lapDist = cumDist(lap);
  const lapZones = detectBrakeZones(lap);

  // Compare zones 4 (idx 3) and 6 (idx 5) of WR
  const TARGETS = [
    { wrIdx: 3, label: 'ZONE 4 — VALLEY FLOOR (heaviest brake)' },
    { wrIdx: 5, label: 'ZONE 6 — PENULTIMATE LEFT' },
  ];

  for (const t of TARGETS) {
    const wz = wrZones[t.wrIdx];
    const wrApex = wr[wz.minSpdIdx];
    const wrEntry = wr[wz.startIdx];
    const m = matchByApex(wrApex.position.x, wrApex.position.z, lap, lapZones);
    if (!m.zone || m.distance > 80) {
      console.log(`\n${t.label}\n  ✗ no matching brake zone in lap (closest ${m.distance?.toFixed(1)}m away).`);
      continue;
    }
    const lz = m.zone;
    const lapApex = lap[lz.minSpdIdx];
    const lapEntry = lap[lz.startIdx];

    // Sector time: from brake-on to apex (ms via packet count @ 60Hz)
    const wrSecMs = (wz.minSpdIdx - wz.startIdx) * (1000/60);
    const lapSecMs = (lz.minSpdIdx - lz.startIdx) * (1000/60);

    // Mini-sector time: 100m before brake-on through 100m after apex
    function timeWindow(packets, distArr, centerIdx, beforeM, afterM) {
      const cd = distArr[centerIdx];
      let a = centerIdx, b = centerIdx;
      while (a > 0 && distArr[a] > cd - beforeM) a--;
      while (b < packets.length-1 && distArr[b] < cd + afterM) b++;
      return { a, b, ms: (b - a) * (1000/60), distM: distArr[b] - distArr[a] };
    }
    const W = timeWindow(wr, wrDist, wz.minSpdIdx, 150, 150);
    const L = timeWindow(lap, lapDist, lz.minSpdIdx, 150, 150);

    console.log(`\n${t.label}`);
    console.log(`  WR  apex (${wrApex.position.x.toFixed(0)}, ${wrApex.position.z.toFixed(0)})  Y=${wrApex.position.y.toFixed(1)}`);
    console.log(`  YOU apex (${lapApex.position.x.toFixed(0)}, ${lapApex.position.z.toFixed(0)})  Y=${lapApex.position.y.toFixed(1)}  (XZ off by ${m.distance.toFixed(1)}m)`);
    console.log(`                          WR        YOU       Δ`);
    console.log(`  Entry speed   :    ${wrEntry.speedKph.toFixed(1).padStart(6)}    ${lapEntry.speedKph.toFixed(1).padStart(6)}    ${(lapEntry.speedKph - wrEntry.speedKph).toFixed(1).padStart(6)} km/h`);
    console.log(`  Apex speed    :    ${wrApex.speedKph.toFixed(1).padStart(6)}    ${lapApex.speedKph.toFixed(1).padStart(6)}    ${(lapApex.speedKph - wrApex.speedKph).toFixed(1).padStart(6)} km/h`);
    console.log(`  Entry gear    :    ${String(wrEntry.currentGear).padStart(6)}    ${String(lapEntry.currentGear).padStart(6)}`);
    console.log(`  Apex gear     :    ${String(wrApex.currentGear).padStart(6)}    ${String(lapApex.currentGear).padStart(6)}`);
    console.log(`  Peak brake    :    ${(wz.peakBrake/255*100).toFixed(0).padStart(5)}%    ${(lz.peakBrake/255*100).toFixed(0).padStart(5)}%`);
    console.log(`  Brake→apex ms :    ${wrSecMs.toFixed(0).padStart(6)}    ${lapSecMs.toFixed(0).padStart(6)}    ${(lapSecMs - wrSecMs).toFixed(0).padStart(6)} ms`);
    console.log(`  ±150m window  :    ${W.ms.toFixed(0).padStart(6)}    ${L.ms.toFixed(0).padStart(6)}    ${(L.ms - W.ms).toFixed(0).padStart(6)} ms ← time lost in this corner`);
  }

  // Persist for future report.js integration
  const outPath = path.resolve(__dirname, 'lap-vs-wr.json');
  fs.writeFileSync(outPath, JSON.stringify({
    wrFile: path.basename(WR_FILE),
    wrLapMs: WR_TARGET_MS,
    lapFile: path.basename(targetFile),
    bestLap: best,
    deltaMs: best.lapTimeMs - WR_TARGET_MS,
  }, null, 2));
  console.log(`\nWritten ${outPath}`);
})();

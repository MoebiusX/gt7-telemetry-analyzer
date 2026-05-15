#!/usr/bin/env node
// Print every valid lap from the most recent recording, chronological order.
// Shows: order, GT7 lap#, completion time, delta to session PB, delta to
// previous lap, and (if available) sector splits.

const fs   = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const RECORD_DIR = path.resolve(__dirname, '..', 'recordings');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  return process.argv[i + 1];
}

(async () => {
  const FILE_ARG = arg('--file');
  let file;
  if (FILE_ARG) {
    file = path.isAbsolute(FILE_ARG) ? FILE_ARG : path.join(RECORD_DIR, FILE_ARG);
  } else {
    const files = fs.readdirSync(RECORD_DIR)
      .filter(f => /^gt7-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort();
    file = path.join(RECORD_DIR, files[files.length - 1]);
  }
  console.log(`Reading ${path.basename(file)} ...`);

  const packets = [];
  const carCounts = new Map();
  const stream = fs.createReadStream(file);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    try {
      const p = JSON.parse(line);
      if (p.type === 'config' || !p.position || typeof p.lapCount !== 'number') continue;
      if (p.carCode) carCounts.set(p.carCode, (carCounts.get(p.carCode) || 0) + 1);
      packets.push({
        t: p.t, lap: p.lapCount, lastMs: p.lastLapTimeMs,
        carCode: p.carCode,
        x: p.position.x, z: p.position.z,
      });
    } catch {}
  }
  rl.close();

  let mainCar = null, maxN = 0;
  for (const [cc, n] of carCounts) if (n > maxN) { maxN = n; mainCar = cc; }
  const filtered = packets.filter(p => p.carCode === mainCar);
  console.log(`Car ${mainCar}, ${filtered.length} packets`);

  // Slice into laps with wall-clock validation
  const laps = [];
  let cs = 0;
  for (let i = 1; i < filtered.length; i++) {
    if (filtered[i].lap !== filtered[i-1].lap) {
      const c = filtered[i].lastMs;
      const wallMs = filtered[i-1].t - filtered[cs].t;
      if (typeof c === 'number' && c > 30_000 && c < 600_000 && wallMs > c * 0.9) {
        laps.push({ num: filtered[i-1].lap, startIdx: cs, endIdx: i - 1, completedMs: c, startT: filtered[cs].t });
      }
      cs = i;
    }
  }
  // Anchor filter
  const sorted = laps.map(l => l.completedMs).sort((a,b) => a-b);
  const anchor = sorted[Math.max(0, Math.floor(sorted.length * 0.05))];
  const validLaps = laps.filter(l => l.completedMs >= anchor * 0.97 && l.completedMs <= anchor * 1.30);
  console.log(`${validLaps.length} valid laps (anchor ${(anchor/1000).toFixed(3)}s)`);

  // PB
  let pbMs = Infinity;
  for (const l of validLaps) if (l.completedMs < pbMs) pbMs = l.completedMs;
  const pb = validLaps.find(l => l.completedMs === pbMs);

  // Build PB trace
  const pbStartT = filtered[pb.startIdx].t;
  const pbTrace = [];
  let nextT = 0;
  for (let i = pb.startIdx; i <= pb.endIdx; i++) {
    const el = filtered[i].t - pbStartT;
    if (el >= nextT) {
      pbTrace.push({ t: el, x: filtered[i].x, z: filtered[i].z });
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
    return [s1, s2, s3];
  }

  // Print all laps
  console.log('');
  console.log(`PB: lap #${pb.num} = ${(pb.completedMs/1000).toFixed(3)}s  (set at ${new Date(pb.startT).toLocaleTimeString()})`);
  console.log('');
  console.log('  #  | time-of-set | lap# | total      | ΔPB     | Δprev   | S1       S2       S3');
  console.log('-----+-------------+------+------------+---------+---------+--------------------------');
  let prevMs = null;
  for (let i = 0; i < validLaps.length; i++) {
    const l = validLaps[i];
    const [s1, s2, s3] = sectorsForLap(l);
    const dPb = l.completedMs - pbMs;
    const dPrev = prevMs == null ? null : l.completedMs - prevMs;
    const time = new Date(l.startT).toLocaleTimeString('en-GB');
    const sec = (s1 == null) ? '      —          —          —' :
      `${(s1/1000).toFixed(3)}s  ${(s2/1000).toFixed(3)}s  ${(s3/1000).toFixed(3)}s`;
    const isPb = l === pb;
    const marker = isPb ? '★' : ' ';
    const dPbStr = isPb ? '   —   ' : ((dPb >= 0 ? '+' : '') + (dPb/1000).toFixed(3) + 's').padStart(7);
    const dPrevStr = dPrev == null ? '   —   ' : ((dPrev >= 0 ? '+' : '') + (dPrev/1000).toFixed(3) + 's').padStart(7);
    console.log(`${marker}${String(i+1).padStart(3)} | ${time}    | ${String(l.num).padStart(4)} | ${(l.completedMs/1000).toFixed(3)}s   | ${dPbStr} | ${dPrevStr} | ${sec}`);
    prevMs = l.completedMs;
  }

  // Variation stats
  const times = validLaps.map(l => l.completedMs);
  const mean = times.reduce((a,b)=>a+b,0) / times.length;
  const variance = times.reduce((a,b) => a + (b - mean) ** 2, 0) / times.length;
  const stddev = Math.sqrt(variance);
  const sortedTimes = times.slice().sort((a,b)=>a-b);
  const median = sortedTimes[Math.floor(sortedTimes.length/2)];
  const p10 = sortedTimes[Math.floor(sortedTimes.length*0.1)];
  const p90 = sortedTimes[Math.floor(sortedTimes.length*0.9)];
  const range = sortedTimes[sortedTimes.length-1] - sortedTimes[0];

  console.log('');
  console.log('==== Variation ====');
  console.log(`  fastest:  ${(sortedTimes[0]/1000).toFixed(3)}s`);
  console.log(`  slowest:  ${(sortedTimes[sortedTimes.length-1]/1000).toFixed(3)}s`);
  console.log(`  range:    ${(range/1000).toFixed(3)}s   ← spread`);
  console.log(`  median:   ${(median/1000).toFixed(3)}s`);
  console.log(`  mean:     ${(mean/1000).toFixed(3)}s`);
  console.log(`  stddev:   ${(stddev/1000).toFixed(3)}s   ← consistency`);
  console.log(`  p10:      ${(p10/1000).toFixed(3)}s`);
  console.log(`  p90:      ${(p90/1000).toFixed(3)}s`);
  console.log(`  p10-p90:  ${((p90-p10)/1000).toFixed(3)}s   ← typical spread (ignoring outliers)`);
})();

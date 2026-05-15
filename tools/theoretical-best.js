#!/usr/bin/env node
// Theoretical-best lap = sum of fastest sector times across all laps.
//
// We split the lap into 3 equal-distance sectors using the PB trace as the
// canonical track definition. Sector boundaries = the XZ points at 1/3 and
// 2/3 of the PB trace.
//
// For each lap, we find when the car passed those two XZ points (via
// nearest-neighbor matching), giving us 3 sector splits. Min across all
// laps in each sector = theoretical best.

const fs   = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const FILE = path.resolve(__dirname, '..', 'recordings', 'gt7-2026-05-13.jsonl');
const SAMPLE_INTERVAL_MS = 50;

(async () => {
  const targetCar = 2166;
  const packets = [];
  const stream = fs.createReadStream(FILE);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    try {
      const p = JSON.parse(line);
      if (p.type === 'config') continue;
      if (p.carCode !== targetCar || !p.position || typeof p.lapCount !== 'number') continue;
      packets.push({
        t: p.t || p.tsMs || p.timestamp || 0,
        lap: p.lapCount,
        lastMs: p.lastLapTimeMs,
        x: p.position.x,
        z: p.position.z,
      });
    } catch {}
  }
  rl.close();

  // Slice into laps (same logic as ruined-laps.js)
  const laps = [];
  let curStart = 0;
  for (let i = 1; i < packets.length; i++) {
    if (packets[i].lap !== packets[i-1].lap) {
      const completedMs = packets[i].lastMs;
      if (typeof completedMs === 'number' && completedMs > 30_000 && completedMs < 600_000) {
        laps.push({ num: packets[i-1].lap, startIdx: curStart, endIdx: i - 1, completedMs });
      }
      curStart = i;
    }
  }
  console.log(`Detected ${laps.length} complete laps`);

  // PB lap = latest occurrence of fastest time
  let pbMs = Infinity;
  for (const lap of laps) if (lap.completedMs < pbMs) pbMs = lap.completedMs;
  let pb = null;
  for (let i = laps.length - 1; i >= 0; i--) {
    if (laps[i].completedMs <= pbMs + 50) { pb = laps[i]; break; }
  }
  console.log(`PB: ${(pb.completedMs/1000).toFixed(3)}s (lap order ${laps.indexOf(pb)})`);

  // Build 20Hz PB trace
  const pbStartT = packets[pb.startIdx].t;
  const refTrace = [];
  let nextSampleAt = 0;
  for (let i = pb.startIdx; i <= pb.endIdx; i++) {
    const elapsed = packets[i].t - pbStartT;
    if (elapsed >= nextSampleAt) {
      refTrace.push({ t: elapsed, x: packets[i].x, z: packets[i].z });
      nextSampleAt = elapsed + SAMPLE_INTERVAL_MS;
    }
  }

  // Sector boundaries at 1/3 and 2/3 of PB trace
  const sector1End = refTrace[Math.floor(refTrace.length / 3)];
  const sector2End = refTrace[Math.floor(2 * refTrace.length / 3)];
  const pbSector1 = sector1End.t;
  const pbSector2 = sector2End.t - sector1End.t;
  const pbSector3 = pb.completedMs - sector2End.t;
  console.log('');
  console.log(`Sector splits (from PB trace):`);
  console.log(`  S1 boundary: XZ (${sector1End.x.toFixed(0)}, ${sector1End.z.toFixed(0)}) at ${(pbSector1/1000).toFixed(3)}s`);
  console.log(`  S2 boundary: XZ (${sector2End.x.toFixed(0)}, ${sector2End.z.toFixed(0)}) at ${(sector2End.t/1000).toFixed(3)}s`);
  console.log(`  PB sector times: S1=${(pbSector1/1000).toFixed(3)}s  S2=${(pbSector2/1000).toFixed(3)}s  S3=${(pbSector3/1000).toFixed(3)}s`);

  // For each lap, find when it crossed s1End and s2End by spatial proximity
  function findCrossingTime(lap, target) {
    let bestIdx = -1, bestD2 = Infinity;
    for (let i = lap.startIdx; i <= lap.endIdx; i++) {
      const dx = packets[i].x - target.x, dz = packets[i].z - target.z;
      const d2 = dx*dx + dz*dz;
      if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
    }
    if (bestIdx === -1 || bestD2 > 250_000) return null;
    return packets[bestIdx].t - packets[lap.startIdx].t;
  }

  const lapSectors = [];
  for (const lap of laps) {
    const s1AtMs = findCrossingTime(lap, sector1End);
    const s2AtMs = findCrossingTime(lap, sector2End);
    if (s1AtMs == null || s2AtMs == null) continue;
    const s1 = s1AtMs;
    const s2 = s2AtMs - s1AtMs;
    const s3 = lap.completedMs - s2AtMs;
    if (s1 <= 0 || s2 <= 0 || s3 <= 0) continue;
    lapSectors.push({ lap: lap.num, order: laps.indexOf(lap), total: lap.completedMs, s1, s2, s3 });
  }
  console.log(`Sector data captured for ${lapSectors.length} / ${laps.length} laps`);

  // Find best per sector
  let bestS1 = lapSectors[0], bestS2 = lapSectors[0], bestS3 = lapSectors[0];
  for (const r of lapSectors) {
    if (r.s1 < bestS1.s1) bestS1 = r;
    if (r.s2 < bestS2.s2) bestS2 = r;
    if (r.s3 < bestS3.s3) bestS3 = r;
  }
  const theoretical = bestS1.s1 + bestS2.s2 + bestS3.s3;

  console.log('');
  console.log(`Best Sector 1: ${(bestS1.s1/1000).toFixed(3)}s   (lap #${bestS1.lap}, total lap ${(bestS1.total/1000).toFixed(3)}s)`);
  console.log(`Best Sector 2: ${(bestS2.s2/1000).toFixed(3)}s   (lap #${bestS2.lap}, total lap ${(bestS2.total/1000).toFixed(3)}s)`);
  console.log(`Best Sector 3: ${(bestS3.s3/1000).toFixed(3)}s   (lap #${bestS3.lap}, total lap ${(bestS3.total/1000).toFixed(3)}s)`);
  console.log('');
  console.log(`THEORETICAL BEST = ${(theoretical/1000).toFixed(3)}s`);
  console.log(`Actual PB        = ${(pb.completedMs/1000).toFixed(3)}s`);
  console.log(`Time on table    = ${((pb.completedMs - theoretical)/1000).toFixed(3)}s`);

  // Recent vs all
  console.log('');
  console.log('Sector times for last 10 laps:');
  console.log('order | lap# | total    | S1       S2       S3');
  for (const r of lapSectors.slice(-10).reverse()) {
    console.log(`${String(r.order).padStart(5)} | ${String(r.lap).padStart(4)} | ${(r.total/1000).toFixed(3)}s | ${(r.s1/1000).toFixed(3)}s  ${(r.s2/1000).toFixed(3)}s  ${(r.s3/1000).toFixed(3)}s`);
  }
})();

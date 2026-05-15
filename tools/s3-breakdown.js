#!/usr/bin/env node
// Diagnose where in Sector 3 the time is being lost across the last N laps.
//
// For each recent lap, walks Sector 3 packet-by-packet, matches against the
// PB-trace, and reports:
//   - lap total and per-sector splits
//   - cumulative delta growth at 4 evenly-spaced checkpoints inside S3
//   - location (lap-elapsed + XZ + speed) of the single biggest delta jump
//
// Use this to tell whether you keep losing time at the SAME corner in S3 or
// breaking down at different points.

const fs   = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const RECORD_DIR = path.resolve(__dirname, '..', 'recordings');
const LAST_N = 12;

(async () => {
  const files = fs.readdirSync(RECORD_DIR)
    .filter(f => /^gt7-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort();
  const file = path.join(RECORD_DIR, files[files.length - 1]);
  console.log(`Reading ${path.basename(file)} ...`);

  // ---- load packets for the dominant car
  const packets = [];
  let mainCar = null;
  let carCounts = new Map();
  {
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
          speedKph: p.speedKph,
          throttle: p.throttle, brake: p.brake, gear: p.currentGear,
        });
      } catch {}
    }
    rl.close();
  }
  let maxN = 0;
  for (const [cc, n] of carCounts) if (n > maxN) { maxN = n; mainCar = cc; }
  const filtered = packets.filter(p => p.carCode === mainCar);
  console.log(`Loaded ${filtered.length} packets for car ${mainCar}`);

  // ---- slice into laps
  const laps = [];
  let cs = 0;
  for (let i = 1; i < filtered.length; i++) {
    if (filtered[i].lap !== filtered[i-1].lap) {
      const c = filtered[i].lastMs;
      const wallMs = filtered[i-1].t - filtered[cs].t;
      if (typeof c === 'number' && c > 30_000 && c < 600_000 && wallMs > c * 0.9) {
        laps.push({ num: filtered[i-1].lap, startIdx: cs, endIdx: i - 1, completedMs: c });
      }
      cs = i;
    }
  }
  // Sanity filter on lap times (anchor on 5th percentile)
  {
    const sorted = laps.map(l => l.completedMs).sort((a,b) => a-b);
    const fastAnchor = sorted[Math.max(0, Math.floor(sorted.length * 0.05))];
    const before = laps.length;
    for (let i = laps.length - 1; i >= 0; i--) {
      const l = laps[i];
      if (l.completedMs < fastAnchor * 0.97 || l.completedMs > fastAnchor * 1.30) {
        laps.splice(i, 1);
      }
    }
    if (before !== laps.length) console.log(`Filtered to ${laps.length} laps (anchor ${(fastAnchor/1000).toFixed(3)}s)`);
  }
  console.log(`${laps.length} valid laps total`);
  if (laps.length < 3) { console.error('Not enough laps.'); process.exit(1); }

  // ---- pick PB
  let pbMs = Infinity, pb = null;
  for (const lap of laps) if (lap.completedMs < pbMs) pbMs = lap.completedMs;
  for (let i = laps.length - 1; i >= 0; i--) {
    if (laps[i].completedMs === pbMs) { pb = laps[i]; break; }
  }
  console.log(`PB: lap order ${laps.indexOf(pb)} = ${(pb.completedMs/1000).toFixed(3)}s`);

  // ---- build PB trace (20Hz sampled) — used for matching
  const pbStartT = filtered[pb.startIdx].t;
  const pbTrace = [];
  let nextT = 0;
  for (let i = pb.startIdx; i <= pb.endIdx; i++) {
    const el = filtered[i].t - pbStartT;
    if (el >= nextT) {
      pbTrace.push({
        t: el,
        x: filtered[i].x, z: filtered[i].z,
        speedKph: filtered[i].speedKph,
        throttle: filtered[i].throttle, brake: filtered[i].brake, gear: filtered[i].gear,
      });
      nextT = el + 50;
    }
  }
  const s1EndIdx = Math.floor(pbTrace.length / 3);
  const s2EndIdx = Math.floor(2 * pbTrace.length / 3);
  console.log(`PB trace samples: ${pbTrace.length}  S1→S2 at idx ${s1EndIdx} (${(pbTrace[s1EndIdx].t/1000).toFixed(3)}s)  S2→S3 at idx ${s2EndIdx} (${(pbTrace[s2EndIdx].t/1000).toFixed(3)}s)`);

  function analyzeLap(lap) {
    const startT = filtered[lap.startIdx].t;
    let lastMatchIdx = 0;
    let currentSector = 1;
    const enterTimes = [0, null, null];
    // S3 checkpoint indices on PB trace (4 equal sub-sectors of S3)
    const s3SubBoundaries = [];
    for (let k = 1; k <= 4; k++) {
      s3SubBoundaries.push(Math.floor(s2EndIdx + (pbTrace.length - s2EndIdx) * k / 4));
    }
    // Cumulative delta at each S3 sub-boundary
    const deltaAtSub = [null, null, null, null];
    let biggestJump = { delta: 0, atIdx: -1, atElapsed: null, xz: null, speedKph: null, throttle: null, brake: null, gear: null };
    let prevDelta = null;

    for (let i = lap.startIdx; i <= lap.endIdx; i++) {
      const cx = filtered[i].x, cz = filtered[i].z;
      const lo = Math.max(lastMatchIdx, lastMatchIdx - 3);  // forward-biased
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

      if (currentSector === 3) {
        const elapsed = filtered[i].t - startT;
        const delta = elapsed - pbTrace[bestIdx].t;  // ms behind PB at this XZ
        if (prevDelta !== null) {
          const jump = delta - prevDelta;
          if (jump > biggestJump.delta) {
            biggestJump = {
              delta: jump,
              atIdx: bestIdx,
              atElapsed: elapsed,
              xz: { x: cx, z: cz },
              speedKph: filtered[i].speedKph,
              throttle: filtered[i].throttle,
              brake: filtered[i].brake,
              gear: filtered[i].gear,
            };
          }
        }
        prevDelta = delta;
        // Capture cumulative delta at each S3 sub-boundary
        for (let k = 0; k < 4; k++) {
          if (deltaAtSub[k] == null && bestIdx >= s3SubBoundaries[k]) {
            deltaAtSub[k] = delta;
          }
        }
      }
    }

    if (enterTimes[1] == null || enterTimes[2] == null) return null;
    const s1 = enterTimes[1];
    const s2 = enterTimes[2] - enterTimes[1];
    const s3 = lap.completedMs - enterTimes[2];
    if (s1 <= 0 || s2 <= 0 || s3 <= 0) return null;
    return { lap, s1, s2, s3, deltaAtSub, biggestJump };
  }

  const pbSecs = analyzeLap(pb);
  console.log(`PB sectors:  S1=${(pbSecs.s1/1000).toFixed(3)}s  S2=${(pbSecs.s2/1000).toFixed(3)}s  S3=${(pbSecs.s3/1000).toFixed(3)}s`);
  console.log('');

  // ---- analyze last N laps (excluding PB so the PB row doesn't muddy the comparison)
  const recentLaps = laps.slice(-LAST_N - 1).filter(l => l !== pb).slice(-LAST_N);
  console.log(`==== Last ${recentLaps.length} laps (chronological) ====`);
  console.log('order | lap# | total    | S1       S2       S3      | S3 vs PB | mistake @ S3-elapsed | XZ           | speed  gear  thr%  brk%');
  for (const lap of recentLaps) {
    const r = analyzeLap(lap);
    if (!r) { console.log(`${String(laps.indexOf(lap)).padStart(5)} | ${String(lap.num).padStart(4)} | sector analysis failed`); continue; }
    const s3Delta = r.s3 - pbSecs.s3;
    const j = r.biggestJump;
    const s3StartT = r.s1 + r.s2;
    const inS3 = j.atElapsed != null ? j.atElapsed - s3StartT : null;
    const xz = j.xz ? `(${j.xz.x.toFixed(0)},${j.xz.z.toFixed(0)})`.padStart(13) : '(-, -)'.padStart(13);
    const speed = j.speedKph != null ? j.speedKph.toFixed(0) + 'kph' : '-';
    const gear = j.gear != null ? (j.gear === 0 ? 'R' : j.gear === 15 ? 'N' : String(j.gear)) : '-';
    const thr = j.throttle != null ? (j.throttle / 2.55).toFixed(0) + '%' : '-';
    const brk = j.brake != null ? (j.brake / 2.55).toFixed(0) + '%' : '-';
    const inS3Str = inS3 != null ? (inS3/1000).toFixed(2) + 's' : '-';
    console.log(`${String(laps.indexOf(lap)).padStart(5)} | ${String(lap.num).padStart(4)} | ${(lap.completedMs/1000).toFixed(3)}s | ${(r.s1/1000).toFixed(3)}s  ${(r.s2/1000).toFixed(3)}s  ${(r.s3/1000).toFixed(3)}s | ${s3Delta >= 0 ? '+' : ''}${(s3Delta/1000).toFixed(3)}s  | ${inS3Str.padStart(7)}              | ${xz} | ${speed.padStart(6)}  ${gear.padStart(2)}    ${thr.padStart(4)}  ${brk.padStart(4)}`);
  }

  // ---- cumulative S3-delta growth at 4 checkpoints
  console.log('');
  console.log(`Where in S3 the loss accumulates (Δ to PB at 25%, 50%, 75%, 100% of S3 distance):`);
  console.log('order | lap# | total    | S3      |   @25%      @50%      @75%      end (= S3Δ)');
  for (const lap of recentLaps) {
    const r = analyzeLap(lap);
    if (!r) continue;
    const ds = r.deltaAtSub.map(d => d == null ? '   -   ' : ((d>=0?'+':'')+(d/1000).toFixed(3)+'s').padStart(8));
    console.log(`${String(laps.indexOf(lap)).padStart(5)} | ${String(lap.num).padStart(4)} | ${(lap.completedMs/1000).toFixed(3)}s | ${(r.s3/1000).toFixed(3)}s | ${ds.join('  ')}`);
  }

  // ---- cluster XZ of biggest jump
  console.log('');
  console.log(`XZ cluster of S3 mistakes across the last ${recentLaps.length} laps:`);
  const clusters = [];
  for (const lap of recentLaps) {
    const r = analyzeLap(lap);
    if (!r || !r.biggestJump.xz) continue;
    const xz = r.biggestJump.xz;
    let matched = false;
    for (const c of clusters) {
      const dx = c.cx - xz.x, dz = c.cz - xz.z;
      if (dx*dx + dz*dz < 30*30) { // 30m radius
        c.count++;
        c.totalDelta += r.biggestJump.delta;
        c.laps.push(lap.num);
        matched = true; break;
      }
    }
    if (!matched) clusters.push({ cx: xz.x, cz: xz.z, count: 1, totalDelta: r.biggestJump.delta, laps: [lap.num] });
  }
  clusters.sort((a,b) => b.count - a.count);
  for (const c of clusters) {
    console.log(`  ${c.count}× at XZ (${c.cx.toFixed(0)}, ${c.cz.toFixed(0)})  laps=[${c.laps.join(', ')}]`);
  }
})();

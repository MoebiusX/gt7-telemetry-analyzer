#!/usr/bin/env node
// Find "almost-perfect" laps: ones where the live projected-lap was ~0.5s
// faster than the actual lap time — i.e. a small mistake ruined the lap.
//
// Algorithm (post-hoc replay of the lap-predictor):
//   1. Stream packets for one car+track.
//   2. Slice into completed laps.
//   3. Pick the PB lap. Build a 20Hz reference trace of {t,x,z} from lap start.
//   4. For every other completed lap, walk packets in order. At each sample,
//      find the nearest XZ point on the PB trace and compute
//        projectedMs = currentElapsed + (PBms - PBElapsedAtSamePoint)
//   5. min(projected) over the lap = the "best you were ever projecting".
//      Actual completion ms - min(projected) = time lost to the mistake.
//   6. The packet where projected jumps the most = where the mistake happened.

const fs   = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const FILE = path.resolve(__dirname, '..', 'recordings', 'gt7-2026-05-13.jsonl');
const SAMPLE_INTERVAL_MS = 50;

(async () => {
  // ---- pass 1: load all packets we care about (Alfa 4C on Big Willow)
  const targetCar = 2166; // per meta.json
  const packets = [];
  const stream = fs.createReadStream(FILE);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    try {
      const p = JSON.parse(line);
      if (p.type === 'config') continue;
      if (p.carCode !== targetCar) continue;
      if (!p.position) continue;
      if (typeof p.lapCount !== 'number') continue;
      packets.push({
        t:       p.t || p.tsMs || p.timestamp || 0,
        lap:     p.lapCount,
        lastMs:  p.lastLapTimeMs,
        bestMs:  p.bestLapTimeMs,
        x:       p.position.x,
        z:       p.position.z,
      });
    } catch {}
  }
  rl.close();
  console.log(`Loaded ${packets.length} packets for car ${targetCar} on Big Willow`);

  if (packets.length < 1000) { console.log('Not enough data.'); return; }

  // ---- pass 2: slice into laps
  // A "lap N trace" = all packets with lapCount===N, between the
  // transition (N-1)->N and N->(N+1). Completion time = lastLapTimeMs read
  // at the moment of transition N->(N+1).
  const laps = []; // [{ num, startIdx, endIdx, completedMs, durationPackets }]
  let curStart = 0;
  for (let i = 1; i < packets.length; i++) {
    if (packets[i].lap !== packets[i-1].lap) {
      const num = packets[i-1].lap;
      // The lap that just ended is `num`; completion time is in packets[i].lastMs
      const completedMs = packets[i].lastMs;
      if (typeof completedMs === 'number' && completedMs > 30_000 && completedMs < 600_000) {
        laps.push({ num, startIdx: curStart, endIdx: i - 1, completedMs });
      }
      curStart = i;
    }
  }
  console.log(`Detected ${laps.length} complete laps with valid times`);

  if (laps.length < 2) { console.log('Not enough complete laps to compare.'); return; }

  // ---- pass 3: find PB lap. To get a clean reference, take the LATEST occurrence
  // (most recent setup / pedals firmness). Among the fastest laps, pick latest.
  let pbMs = Infinity;
  for (const lap of laps) if (lap.completedMs < pbMs) pbMs = lap.completedMs;
  // Use the most-recent lap that ties the PB (most relevant to current setup)
  let pb = null;
  for (let i = laps.length - 1; i >= 0; i--) {
    if (laps[i].completedMs <= pbMs + 50) { pb = laps[i]; break; }
  }
  console.log(`PB lap: #${pb.num}, ${(pb.completedMs/1000).toFixed(3)}s (packets ${pb.startIdx}..${pb.endIdx})`);
  // Tag each lap with array order so we can identify "the most recent ones"
  for (let i = 0; i < laps.length; i++) laps[i].order = i;

  // Build 20Hz reference trace
  const pbStartT = packets[pb.startIdx].t;
  const refTrace = []; // {t,x,z} t is ms from lap start
  let nextSampleAt = 0;
  for (let i = pb.startIdx; i <= pb.endIdx; i++) {
    const elapsed = packets[i].t - pbStartT;
    if (elapsed >= nextSampleAt) {
      refTrace.push({ t: elapsed, x: packets[i].x, z: packets[i].z });
      nextSampleAt = elapsed + SAMPLE_INTERVAL_MS;
    }
  }
  console.log(`PB trace samples: ${refTrace.length}`);

  // ---- pass 4: for each lap, compute projected-lap profile against PB
  const results = [];
  for (const lap of laps) {
    if (lap === pb) continue;
    const lapStartT = packets[lap.startIdx].t;

    let minProjected = Infinity;
    let minAtElapsed = null;
    let minAtIdx = null;
    let prevProjected = null;
    let biggestJumpMs = 0;
    let biggestJumpAtElapsed = null;
    let biggestJumpXZ = null;

    let lastMatchIdx = 0;
    const SEARCH_WINDOW = 80;

    for (let i = lap.startIdx; i <= lap.endIdx; i++) {
      const elapsed = packets[i].t - lapStartT;
      const cx = packets[i].x, cz = packets[i].z;

      // windowed nearest-neighbor on PB trace
      const lo = Math.max(0, lastMatchIdx - 10);
      const hi = Math.min(refTrace.length - 1, lastMatchIdx + SEARCH_WINDOW);
      let bestIdx = -1, bestD2 = Infinity;
      for (let j = lo; j <= hi; j++) {
        const dx = refTrace[j].x - cx, dz = refTrace[j].z - cz;
        const d2 = dx*dx + dz*dz;
        if (d2 < bestD2) { bestD2 = d2; bestIdx = j; }
      }
      // wide sweep if needed
      if (bestIdx === hi || bestIdx === -1 || bestD2 > 1_000_000) {
        bestD2 = Infinity;
        for (let j = 0; j < refTrace.length; j++) {
          const dx = refTrace[j].x - cx, dz = refTrace[j].z - cz;
          const d2 = dx*dx + dz*dz;
          if (d2 < bestD2) { bestD2 = d2; bestIdx = j; }
        }
      }
      if (bestIdx === -1) continue;
      lastMatchIdx = bestIdx;

      const projected = elapsed + (pb.completedMs - refTrace[bestIdx].t);

      // Same artifact concern for min — don't let the wraparound pretend you were
      // projecting a 12-second lap at the line.
      const remainingMs = lap.completedMs - elapsed;
      if (projected < minProjected && remainingMs > 2500 && elapsed > 3000) {
        minProjected = projected;
        minAtElapsed = elapsed;
        minAtIdx = i;
      }
      // Ignore the final 2.5s of the lap — start/finish-line nearest-neighbor
      // wraparound creates a huge spurious jump there.
      const isNearFinish = (lap.completedMs - elapsed) < 2500;
      if (prevProjected !== null && !isNearFinish) {
        const jump = projected - prevProjected;
        if (jump > biggestJumpMs) {
          biggestJumpMs = jump;
          biggestJumpAtElapsed = elapsed;
          biggestJumpXZ = { x: cx, z: cz };
        }
      }
      prevProjected = projected;
    }

    // potential left on the table: how much faster the projection was at its best
    const potentialMs = lap.completedMs - minProjected;
    results.push({
      lapNum: lap.num,
      order: lap.order,
      actualMs: lap.completedMs,
      minProjectedMs: minProjected,
      potentialMs,
      minAtElapsedMs: minAtElapsed,
      biggestJumpMs,
      biggestJumpAtElapsed,
      biggestJumpXZ,
    });
  }

  // ---- print "almost-perfect-but-ruined" laps (projection was ≥0.3s faster than actual)
  const ruined = results
    .filter(r => r.potentialMs >= 300 && r.actualMs < pb.completedMs + 5000)
    .sort((a,b) => b.potentialMs - a.potentialMs);

  console.log('');
  console.log(`PB: ${(pb.completedMs/1000).toFixed(3)}s — Big Willow / Alfa Romeo 4C Gr.4`);
  console.log(`Total laps analyzed: ${results.length}`);
  console.log(`"Almost-perfect-but-ruined" laps (projection beat actual by ≥0.3s): ${ruined.length} (${(100*ruined.length/results.length).toFixed(1)}%)`);
  console.log('');
  console.log('Top 15 — biggest potential left on the table:');
  console.log('lap# | actual    | min-projected | lost (ms) | mistake at lap-elapsed | XZ');
  for (const r of ruined.slice(0, 15)) {
    const t = r.biggestJumpAtElapsed != null ? (r.biggestJumpAtElapsed/1000).toFixed(2)+'s' : '-';
    const xz = r.biggestJumpXZ ? `(${r.biggestJumpXZ.x.toFixed(0)},${r.biggestJumpXZ.z.toFixed(0)})` : '-';
    console.log(`${String(r.lapNum).padStart(4)} | ${(r.actualMs/1000).toFixed(3)}s | ${(r.minProjectedMs/1000).toFixed(3)}s     | ${String(Math.round(r.potentialMs)).padStart(5)}     | ${t.padStart(8)}             | ${xz}`);
  }

  // ---- "almost a PB" subset
  const nearPB = ruined.filter(r => r.minProjectedMs < pb.completedMs);
  console.log('');
  console.log(`Laps where min-projected was UNDER the PB (i.e. you were on for a new PB before the mistake): ${nearPB.length}`);
  for (const r of nearPB.slice(0, 10)) {
    const deltaUnderPB = pb.completedMs - r.minProjectedMs;
    const t = r.biggestJumpAtElapsed != null ? (r.biggestJumpAtElapsed/1000).toFixed(2)+'s' : '-';
    console.log(`  lap #${r.lapNum}: projected ${(r.minProjectedMs/1000).toFixed(3)}s (-${(deltaUnderPB/1000).toFixed(3)}s vs PB), actual ${(r.actualMs/1000).toFixed(3)}s, mistake at ${t}`);
  }

  // ---- last-N laps focus (chronological, by file order)
  const LAST_N = 15;
  const recent = [...results].sort((a,b) => b.order - a.order).slice(0, LAST_N);
  console.log('');
  console.log(`==== Last ${LAST_N} laps (most recent first) ====`);
  console.log('order | lap# | actual    | min-projected | lost | mistake at | XZ');
  for (const r of recent) {
    const t = r.biggestJumpAtElapsed != null ? (r.biggestJumpAtElapsed/1000).toFixed(2)+'s' : '-';
    const xz = r.biggestJumpXZ ? `(${r.biggestJumpXZ.x.toFixed(0)},${r.biggestJumpXZ.z.toFixed(0)})` : '-';
    const lost = isFinite(r.potentialMs) ? String(Math.round(r.potentialMs)).padStart(5) : '  -  ';
    const minProj = isFinite(r.minProjectedMs) ? (r.minProjectedMs/1000).toFixed(3)+'s' : '   -    ';
    console.log(`${String(r.order).padStart(5)} | ${String(r.lapNum).padStart(4)} | ${(r.actualMs/1000).toFixed(3)}s | ${minProj}      | ${lost} | ${t.padStart(7)}   | ${xz}`);
  }
})();

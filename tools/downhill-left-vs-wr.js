#!/usr/bin/env node
//
// Template analyzer — edit the constants at the top to match your data:
//   TARGET_PB_MS  — milliseconds of the lap you want as reference (e.g. 78791)
//   CAR_CODE      — GT7 car id from data/cars.json (e.g. 2166 for Alfa 4C Gr.4)
//   RECORDING     — recording filename in recordings/ (default: today)
//
// All three can be overridden via env vars: PB_MS, CAR_CODE, RECORDING
//
// Find downhill left turns in S2 and measure perpendicular lateral offset
// between your PB line and the WR ghost — i.e. "are you tighter to the apex
// than the WR, and by how many meters?"
//
// Downhill = Y dropping over a window of samples (~3m descent over <10 samples).
// Left turn = heading vector rotating counter-clockwise across the same window.
// Perpendicular offset = component of (you − WR) perpendicular to WR's heading.
//   Positive value = your car is to the LEFT of WR's line (toward apex on a LH turn).
//   Negative value = your car is to the RIGHT of WR's line (away from apex on a LH turn).

const fs = require('node:fs');
const readline = require('node:readline');
const path = require('node:path');

(async () => {
  const ghost = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'data', 'ghost.json'), 'utf8'));
  const wrTrace = ghost.trace;

  const stream = fs.createReadStream(process.env.RECORDING ? path.resolve(__dirname, '..', 'recordings', process.env.RECORDING) : path.resolve(__dirname, '..', 'recordings', 'gt7-' + new Date().toISOString().slice(0,10) + '.jsonl'));
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const packets = [];
  for await (const line of rl) {
    try {
      const p = JSON.parse(line);
      if (p.type === 'config' || !p.position) continue;
      if (p.carCode !== (Number(process.env.CAR_CODE) || 2166)) continue;  // override with CAR_CODE env
      packets.push({ t: p.t, lap: p.lapCount, lastMs: p.lastLapTimeMs, x: p.position.x, y: p.position.y, z: p.position.z, speedKph: p.speedKph, throttle: p.throttle, brake: p.brake, gear: p.currentGear });
    } catch {}
  }
  rl.close();
  const TARGET = Number(process.env.PB_MS) || 78791;  // override with PB_MS env
  let pbLap = null, cs = 0;
  for (let i = 1; i < packets.length; i++) {
    if (packets[i].lap !== packets[i-1].lap) {
      if (packets[i].lastMs === TARGET) { pbLap = { startIdx: cs, endIdx: i-1 }; break; }
      cs = i;
    }
  }
  const pbTrace = [];
  const startT = packets[pbLap.startIdx].t;
  for (let i = pbLap.startIdx; i <= pbLap.endIdx; i++) {
    pbTrace.push({ t: packets[i].t - startT, x: packets[i].x, y: packets[i].y, z: packets[i].z, speedKph: packets[i].speedKph, throttle: packets[i].throttle, brake: packets[i].brake, gear: packets[i].gear });
  }

  // S2 bounds on WR trace
  const s1End = Math.floor(wrTrace.length / 3);
  const s2End = Math.floor(2 * wrTrace.length / 3);

  // Helper: get elevation at a given XZ by finding nearest PB sample
  function elevationAt(x, z) {
    let bestIdx = -1, bestD2 = Infinity;
    for (let i = 0; i < pbTrace.length; i++) {
      const dx = pbTrace[i].x - x, dz = pbTrace[i].z - z;
      const d2 = dx*dx + dz*dz;
      if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
    }
    return bestIdx >= 0 ? pbTrace[bestIdx].y : null;
  }

  // Compute per-WR-sample heading and curvature
  const W = 5;  // smoothing window
  const samples = [];
  for (let k = s1End + W; k <= s2End - W; k++) {
    const prev = wrTrace[k - W], curr = wrTrace[k], next = wrTrace[k + W];
    const hx = next.x - prev.x;
    const hz = next.z - prev.z;
    const hmag = Math.hypot(hx, hz);
    if (hmag < 0.1) continue;
    const ux = hx / hmag, uz = hz / hmag;       // unit heading vector (in XZ plane)
    const lpx = -uz, lpz = ux;
    const v1x = curr.x - prev.x, v1z = curr.z - prev.z;
    const v2x = next.x - curr.x, v2z = next.z - curr.z;
    const cross = v1x * v2z - v1z * v2x;
    const isLeftTurn = cross > 0.5;
    // Elevation from PB lap (same track)
    const yPrev = elevationAt(prev.x, prev.z);
    const yNext = elevationAt(next.x, next.z);
    const yCurr = elevationAt(curr.x, curr.z);
    const dy = (yPrev != null && yNext != null) ? (yNext - yPrev) : 0;
    const isDownhill = dy < -0.6;

    let bestIdx = -1, bestD2 = Infinity;
    for (let i = 0; i < pbTrace.length; i++) {
      const dxp = pbTrace[i].x - curr.x, dzp = pbTrace[i].z - curr.z;
      const d2 = dxp*dxp + dzp*dzp;
      if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
    }
    const pb = pbTrace[bestIdx];
    curr.y = yCurr;  // attach for printing

    // Perpendicular offset: dot product of (PB − WR) with left-perpendicular unit
    const offX = pb.x - curr.x, offZ = pb.z - curr.z;
    const perpLeft = offX * lpx + offZ * lpz;   // +ve = you are to LEFT of WR line
    const speedDelta = curr.speedKph - pb.speedKph;
    samples.push({
      k, t: curr.t,
      wrX: curr.x, wrZ: curr.z, wrY: curr.y, wrSpeed: curr.speedKph,
      pbX: pb.x, pbZ: pb.z, pbY: pb.y, pbSpeed: pb.speedKph,
      perpLeft, totalOffset: Math.sqrt(bestD2),
      isLeftTurn, isDownhill, dy,
      speedDelta,
    });
  }

  // Find contiguous downhill-left-turn segments
  const segments = [];
  let cur = null;
  for (const s of samples) {
    if (s.isLeftTurn && s.isDownhill) {
      if (!cur) cur = { start: s.k, end: s.k, items: [s] };
      else { cur.end = s.k; cur.items.push(s); }
    } else if (cur) {
      if (cur.items.length >= 3) segments.push(cur);
      cur = null;
    }
  }
  if (cur && cur.items.length >= 3) segments.push(cur);

  console.log('Downhill LEFT-turn segments in S2:', segments.length);
  if (!segments.length) {
    console.log('(none found with the strict filter — relaxing constraints)');
    // Print all left turns regardless of downhill
    const leftTurns = samples.filter(s => s.isLeftTurn);
    console.log('Left turns in S2:', leftTurns.length, '(elevation changes shown)');
    // Group consecutive
    let cur2 = null;
    const lturns = [];
    for (const s of samples) {
      if (s.isLeftTurn) {
        if (!cur2) cur2 = { start: s.k, end: s.k, items: [s] };
        else { cur2.end = s.k; cur2.items.push(s); }
      } else if (cur2) {
        if (cur2.items.length >= 3) lturns.push(cur2);
        cur2 = null;
      }
    }
    if (cur2 && cur2.items.length >= 3) lturns.push(cur2);
    for (const seg of lturns) {
      const middle = seg.items[Math.floor(seg.items.length / 2)];
      const yDrop = seg.items[seg.items.length-1].wrY - seg.items[0].wrY;
      console.log(`  segment: ${seg.items.length} samples, mid XZ (${middle.wrX.toFixed(0)},${middle.wrZ.toFixed(0)}), Y drop ${yDrop.toFixed(1)}m`);
    }
    return;
  }

  for (const seg of segments) {
    console.log('');
    const middle = seg.items[Math.floor(seg.items.length / 2)];
    const yDrop = seg.items[seg.items.length-1].wrY - seg.items[0].wrY;
    console.log('=== DOWNHILL LEFT TURN ===');
    console.log(`  Mid XZ: (${middle.wrX.toFixed(0)}, ${middle.wrZ.toFixed(0)}), elevation Y=${middle.wrY.toFixed(1)}m, drops ${yDrop.toFixed(1)}m over the turn`);
    console.log(`  ${seg.items.length} samples, t = ${(seg.items[0].t/1000).toFixed(2)}s → ${(seg.items[seg.items.length-1].t/1000).toFixed(2)}s of lap`);
    console.log('');
    console.log('  k    | WR XZ      | PB XZ      | perpLeft | total off | WR spd | PB spd | Δspd');
    for (const s of seg.items) {
      const perpSign = s.perpLeft > 0 ? '+' : '';
      console.log(`  ${String(s.k).padStart(4)} | (${s.wrX.toFixed(0).padStart(4)},${s.wrZ.toFixed(0).padStart(4)}) | (${s.pbX.toFixed(0).padStart(4)},${s.pbZ.toFixed(0).padStart(4)}) | ${perpSign}${s.perpLeft.toFixed(2).padStart(5)}m  | ${s.totalOffset.toFixed(2).padStart(5)}m   | ${s.wrSpeed.toFixed(0).padStart(3)}    | ${s.pbSpeed.toFixed(0).padStart(3)}    | ${s.speedDelta >= 0 ? '+' : ''}${s.speedDelta.toFixed(1)}`);
    }
    const avgPerp = seg.items.reduce((a,b) => a + b.perpLeft, 0) / seg.items.length;
    const avgSpdDelta = seg.items.reduce((a,b) => a + b.speedDelta, 0) / seg.items.length;
    console.log('');
    console.log(`  Avg perpLeft: ${avgPerp >= 0 ? '+' : ''}${avgPerp.toFixed(2)}m (positive = you are to LEFT of WR line; for a LH turn this means closer to the apex)`);
    console.log(`  Avg speed delta: ${avgSpdDelta >= 0 ? '+' : ''}${avgSpdDelta.toFixed(1)} kph (positive = WR faster)`);
  }
})();

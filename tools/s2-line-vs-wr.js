#!/usr/bin/env node
//
// Template analyzer — edit the constants at the top to match your data:
//   TARGET_PB_MS  — milliseconds of the lap you want as reference (e.g. 78791)
//   CAR_CODE      — GT7 car id from data/cars.json (e.g. 2166 for Alfa 4C Gr.4)
//   RECORDING     — recording filename in recordings/ (default: today)
//
// All three can be overridden via env vars: PB_MS, CAR_CODE, RECORDING
//
// Compare the racing line through Sector 2 specifically: your latest PB lap
// vs the WR ghost. Tests the hypothesis "WR takes a wider/more open line through
// S2 — left tires near the apex curb, less steering angle, more carried speed."
//
// Output: for each apex in S2, the WR's XZ + your XZ + the lateral offset
// between the two lines + the speed delta.

const fs = require('node:fs');
const readline = require('node:readline');
const path = require('node:path');

(async () => {
  // 1. Load the WR ghost from data/ghost.json
  const ghost = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'data', 'ghost.json'), 'utf8'));
  console.log('Ghost:', ghost.label, '·', (ghost.completedMs/1000).toFixed(3) + 's');

  // 2. Load today's file and extract the latest PB lap (78.791)
  const file = process.env.RECORDING ? path.resolve(__dirname, '..', 'recordings', process.env.RECORDING) : path.resolve(__dirname, '..', 'recordings', 'gt7-' + new Date().toISOString().slice(0,10) + '.jsonl');
  const TARGET_PB_MS = Number(process.env.PB_MS) || 78791;  // override with PB_MS env
  const stream = fs.createReadStream(file);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const packets = [];
  for await (const line of rl) {
    try {
      const p = JSON.parse(line);
      if (p.type === 'config' || !p.position) continue;
      if (p.carCode !== (Number(process.env.CAR_CODE) || 2166)) continue;  // override with CAR_CODE env
      packets.push({
        t: p.t, lap: p.lapCount, lastMs: p.lastLapTimeMs,
        x: p.position.x, z: p.position.z, speedKph: p.speedKph,
        throttle: p.throttle, brake: p.brake, gear: p.currentGear,
      });
    } catch {}
  }
  rl.close();

  // Find the PB lap
  let pbLap = null;
  let cs = 0;
  for (let i = 1; i < packets.length; i++) {
    if (packets[i].lap !== packets[i-1].lap) {
      const c = packets[i].lastMs;
      if (c === TARGET_PB_MS) {
        pbLap = { startIdx: cs, endIdx: i - 1 };
        break;
      }
      cs = i;
    }
  }
  if (!pbLap) { console.log('PB lap not found'); return; }
  console.log('PB lap packets:', pbLap.endIdx - pbLap.startIdx + 1);

  // Build PB XZ+speed trace at packet rate
  const pbTrace = [];
  const startT = packets[pbLap.startIdx].t;
  for (let i = pbLap.startIdx; i <= pbLap.endIdx; i++) {
    pbTrace.push({
      t: packets[i].t - startT,
      x: packets[i].x, z: packets[i].z,
      speedKph: packets[i].speedKph,
      brake: packets[i].brake, throttle: packets[i].throttle, gear: packets[i].gear,
    });
  }
  console.log('PB trace samples (full rate):', pbTrace.length);

  // 3. Sector boundaries — same algorithm as everywhere else: thirds of GHOST trace
  const wrTrace = ghost.trace;
  const wrLen = wrTrace.length;
  const wrS1End = Math.floor(wrLen / 3);
  const wrS2End = Math.floor(2 * wrLen / 3);
  console.log('Ghost S2 spans samples', wrS1End, 'to', wrS2End, '(t', wrTrace[wrS1End].t/1000, '→', wrTrace[wrS2End].t/1000, 's)');

  // 4. Walk the S2 portion of the WR ghost. For each WR sample, find the
  //    nearest XZ point in your PB trace. Compute lateral offset + speed
  //    delta.
  const samples = [];
  for (let k = wrS1End; k <= wrS2End; k++) {
    const wr = wrTrace[k];
    let bestIdx = -1, bestD2 = Infinity;
    for (let i = 0; i < pbTrace.length; i++) {
      const dx = pbTrace[i].x - wr.x;
      const dz = pbTrace[i].z - wr.z;
      const d2 = dx*dx + dz*dz;
      if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
    }
    if (bestIdx === -1) continue;
    const pb = pbTrace[bestIdx];
    samples.push({
      wrX: wr.x, wrZ: wr.z, wrSpeed: wr.speedKph,
      pbX: pb.x, pbZ: pb.z, pbSpeed: pb.speedKph,
      lateralM: Math.sqrt(bestD2),
      speedDeltaKph: wr.speedKph - pb.speedKph,
    });
  }

  // 5. Find apexes in S2 by local speed minima on the WR trace
  const apexes = [];
  for (let k = 5; k < samples.length - 5; k++) {
    const s = samples[k];
    let isLocalMin = true;
    for (let d = -5; d <= 5; d++) {
      if (d === 0) continue;
      if (samples[k + d].wrSpeed < s.wrSpeed) { isLocalMin = false; break; }
    }
    if (isLocalMin && s.wrSpeed < 200) apexes.push({ ...s, k });
  }
  console.log('S2 apexes (local speed minima on WR trace):', apexes.length);

  // 6. Print apex-by-apex comparison
  console.log('');
  console.log('=== S2 apex-by-apex: WR line vs your PB line ===');
  console.log('apex# | WR XZ              | PB XZ              | lateral | WR speed | PB speed | speed Δ');
  console.log('------+--------------------+--------------------+---------+----------+----------+--------');
  apexes.forEach((a, i) => {
    console.log(`  #${String(i+1).padStart(2)} | (${a.wrX.toFixed(0).padStart(4)},${a.wrZ.toFixed(0).padStart(4)})    | (${a.pbX.toFixed(0).padStart(4)},${a.pbZ.toFixed(0).padStart(4)})    | ${a.lateralM.toFixed(1).padStart(5)}m | ${a.wrSpeed.toFixed(0).padStart(5)} kph | ${a.pbSpeed.toFixed(0).padStart(5)} kph | ${a.speedDeltaKph >= 0 ? '+' : ''}${a.speedDeltaKph.toFixed(1)} kph`);
  });

  // 7. Aggregate stats
  const lats = samples.map(s => s.lateralM);
  const avgLat = lats.reduce((a,b) => a + b, 0) / lats.length;
  const maxLat = Math.max(...lats);
  const speedDeltas = samples.map(s => s.speedDeltaKph);
  const avgSpeedDelta = speedDeltas.reduce((a,b) => a + b, 0) / speedDeltas.length;
  const peakSpeedDelta = Math.max(...speedDeltas);
  console.log('');
  console.log('=== S2 aggregate (entire sector, not just apexes) ===');
  console.log('  Avg lateral offset:', avgLat.toFixed(2), 'm');
  console.log('  Max lateral offset:', maxLat.toFixed(2), 'm');
  console.log('  Avg speed delta (WR-PB):', (avgSpeedDelta >= 0 ? '+' : '') + avgSpeedDelta.toFixed(1), 'kph');
  console.log('  Peak speed delta (WR-PB):', '+' + peakSpeedDelta.toFixed(1), 'kph');

  // 8. The crucial test: at the apexes, is the WR "more open"? I.e., does
  //    the WR maintain greater distance from the apex point (less tight)?
  //    If avg lateral at apex > avg lateral elsewhere → he's running wider lines.
  const apexLats = apexes.map(a => a.lateralM);
  const apexAvgLat = apexLats.length ? apexLats.reduce((a,b) => a + b, 0) / apexLats.length : 0;
  console.log('  Avg lateral AT apexes:', apexAvgLat.toFixed(2), 'm');
  console.log('  → If apex-lateral > sector-avg-lateral, WR is taking wider apex lines.');
})();

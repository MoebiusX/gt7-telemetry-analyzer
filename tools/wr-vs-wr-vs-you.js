#!/usr/bin/env node
//
// Template analyzer — edit the constants at the top to match your data:
//   TARGET_PB_MS  — milliseconds of the lap you want as reference (e.g. 78791)
//   CAR_CODE      — GT7 car id from data/cars.json (e.g. 2166 for Alfa 4C Gr.4)
//   RECORDING     — recording filename in recordings/ (default: today)
//
// All three can be overridden via env vars: PB_MS, CAR_CODE, RECORDING
//
// Three-way comparison: old WR (1:17.710), new WR (1:17.682), and your PB (78.791).
// Finds places where BOTH WRs are doing the same thing AND you're doing
// something different — those are the patterns that define the WR driver's
// technique and the gap you need to close.

const fs = require('node:fs');
const readline = require('node:readline');
const path = require('node:path');

const SPEED_AGREE_KPH = 3;       // WRs agree on speed within this
const SPEED_DIFFER_KPH = 5;      // you differ from BOTH WRs by at least this
const INPUT_AGREE_PCT = 15;      // WRs agree on throttle/brake within this
const INPUT_DIFFER_PCT = 20;     // you differ from BOTH WRs by at least this

(async () => {
  // Load old and new WR traces.
  // GHOST_OLD env var → filename in data/ for the older reference (default: ghost-old.json).
  // You'll need to save a previous ghost.json under that name BEFORE registering a new one.
  const oldGhostFile = process.env.GHOST_OLD || 'ghost-old.json';
  const oldGhostPath = path.resolve(__dirname, '..', 'data', oldGhostFile);
  if (!fs.existsSync(oldGhostPath)) {
    console.error('Old ghost not found:', oldGhostPath);
    console.error('Backup an earlier ghost.json as data/' + oldGhostFile + ' before running, or set GHOST_OLD=other.json');
    process.exit(1);
  }
  const wrOld = JSON.parse(fs.readFileSync(oldGhostPath, 'utf8')).trace;
  const wrNew = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'data', 'ghost.json'), 'utf8')).trace;
  console.log('WR-old samples:', wrOld.length, '   WR-new samples:', wrNew.length);

  // Load your PB lap
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
      packets.push({ t: p.t, lap: p.lapCount, lastMs: p.lastLapTimeMs, x: p.position.x, y: p.position.y, z: p.position.z, speedKph: p.speedKph, throttle: p.throttle, brake: p.brake, gear: p.currentGear });
    } catch {}
  }
  rl.close();
  let pbLap = null, cs = 0;
  for (let i = 1; i < packets.length; i++) {
    if (packets[i].lap !== packets[i-1].lap) {
      if (packets[i].lastMs === TARGET_PB_MS) { pbLap = { startIdx: cs, endIdx: i-1 }; break; }
      cs = i;
    }
  }
  const pbTrace = [];
  const startT = packets[pbLap.startIdx].t;
  for (let i = pbLap.startIdx; i <= pbLap.endIdx; i++) {
    pbTrace.push({ t: packets[i].t - startT, x: packets[i].x, z: packets[i].z, speedKph: packets[i].speedKph, throttle: packets[i].throttle / 2.55, brake: packets[i].brake / 2.55, gear: packets[i].gear });
  }

  // For each sample in WR-new (the canonical reference), find nearest XZ in WR-old AND in your PB.
  // Then compare metrics.
  function nearest(trace, x, z) {
    let bestIdx = -1, bestD2 = Infinity;
    for (let i = 0; i < trace.length; i++) {
      const dx = trace[i].x - x, dz = trace[i].z - z;
      const d2 = dx*dx + dz*dz;
      if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
    }
    return bestIdx >= 0 ? trace[bestIdx] : null;
  }

  const samples = [];
  for (let k = 0; k < wrNew.length; k++) {
    const wn = wrNew[k];
    const wo = nearest(wrOld, wn.x, wn.z);
    const pb = nearest(pbTrace, wn.x, wn.z);
    if (!wo || !pb) continue;

    const wrAgree_speed = Math.abs(wn.speedKph - wo.speedKph) <= SPEED_AGREE_KPH;
    const wrAvgSpeed = (wn.speedKph + wo.speedKph) / 2;
    const youDiffer_speed = Math.abs(pb.speedKph - wrAvgSpeed) >= SPEED_DIFFER_KPH;

    const wnThr = (wn.throttle || 0) / 2.55;
    const woThr = (wo.throttle || 0) / 2.55;
    const wrAgree_thr = Math.abs(wnThr - woThr) <= INPUT_AGREE_PCT;
    const wrAvgThr = (wnThr + woThr) / 2;
    const youDiffer_thr = Math.abs(pb.throttle - wrAvgThr) >= INPUT_DIFFER_PCT;

    const wnBrk = (wn.brake || 0) / 2.55;
    const woBrk = (wo.brake || 0) / 2.55;
    const wrAgree_brk = Math.abs(wnBrk - woBrk) <= INPUT_AGREE_PCT;
    const wrAvgBrk = (wnBrk + woBrk) / 2;
    const youDiffer_brk = Math.abs(pb.brake - wrAvgBrk) >= INPUT_DIFFER_PCT;

    samples.push({
      k, x: wn.x, z: wn.z, t: wn.t,
      wrSpeed: wrAvgSpeed, youSpeed: pb.speedKph,
      wrThr: wrAvgThr, youThr: pb.throttle,
      wrBrk: wrAvgBrk, youBrk: pb.brake,
      wrGear: wn.gear, youGear: pb.gear,
      speedSignal: wrAgree_speed && youDiffer_speed,
      thrSignal:   wrAgree_thr   && youDiffer_thr,
      brkSignal:   wrAgree_brk   && youDiffer_brk,
    });
  }

  console.log('');
  console.log('Total reference samples:', samples.length);
  console.log('Samples where WRs AGREE on speed AND you differ:', samples.filter(s => s.speedSignal).length);
  console.log('Samples where WRs AGREE on throttle AND you differ:', samples.filter(s => s.thrSignal).length);
  console.log('Samples where WRs AGREE on brake AND you differ:', samples.filter(s => s.brkSignal).length);

  // Cluster the speed-signal samples into contiguous zones
  function clusterContiguous(samples, pred) {
    const zones = [];
    let cur = null;
    for (const s of samples) {
      if (pred(s)) {
        if (!cur) cur = { startK: s.k, endK: s.k, items: [s] };
        else if (s.k - cur.endK <= 5) { cur.endK = s.k; cur.items.push(s); }
        else { if (cur.items.length >= 4) zones.push(cur); cur = { startK: s.k, endK: s.k, items: [s] }; }
      }
    }
    if (cur && cur.items.length >= 4) zones.push(cur);
    return zones;
  }

  // Speed zones — where BOTH WRs are faster than you by 5+ kph
  const slowZones = clusterContiguous(samples, s => s.speedSignal && (s.wrSpeed > s.youSpeed));
  console.log('');
  console.log('=== ZONES WHERE BOTH WRs ARE CARRYING MORE SPEED THAN YOU (you are slower by 5+ kph, WRs agree within 3) ===');
  console.log('zone | mid XZ        | length (samples) | avg WR speed | avg your speed | avg delta | lap-t');
  slowZones.sort((a,b) => {
    const aDelta = a.items.reduce((sum,s) => sum + (s.wrSpeed - s.youSpeed), 0) / a.items.length;
    const bDelta = b.items.reduce((sum,s) => sum + (s.wrSpeed - s.youSpeed), 0) / b.items.length;
    return bDelta - aDelta;
  });
  slowZones.slice(0, 12).forEach((z, i) => {
    const mid = z.items[Math.floor(z.items.length / 2)];
    const avgWR = z.items.reduce((s,x) => s + x.wrSpeed, 0) / z.items.length;
    const avgYou = z.items.reduce((s,x) => s + x.youSpeed, 0) / z.items.length;
    const avgDelta = avgWR - avgYou;
    console.log(`  #${String(i+1).padStart(2)} | (${mid.x.toFixed(0).padStart(4)},${mid.z.toFixed(0).padStart(4)}) | ${String(z.items.length).padStart(3)} samples       | ${avgWR.toFixed(0).padStart(5)} kph    | ${avgYou.toFixed(0).padStart(5)} kph     | +${avgDelta.toFixed(1)} kph | ${(mid.t/1000).toFixed(2)}s`);
  });

  // Throttle zones — where BOTH WRs are on more throttle than you
  const thrZones = clusterContiguous(samples, s => s.thrSignal && (s.wrThr > s.youThr));
  console.log('');
  console.log('=== ZONES WHERE BOTH WRs HAVE MORE THROTTLE THAN YOU (you 20%+ less, WRs within 15% of each other) ===');
  console.log('zone | mid XZ        | length | WR thr | your thr | thr Δ | WR spd | your spd | lap-t');
  thrZones.sort((a,b) => {
    const aDelta = a.items.reduce((sum,s) => sum + (s.wrThr - s.youThr), 0) / a.items.length;
    const bDelta = b.items.reduce((sum,s) => sum + (s.wrThr - s.youThr), 0) / b.items.length;
    return bDelta - aDelta;
  });
  thrZones.slice(0, 12).forEach((z, i) => {
    const mid = z.items[Math.floor(z.items.length / 2)];
    const avgWRthr = z.items.reduce((s,x) => s + x.wrThr, 0) / z.items.length;
    const avgYouThr = z.items.reduce((s,x) => s + x.youThr, 0) / z.items.length;
    const avgWRspd = z.items.reduce((s,x) => s + x.wrSpeed, 0) / z.items.length;
    const avgYouSpd = z.items.reduce((s,x) => s + x.youSpeed, 0) / z.items.length;
    console.log(`  #${String(i+1).padStart(2)} | (${mid.x.toFixed(0).padStart(4)},${mid.z.toFixed(0).padStart(4)}) | ${String(z.items.length).padStart(3)}    | ${avgWRthr.toFixed(0).padStart(3)}%   | ${avgYouThr.toFixed(0).padStart(3)}%     | +${(avgWRthr - avgYouThr).toFixed(0)}%  | ${avgWRspd.toFixed(0).padStart(3)}    | ${avgYouSpd.toFixed(0).padStart(3)}      | ${(mid.t/1000).toFixed(2)}s`);
  });

  // Brake zones — where BOTH WRs have LESS brake than you (you over-braking) or MORE brake (you under-braking)
  const youOverBrake = clusterContiguous(samples, s => s.brkSignal && (s.youBrk > s.wrBrk));
  const youUnderBrake = clusterContiguous(samples, s => s.brkSignal && (s.youBrk < s.wrBrk));
  console.log('');
  console.log('=== ZONES WHERE YOU BRAKE MORE THAN BOTH WRs (over-braking) ===');
  console.log('zone | mid XZ        | length | WR brk | your brk | brk Δ | WR spd | your spd | lap-t');
  youOverBrake.sort((a,b) => {
    const aDelta = a.items.reduce((sum,s) => sum + (s.youBrk - s.wrBrk), 0) / a.items.length;
    const bDelta = b.items.reduce((sum,s) => sum + (s.youBrk - s.wrBrk), 0) / b.items.length;
    return bDelta - aDelta;
  });
  youOverBrake.slice(0, 8).forEach((z, i) => {
    const mid = z.items[Math.floor(z.items.length / 2)];
    const avgWRbrk = z.items.reduce((s,x) => s + x.wrBrk, 0) / z.items.length;
    const avgYouBrk = z.items.reduce((s,x) => s + x.youBrk, 0) / z.items.length;
    const avgWRspd = z.items.reduce((s,x) => s + x.wrSpeed, 0) / z.items.length;
    const avgYouSpd = z.items.reduce((s,x) => s + x.youSpeed, 0) / z.items.length;
    console.log(`  #${String(i+1).padStart(2)} | (${mid.x.toFixed(0).padStart(4)},${mid.z.toFixed(0).padStart(4)}) | ${String(z.items.length).padStart(3)}    | ${avgWRbrk.toFixed(0).padStart(3)}%   | ${avgYouBrk.toFixed(0).padStart(3)}%     | +${(avgYouBrk - avgWRbrk).toFixed(0)}%  | ${avgWRspd.toFixed(0).padStart(3)}    | ${avgYouSpd.toFixed(0).padStart(3)}      | ${(mid.t/1000).toFixed(2)}s`);
  });

  console.log('');
  console.log('=== ZONES WHERE YOU BRAKE LESS THAN BOTH WRs (under-braking — could be coasting instead of braking late) ===');
  console.log('zone | mid XZ        | length | WR brk | your brk | brk Δ | WR spd | your spd | lap-t');
  youUnderBrake.sort((a,b) => {
    const aDelta = a.items.reduce((sum,s) => sum + (s.wrBrk - s.youBrk), 0) / a.items.length;
    const bDelta = b.items.reduce((sum,s) => sum + (s.wrBrk - s.youBrk), 0) / b.items.length;
    return bDelta - aDelta;
  });
  youUnderBrake.slice(0, 8).forEach((z, i) => {
    const mid = z.items[Math.floor(z.items.length / 2)];
    const avgWRbrk = z.items.reduce((s,x) => s + x.wrBrk, 0) / z.items.length;
    const avgYouBrk = z.items.reduce((s,x) => s + x.youBrk, 0) / z.items.length;
    const avgWRspd = z.items.reduce((s,x) => s + x.wrSpeed, 0) / z.items.length;
    const avgYouSpd = z.items.reduce((s,x) => s + x.youSpeed, 0) / z.items.length;
    console.log(`  #${String(i+1).padStart(2)} | (${mid.x.toFixed(0).padStart(4)},${mid.z.toFixed(0).padStart(4)}) | ${String(z.items.length).padStart(3)}    | ${avgWRbrk.toFixed(0).padStart(3)}%   | ${avgYouBrk.toFixed(0).padStart(3)}%     | +${(avgWRbrk - avgYouBrk).toFixed(0)}%  | ${avgWRspd.toFixed(0).padStart(3)}    | ${avgYouSpd.toFixed(0).padStart(3)}      | ${(mid.t/1000).toFixed(2)}s`);
  });

  // Aggregate stats
  const totalDeltaSec = samples.reduce((s,x) => s + (x.wrSpeed - x.youSpeed), 0) / samples.length;
  console.log('');
  console.log('=== Aggregate over the whole lap ===');
  console.log(`  Avg speed delta (WR - you): +${totalDeltaSec.toFixed(2)} kph across the whole lap`);
  // Throttle on time
  const wrOnThrottleCount = samples.filter(s => s.wrThr > 80).length;
  const youOnThrottleCount = samples.filter(s => s.youThr > 80).length;
  const wrOnBrakeCount = samples.filter(s => s.wrBrk > 10).length;
  const youOnBrakeCount = samples.filter(s => s.youBrk > 10).length;
  console.log(`  WRs on throttle >80%: ${(100*wrOnThrottleCount/samples.length).toFixed(1)}% of lap`);
  console.log(`  YOU on throttle >80%: ${(100*youOnThrottleCount/samples.length).toFixed(1)}% of lap`);
  console.log(`  WRs on brake   >10%: ${(100*wrOnBrakeCount/samples.length).toFixed(1)}% of lap`);
  console.log(`  YOU on brake   >10%: ${(100*youOnBrakeCount/samples.length).toFixed(1)}% of lap`);
})();

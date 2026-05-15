#!/usr/bin/env node
// Extract brake zones from the WR lap and identify the
// "valley double chicane" + "penultimate downhill left".
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const FILE = path.resolve(__dirname, '..', 'recordings',
  'gt7-2026-05-06T17-14-57-957Z.jsonl');
const TARGET_MS = 91933; // WR lap

(async () => {
  const stream = fs.createReadStream(FILE);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  // Replay loops keep lapCount static — the only reliable marker is
  // a transition where p.lastLapTimeMs == TARGET_MS. The packet AT the
  // transition is the FIRST packet of the lap AFTER the WR lap.
  // Walk back TARGET_MS / (1000/60) ≈ 5516 packets to get the WR lap.
  const allPackets = [];
  let prev = null;
  const wrEndIndices = []; // indices where the WR lap just finished

  for await (const line of rl) {
    let p;
    try { p = JSON.parse(line); } catch { continue; }
    if (p.type === 'config') continue;
    if (typeof p.lapCount !== 'number') continue;
    allPackets.push(p);
    if (prev && (p.lapCount !== prev.lapCount || p.lastLapTimeMs !== prev.lastLapTimeMs)) {
      if (p.lastLapTimeMs === TARGET_MS) {
        wrEndIndices.push(allPackets.length - 1);
      }
    }
    prev = p;
  }
  rl.close();

  if (wrEndIndices.length === 0) {
    console.error('No WR lap end marker found.'); process.exit(1);
  }

  const PACKETS_PER_LAP = Math.round(TARGET_MS / (1000/60)); // 60 Hz
  // Pick a WR end whose preceding window has at least PACKETS_PER_LAP packets
  // since the previous lap-restart (lapCount 2→0). Otherwise window is partial.
  // Find the start by walking back from end and stopping at the lapCount=0→1 transition.
  let wrEndIdx = wrEndIndices[wrEndIndices.length - 1]; // prefer last (most complete)
  let wrStartIdx = wrEndIdx - 1;
  while (wrStartIdx > 0) {
    const a = allPackets[wrStartIdx - 1], b = allPackets[wrStartIdx];
    if (a.lapCount === 0 && b.lapCount === 1) break;
    wrStartIdx--;
  }
  // Sanity: window must be ~PACKETS_PER_LAP. If too short, fall back to first end.
  if (wrEndIdx - wrStartIdx < PACKETS_PER_LAP - 100) {
    wrEndIdx = wrEndIndices[0];
    wrStartIdx = wrEndIdx - 1;
    while (wrStartIdx > 0) {
      const a = allPackets[wrStartIdx - 1], b = allPackets[wrStartIdx];
      if (a.lapCount === 0 && b.lapCount === 1) break;
      wrStartIdx--;
    }
  }
  const wr = allPackets.slice(wrStartIdx, wrEndIdx);
  const wrLapNum = wr[0]?.lapCount ?? '?';
  console.log(`WR end marker at packet index ${wrEndIdx} (of ${allPackets.length}).`);
  console.log(`WR lap = packets[${wrStartIdx}..${wrEndIdx})  count=${wr.length}  duration≈${(wr.length/60).toFixed(2)}s  lapCount=${wrLapNum}\n`);

  // Cumulative distance along the lap (m)
  const dist = new Array(wr.length).fill(0);
  for (let i = 1; i < wr.length; i++) {
    const a = wr[i-1].position, b = wr[i].position;
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    dist[i] = dist[i-1] + Math.sqrt(dx*dx + dy*dy + dz*dz);
  }
  const totalDist = dist[dist.length-1];
  console.log(`Track length (single lap, this car's racing line): ${totalDist.toFixed(0)} m\n`);

  // Detect brake zones: brake > 25/255 sustained for >= 8 packets (~133ms)
  const BRAKE_THRESH = 25;
  const MIN_LEN = 8;
  const zones = [];
  let i = 0;
  while (i < wr.length) {
    if (wr[i].brake > BRAKE_THRESH) {
      let j = i;
      while (j < wr.length && wr[j].brake > BRAKE_THRESH/2) j++;
      if (j - i >= MIN_LEN) {
        // pad backwards a bit to catch coast/lift
        const startIdx = i;
        const endIdx = j - 1;
        // find min speed in zone (and a bit after, while throttle still low)
        let minSpdIdx = startIdx;
        let scanEnd = Math.min(wr.length-1, endIdx + 30);
        for (let k = startIdx; k <= scanEnd; k++) {
          if (wr[k].speedKph < wr[minSpdIdx].speedKph) minSpdIdx = k;
        }
        // peak brake
        let peakBrake = 0;
        for (let k = startIdx; k <= endIdx; k++)
          if (wr[k].brake > peakBrake) peakBrake = wr[k].brake;
        zones.push({ startIdx, endIdx, minSpdIdx, peakBrake });
      }
      i = j;
    } else i++;
  }

  // Tag each zone
  const tag = (z) => {
    const s = wr[z.startIdx], m = wr[z.minSpdIdx], e = wr[z.endIdx];
    const lapPct = (dist[z.minSpdIdx] / totalDist * 100).toFixed(1);
    return {
      ...z,
      lapPct,
      distAtBrake: dist[z.startIdx],
      distAtApex:  dist[z.minSpdIdx],
      entrySpeed:  s.speedKph,
      minSpeed:    m.speedKph,
      entryGear:   s.currentGear,
      apexGear:    m.currentGear,
      peakBrakePct:(z.peakBrake / 255 * 100),
      throttleReleaseSpd: null, // computed below
      yEntry: s.position.y,
      yApex:  m.position.y,
      yDrop:  s.position.y - m.position.y,
      xApex:  m.position.x,
      zApex:  m.position.z,
      // yaw change across zone: sign tells L/R turn
      yawDelta: (m.rotation?.yaw ?? 0) - (s.rotation?.yaw ?? 0),
    };
  };

  const tagged = zones.map(tag);

  // Throttle-release point (speed at which driver lifted before brake)
  for (let zi = 0; zi < tagged.length; zi++) {
    const z = tagged[zi];
    // walk back from z.startIdx until throttle > 200/255 (≈80%)
    let k = z.startIdx;
    while (k > 0 && wr[k].throttle < 200) k--;
    z.throttleReleaseSpd = wr[k].speedKph;
    z.throttleReleaseDist = dist[k];
  }

  console.log(`Detected ${tagged.length} brake zones in WR lap.\n`);
  console.log('# │  lap%  │ entry-spd│ apex-spd │ Δ km/h │ gear E→A │ brk% │ ΔY (m) │ X,Z apex            │ turn');
  console.log('──┼────────┼──────────┼──────────┼────────┼──────────┼──────┼────────┼─────────────────────┼─────');
  tagged.forEach((z, i) => {
    const turn = z.yawDelta > 0.05 ? 'L' : z.yawDelta < -0.05 ? 'R' : '·';
    console.log(
      `${String(i+1).padStart(2)} │ ${String(z.lapPct).padStart(5)}% │ ` +
      `${z.entrySpeed.toFixed(1).padStart(7)} │ ${z.minSpeed.toFixed(1).padStart(7)} │ ` +
      `${(z.entrySpeed - z.minSpeed).toFixed(1).padStart(6)} │ ` +
      `${String(z.entryGear).padStart(3)}→${z.apexGear} │ ${z.peakBrakePct.toFixed(0).padStart(3)}% │ ` +
      `${z.yDrop.toFixed(1).padStart(6)} │ (${z.xApex.toFixed(0).padStart(5)},${z.zApex.toFixed(0).padStart(5)}) │  ${turn}`
    );
  });

  // Identify the two corners of interest
  // 1) "Valley double chicane": find a pair of consecutive zones where
  //    both have low Y (below median Y), and the gap between them is short (<150m)
  const yApexes = tagged.map(z => z.yApex);
  const yMedian = [...yApexes].sort((a,b)=>a-b)[Math.floor(yApexes.length/2)];
  let chicaneIdx = -1;
  for (let i = 0; i < tagged.length-1; i++) {
    const gap = tagged[i+1].distAtBrake - tagged[i].distAtApex;
    if (tagged[i].yApex < yMedian && tagged[i+1].yApex < yMedian && gap < 200) {
      // Pick the pair with the largest combined Y-drop
      if (chicaneIdx === -1 ||
          (tagged[i].yDrop + tagged[i+1].yDrop) > (tagged[chicaneIdx].yDrop + tagged[chicaneIdx+1].yDrop)) {
        chicaneIdx = i;
      }
    }
  }

  // 2) "Penultimate downhill left" — second-to-last brake zone of the lap
  const penIdx = tagged.length - 2;

  console.log('\n──── Corner-of-interest summary ────');
  if (chicaneIdx >= 0) {
    const a = tagged[chicaneIdx], b = tagged[chicaneIdx+1];
    console.log(`\nVALLEY DOUBLE CHICANE (zones ${chicaneIdx+1} & ${chicaneIdx+2}, lap ${a.lapPct}%-${b.lapPct}%)`);
    console.log(`  zone A  brake @ ${a.entrySpeed.toFixed(0)} km/h  →  apex ${a.minSpeed.toFixed(0)} km/h  gear ${a.entryGear}→${a.apexGear}  peak brake ${a.peakBrakePct.toFixed(0)}%  Y drop ${a.yDrop.toFixed(1)}m`);
    console.log(`  zone B  brake @ ${b.entrySpeed.toFixed(0)} km/h  →  apex ${b.minSpeed.toFixed(0)} km/h  gear ${b.entryGear}→${b.apexGear}  peak brake ${b.peakBrakePct.toFixed(0)}%  Y drop ${b.yDrop.toFixed(1)}m`);
    console.log(`  gap between A apex and B brake-on: ${(b.distAtBrake - a.distAtApex).toFixed(0)} m`);
  } else {
    console.log('\nNo close-spaced low-elevation pair detected — corner detection may need tuning.');
  }
  if (penIdx >= 0) {
    const p = tagged[penIdx];
    const turn = p.yawDelta > 0.05 ? 'LEFT' : p.yawDelta < -0.05 ? 'RIGHT' : 'STRAIGHT';
    console.log(`\nPENULTIMATE BRAKE ZONE (zone ${penIdx+1}, lap ${p.lapPct}%) — turn direction: ${turn}`);
    console.log(`  brake @ ${p.entrySpeed.toFixed(0)} km/h  →  apex ${p.minSpeed.toFixed(0)} km/h  gear ${p.entryGear}→${p.apexGear}  peak brake ${p.peakBrakePct.toFixed(0)}%`);
    console.log(`  elevation:  entry Y=${p.yEntry.toFixed(1)} → apex Y=${p.yApex.toFixed(1)}  (drop ${p.yDrop.toFixed(1)} m)`);
    console.log(`  X,Z apex: (${p.xApex.toFixed(0)}, ${p.zApex.toFixed(0)})`);
    console.log(`  throttle-up reference: lift was at ${p.throttleReleaseSpd.toFixed(0)} km/h, ${(p.distAtBrake - p.throttleReleaseDist).toFixed(0)}m before brake-on`);
  }

  // Also save per-zone telemetry traces for the two corners to JSON for the report
  function traceZone(z, padBefore = 30, padAfter = 60) {
    const a = Math.max(0, z.startIdx - padBefore);
    const b = Math.min(wr.length - 1, z.endIdx + padAfter);
    const out = [];
    for (let k = a; k <= b; k++) {
      const pkt = wr[k];
      out.push({
        d: dist[k] - dist[a],
        spd: pkt.speedKph,
        brk: pkt.brake / 255 * 100,
        thr: pkt.throttle / 255 * 100,
        gear: pkt.currentGear,
        y: pkt.position.y,
        x: pkt.position.x,
        z: pkt.position.z,
      });
    }
    return out;
  }

  const out = {
    wrFile: path.basename(FILE),
    wrLapNum,
    wrLapTimeMs: TARGET_MS,
    trackLengthM: totalDist,
    brakeZones: tagged.map(z => ({
      lapPct: z.lapPct,
      entrySpeed: +z.entrySpeed.toFixed(1),
      minSpeed: +z.minSpeed.toFixed(1),
      entryGear: z.entryGear,
      apexGear: z.apexGear,
      peakBrakePct: +z.peakBrakePct.toFixed(0),
      yEntry: +z.yEntry.toFixed(1),
      yApex: +z.yApex.toFixed(1),
      yDrop: +z.yDrop.toFixed(1),
      xApex: +z.xApex.toFixed(1),
      zApex: +z.zApex.toFixed(1),
    })),
    chicane: chicaneIdx >= 0 ? {
      indices: [chicaneIdx, chicaneIdx+1],
      traceA: traceZone(tagged[chicaneIdx]),
      traceB: traceZone(tagged[chicaneIdx+1]),
    } : null,
    penultimate: penIdx >= 0 ? {
      index: penIdx,
      trace: traceZone(tagged[penIdx]),
    } : null,
  };
  fs.writeFileSync(path.resolve(__dirname, 'wr-corners.json'),
    JSON.stringify(out, null, 2));
  console.log('\nFull traces written to tools/wr-corners.json');
})();

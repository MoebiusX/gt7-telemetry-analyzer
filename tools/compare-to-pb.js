#!/usr/bin/env node
// Generate a self-contained HTML report comparing the most recent completed lap
// to the session PB. No Grafana, no Prometheus — reads the JSONL recording
// directly and emits an HTML file with embedded SVG track map + traces.
//
// Usage:
//   node tools/compare-to-pb.js                # latest recording, latest lap vs PB
//   node tools/compare-to-pb.js --file FILE    # specific recording
//   node tools/compare-to-pb.js --lap N        # compare lap N instead of most recent
//
// Output: recordings/compare-YYYY-MM-DD-HHMMSS.html (and prints the path)

const fs   = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const RECORD_DIR = path.resolve(__dirname, '..', 'recordings');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  return process.argv[i + 1];
}

async function loadPackets(file, carCode) {
  const packets = [];
  const stream = fs.createReadStream(file);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    try {
      const p = JSON.parse(line);
      if (p.type === 'config') continue;
      if (!p.position || typeof p.lapCount !== 'number') continue;
      if (carCode != null && p.carCode !== carCode) continue;
      packets.push({
        t:        p.t,
        lap:      p.lapCount,
        lastMs:   p.lastLapTimeMs,
        bestMs:   p.bestLapTimeMs,
        carCode:  p.carCode,
        x:        p.position.x,
        z:        p.position.z,
        speedKph: p.speedKph,
        throttle: p.throttle,
        brake:    p.brake,
        gear:     p.currentGear,
        rpm:      p.engineRpm,
      });
    } catch {}
  }
  rl.close();
  return packets;
}

function sliceLaps(packets) {
  const laps = [];
  let curStart = 0;
  for (let i = 1; i < packets.length; i++) {
    if (packets[i].lap !== packets[i-1].lap) {
      const completedMs = packets[i].lastMs;
      // Wall-clock duration of the captured packets for this lap. If GT7 only
      // sent a fraction of the lap (session restart, pause, disconnect), the
      // reported lastLapTimeMs is from the prior session — skip it.
      const wallMs = packets[i-1].t - packets[curStart].t;
      if (typeof completedMs === 'number' && completedMs > 30_000 && completedMs < 600_000 &&
          wallMs > completedMs * 0.9) {
        laps.push({ num: packets[i-1].lap, startIdx: curStart, endIdx: i - 1, completedMs });
      }
      curStart = i;
    }
  }
  return laps;
}

// Walk the lap forward, matching each packet to its nearest PB-trace sample
// via a windowed search. Sector transitions are detected when the matched
// trace index crosses 1/3 and 2/3 boundaries. Mirrors the live predictor.
function sectorTimesForLap(packets, lap, pbTrace) {
  const s1EndIdx = Math.floor(pbTrace.length / 3);
  const s2EndIdx = Math.floor(2 * pbTrace.length / 3);
  const startT = packets[lap.startIdx].t;

  let lastMatchIdx = 0;
  let currentSector = 1;
  const enterTimes = [0, null, null];

  for (let i = lap.startIdx; i <= lap.endIdx; i++) {
    const cx = packets[i].x, cz = packets[i].z;
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
    // Only allow forward progression. This protects against the car wandering
    // back across a boundary because of XZ noise near the line.
    if (newSector === currentSector + 1) {
      enterTimes[newSector - 1] = packets[i].t - startT;
      currentSector = newSector;
    }
  }

  if (enterTimes[1] == null || enterTimes[2] == null) return null;
  const s1 = enterTimes[1] - enterTimes[0];
  const s2 = enterTimes[2] - enterTimes[1];
  const s3 = lap.completedMs - enterTimes[2];
  if (s1 <= 0 || s2 <= 0 || s3 <= 0) return null;
  // Sanity: sectors should sum to roughly the lap time. Reject obvious bad fits.
  const sum = s1 + s2 + s3;
  if (Math.abs(sum - lap.completedMs) > 500) return null;
  return [s1, s2, s3];
}

function fmtMs(ms) {
  if (ms == null) return '—';
  const s = ms / 1000;
  return s.toFixed(3) + 's';
}

function fmtDelta(ms) {
  if (ms == null) return '—';
  const s = ms / 1000;
  if (s === 0) return '0.000s';
  return (s > 0 ? '+' : '') + s.toFixed(3) + 's';
}

// Project XZ trace into an SVG viewBox
function buildSvgPaths(traceA, traceB, viewBox) {
  const all = [...traceA, ...traceB];
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of all) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  const padX = (maxX - minX) * 0.05 || 1;
  const padZ = (maxZ - minZ) * 0.05 || 1;
  minX -= padX; maxX += padX; minZ -= padZ; maxZ += padZ;
  const w = viewBox.w, h = viewBox.h;
  function project(p) {
    const xn = (p.x - minX) / (maxX - minX);
    const zn = (p.z - minZ) / (maxZ - minZ);
    // Flip Z so "north" on the GT7 map is up on the SVG
    return [xn * w, (1 - zn) * h];
  }
  function pathFor(trace) {
    if (!trace.length) return '';
    const [x0, y0] = project(trace[0]);
    let d = `M ${x0.toFixed(1)} ${y0.toFixed(1)}`;
    for (let i = 1; i < trace.length; i++) {
      const [x, y] = project(trace[i]);
      d += ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
    }
    return d;
  }
  return { pbPath: pathFor(traceA), lapPath: pathFor(traceB), project };
}

(async () => {
  const FILE_ARG = arg('--file');
  let file;
  if (FILE_ARG) {
    file = path.isAbsolute(FILE_ARG) ? FILE_ARG : path.join(RECORD_DIR, FILE_ARG);
  } else {
    const files = fs.readdirSync(RECORD_DIR)
      .filter(f => /^gt7-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .map(f => path.join(RECORD_DIR, f))
      .sort();
    file = files[files.length - 1];
  }
  if (!file || !fs.existsSync(file)) {
    console.error('No recording file found.');
    process.exit(1);
  }
  console.log(`Reading ${path.basename(file)} ...`);

  // First pass to find dominant carCode
  let mainCar = null;
  {
    const counts = new Map();
    const stream = fs.createReadStream(file);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      try {
        const p = JSON.parse(line);
        if (p.type === 'config' || !p.carCode) continue;
        counts.set(p.carCode, (counts.get(p.carCode) || 0) + 1);
      } catch {}
      if (counts.size > 0 && Math.random() < 0.001) break; // sampled enough
    }
    rl.close();
    let max = 0;
    for (const [cc, n] of counts) if (n > max) { max = n; mainCar = cc; }
  }
  console.log(`Dominant car: ${mainCar}`);

  const packets = await loadPackets(file, mainCar);
  let laps = sliceLaps(packets);
  console.log(`Loaded ${packets.length} packets, ${laps.length} candidate laps`);
  if (laps.length < 2) { console.error('Need at least 2 complete laps.'); process.exit(1); }

  // Sanity-filter laps: anchor on the 5th-percentile lap (a robust proxy for
  // "real fast laps for this track") and drop anything outside [0.97×, 1.30×]
  // of it. Catches partial laps that survived the wall-clock filter and laps
  // from a different track recorded with the same car.
  {
    const sorted = laps.map(l => l.completedMs).sort((a,b) => a-b);
    const fastAnchor = sorted[Math.max(0, Math.floor(sorted.length * 0.05))];
    const before = laps.length;
    laps = laps.filter(l => l.completedMs >= fastAnchor * 0.97 && l.completedMs <= fastAnchor * 1.30);
    if (before !== laps.length) {
      console.log(`Filtered to ${laps.length} laps in ${(fastAnchor*0.97/1000).toFixed(1)}–${(fastAnchor*1.30/1000).toFixed(1)}s range (anchor ${(fastAnchor/1000).toFixed(3)}s)`);
    }
  }

  // PB lap = the fastest lap exactly. Tie-break: pick the latest one (more
  // representative of the current setup).
  let pbMs = Infinity;
  for (const lap of laps) if (lap.completedMs < pbMs) pbMs = lap.completedMs;
  let pb = null;
  for (let i = laps.length - 1; i >= 0; i--) {
    if (laps[i].completedMs === pbMs) { pb = laps[i]; break; }
  }

  // Target lap to compare
  const lapArg = arg('--lap');
  let target;
  if (lapArg) {
    target = laps.find(l => String(l.num) === String(lapArg));
    if (!target) { console.error(`Lap ${lapArg} not found.`); process.exit(1); }
  } else {
    target = laps[laps.length - 1] === pb ? laps[laps.length - 2] : laps[laps.length - 1];
  }

  console.log(`PB:     lap #${pb.num} = ${fmtMs(pb.completedMs)}`);
  console.log(`Target: lap #${target.num} = ${fmtMs(target.completedMs)} (Δ${fmtDelta(target.completedMs - pb.completedMs)})`);

  // Build PB trace (sampled at 20Hz for the SVG, full-res for traces)
  function buildTrace(lap) {
    const arr = [];
    for (let i = lap.startIdx; i <= lap.endIdx; i++) {
      arr.push({
        x: packets[i].x, z: packets[i].z,
        t: packets[i].t - packets[lap.startIdx].t,
        speedKph: packets[i].speedKph,
        throttle: packets[i].throttle,
        brake: packets[i].brake,
        gear: packets[i].gear,
        rpm: packets[i].rpm,
      });
    }
    return arr;
  }
  const pbTrace     = buildTrace(pb);
  const targetTrace = buildTrace(target);

  // Sector boundaries from PB trace
  const s1End = pbTrace[Math.floor(pbTrace.length / 3)];
  const s2End = pbTrace[Math.floor(2 * pbTrace.length / 3)];
  const pbSectors     = sectorTimesForLap(packets, pb, pbTrace) || [null,null,null];
  const targetSectors = sectorTimesForLap(packets, target, pbTrace) || [null,null,null];

  // Theoretical best across ALL laps. To survive partial-lap artifacts that
  // slip past the slicer, drop any lap whose sectors sum to materially less
  // than its reported completion time.
  // Reject laps with anomalous sector splits — if any single sector is < 70%
  // of the PB's equivalent sector, the driver likely went off-track and the
  // matcher caught up at the rejoin point, producing meaningless splits.
  let bestS1 = Infinity, bestS2 = Infinity, bestS3 = Infinity;
  let bestS1Lap = null, bestS2Lap = null, bestS3Lap = null;
  let bestS1FullSec = null, bestS2FullSec = null, bestS3FullSec = null;
  let validLaps = 0;
  for (const lap of laps) {
    const sec = sectorTimesForLap(packets, lap, pbTrace);
    if (!sec) continue;
    const sum = sec[0] + sec[1] + sec[2];
    if (Math.abs(sum - lap.completedMs) > 200) continue;
    if (pbSectors[0] && pbSectors[1] && pbSectors[2]) {
      if (sec[0] < pbSectors[0] * 0.7) continue;
      if (sec[1] < pbSectors[1] * 0.7) continue;
      if (sec[2] < pbSectors[2] * 0.7) continue;
    }
    validLaps++;
    if (sec[0] < bestS1) { bestS1 = sec[0]; bestS1Lap = lap; bestS1FullSec = sec; }
    if (sec[1] < bestS2) { bestS2 = sec[1]; bestS2Lap = lap; bestS2FullSec = sec; }
    if (sec[2] < bestS3) { bestS3 = sec[2]; bestS3Lap = lap; bestS3FullSec = sec; }
  }
  console.log(`Sector data captured for ${validLaps} / ${laps.length} laps`);
  const theoretical = bestS1 + bestS2 + bestS3;

  // Build SVG (track map)
  const SVG_W = 800, SVG_H = 500;
  const { pbPath, lapPath, project } = buildSvgPaths(
    pbTrace.filter((_, i) => i % 2 === 0),
    targetTrace.filter((_, i) => i % 2 === 0),
    { w: SVG_W, h: SVG_H }
  );
  const [s1x, s1y] = project(s1End);
  const [s2x, s2y] = project(s2End);

  // Speed / pedal traces over time (downsampled to ~20Hz for size)
  function downsample(trace, stepMs = 50) {
    const out = [];
    let nextT = 0;
    for (const p of trace) {
      if (p.t >= nextT) { out.push(p); nextT = p.t + stepMs; }
    }
    return out;
  }
  const pbDs     = downsample(pbTrace);
  const targetDs = downsample(targetTrace);

  // Render HTML
  const dateStr = new Date().toISOString().replace(/[:T]/g,'-').slice(0,19);
  const outPath = path.join(RECORD_DIR, `compare-${dateStr}.html`);
  const html = `<!doctype html>
<html><head><meta charset="utf-8">
<title>GT7 PB compare — ${path.basename(file)}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background:#0a0e1a; color:#e0e6f0; margin:0; padding:24px; }
  h1 { margin:0 0 4px 0; font-weight:300; }
  .sub { color:#7a8499; font-size:13px; margin-bottom:24px; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:20px; margin-top:20px; }
  .panel { background:#0f1626; border:1px solid #1f2a44; border-radius:8px; padding:18px; }
  .panel h2 { margin:0 0 12px 0; font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:#8aa0d0; font-weight:600; }
  table { width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums; }
  th, td { padding:6px 10px; text-align:right; border-bottom:1px solid #1a2238; }
  th:first-child, td:first-child { text-align:left; }
  th { color:#7a8499; font-weight:500; font-size:12px; }
  td { font-size:14px; }
  .pb { color:#b388ff; }
  .target { color:#fff; }
  .delta-pos { color:#ff5252; }
  .delta-neg { color:#00e676; }
  svg { width:100%; height:auto; display:block; background:#070b14; border-radius:6px; }
  .pb-line { fill:none; stroke:#b388ff; stroke-width:2; opacity:.85; }
  .target-line { fill:none; stroke:#fff; stroke-width:2; opacity:.85; }
  .sector-marker { stroke:#ffeb3b; stroke-width:1; }
  .legend { display:flex; gap:18px; margin:8px 0 0 0; font-size:12px; color:#9aa6c0; }
  .legend span::before { content:"■"; margin-right:4px; }
  .legend .pb-key::before { color:#b388ff; }
  .legend .lap-key::before { color:#fff; }
  .legend .sector-key::before { color:#ffeb3b; }
  canvas { display:block; width:100%; height:140px; background:#070b14; border-radius:6px; }
  .row2 { display:grid; grid-template-columns:1fr; gap:10px; }
</style>
</head>
<body>
<h1>PB Compare</h1>
<div class="sub">${path.basename(file)} · car ${mainCar} · ${laps.length} laps · PB lap #${pb.num} = ${fmtMs(pb.completedMs)} · target lap #${target.num} = ${fmtMs(target.completedMs)}</div>

<div class="grid">
  <div class="panel">
    <h2>Lap times</h2>
    <table>
      <tr><th></th><th>PB lap</th><th>Target lap</th><th>Δ</th><th>Theoretical best</th></tr>
      <tr><td>Total</td><td class="pb">${fmtMs(pb.completedMs)}</td><td class="target">${fmtMs(target.completedMs)}</td><td class="${target.completedMs >= pb.completedMs ? 'delta-pos' : 'delta-neg'}">${fmtDelta(target.completedMs - pb.completedMs)}</td><td>${fmtMs(theoretical)}</td></tr>
      <tr><td>Sector 1</td><td class="pb">${fmtMs(pbSectors[0])}</td><td class="target">${fmtMs(targetSectors[0])}</td><td class="${(targetSectors[0]||0) >= (pbSectors[0]||0) ? 'delta-pos' : 'delta-neg'}">${fmtDelta((targetSectors[0]||0) - (pbSectors[0]||0))}</td><td>${fmtMs(bestS1)}${bestS1Lap ? ' (lap #'+bestS1Lap.num+', '+fmtMs(bestS1Lap.completedMs)+' total)' : ''}</td></tr>
      <tr><td>Sector 2</td><td class="pb">${fmtMs(pbSectors[1])}</td><td class="target">${fmtMs(targetSectors[1])}</td><td class="${(targetSectors[1]||0) >= (pbSectors[1]||0) ? 'delta-pos' : 'delta-neg'}">${fmtDelta((targetSectors[1]||0) - (pbSectors[1]||0))}</td><td>${fmtMs(bestS2)}${bestS2Lap ? ' (lap #'+bestS2Lap.num+', '+fmtMs(bestS2Lap.completedMs)+' total)' : ''}</td></tr>
      <tr><td>Sector 3</td><td class="pb">${fmtMs(pbSectors[2])}</td><td class="target">${fmtMs(targetSectors[2])}</td><td class="${(targetSectors[2]||0) >= (pbSectors[2]||0) ? 'delta-pos' : 'delta-neg'}">${fmtDelta((targetSectors[2]||0) - (pbSectors[2]||0))}</td><td>${fmtMs(bestS3)}${bestS3Lap ? ' (lap #'+bestS3Lap.num+', '+fmtMs(bestS3Lap.completedMs)+' total)' : ''}</td></tr>
    </table>
    <div class="legend">
      <span class="pb-key">PB lap</span>
      <span class="lap-key">Target lap</span>
      <span class="sector-key">Sector splits</span>
    </div>
  </div>

  <div class="panel">
    <h2>Track map (PB vs target)</h2>
    <svg viewBox="0 0 ${SVG_W} ${SVG_H}" xmlns="http://www.w3.org/2000/svg">
      <path class="pb-line" d="${pbPath}"/>
      <path class="target-line" d="${lapPath}"/>
      <circle cx="${s1x.toFixed(1)}" cy="${s1y.toFixed(1)}" r="6" fill="#ffeb3b"/>
      <text x="${(s1x+10).toFixed(1)}" y="${(s1y-10).toFixed(1)}" fill="#ffeb3b" font-size="13">S1→S2</text>
      <circle cx="${s2x.toFixed(1)}" cy="${s2y.toFixed(1)}" r="6" fill="#ffeb3b"/>
      <text x="${(s2x+10).toFixed(1)}" y="${(s2y-10).toFixed(1)}" fill="#ffeb3b" font-size="13">S2→S3</text>
    </svg>
  </div>
</div>

<div class="grid">
  <div class="panel">
    <h2>Speed (km/h) over lap time</h2>
    <canvas id="speedChart" width="800" height="200"></canvas>
  </div>
  <div class="panel">
    <h2>Throttle / Brake over lap time</h2>
    <canvas id="pedalChart" width="800" height="200"></canvas>
  </div>
</div>

<script>
const pbTrace     = ${JSON.stringify(pbDs.map(p => ({ t: p.t, s: p.speedKph, th: p.throttle, br: p.brake, g: p.gear })))};
const targetTrace = ${JSON.stringify(targetDs.map(p => ({ t: p.t, s: p.speedKph, th: p.throttle, br: p.brake, g: p.gear })))};
const maxT = Math.max(pbTrace[pbTrace.length-1].t, targetTrace[targetTrace.length-1].t);

function drawLine(ctx, w, h, trace, getter, max, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < trace.length; i++) {
    const x = (trace[i].t / maxT) * w;
    const y = h - (getter(trace[i]) / max) * h;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function drawChart(canvasId, getter, max) {
  const c = document.getElementById(canvasId);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#070b14'; ctx.fillRect(0, 0, c.width, c.height);
  // Gridlines
  ctx.strokeStyle = '#1a2238'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = (i / 4) * c.height;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(c.width, y); ctx.stroke();
  }
  drawLine(ctx, c.width, c.height, pbTrace,     getter, max, '#b388ff');
  drawLine(ctx, c.width, c.height, targetTrace, getter, max, '#ffffff');
}

drawChart('speedChart', p => p.s, 280);
const pc = document.getElementById('pedalChart');
const pctx = pc.getContext('2d');
pctx.fillStyle = '#070b14'; pctx.fillRect(0, 0, pc.width, pc.height);
pctx.strokeStyle = '#1a2238'; pctx.lineWidth = 1;
for (let i = 0; i <= 4; i++) {
  const y = (i / 4) * pc.height;
  pctx.beginPath(); pctx.moveTo(0, y); pctx.lineTo(pc.width, y); pctx.stroke();
}
drawLine(pctx, pc.width, pc.height, pbTrace,     p => p.th, 255, 'rgba(0,230,118,.55)');
drawLine(pctx, pc.width, pc.height, targetTrace, p => p.th, 255, 'rgba(0,230,118,1)');
drawLine(pctx, pc.width, pc.height, pbTrace,     p => p.br, 255, 'rgba(255,82,82,.55)');
drawLine(pctx, pc.width, pc.height, targetTrace, p => p.br, 255, 'rgba(255,82,82,1)');
</script>

</body></html>`;
  fs.writeFileSync(outPath, html);
  console.log('');
  console.log(`Wrote: ${outPath}`);
})();

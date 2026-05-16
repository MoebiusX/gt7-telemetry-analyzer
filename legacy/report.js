#!/usr/bin/env node
// Build a lap-by-lap report from a recorded GT7 telemetry session.
// Emits a CLI table + a self-contained HTML dashboard (Chart.js via CDN).
//
//   node report.js                              # newest recording
//   node report.js recordings/gt7-XYZ.jsonl

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { formatLapTime } = require('../src/capture/parser');

const RECORD_DIR = path.resolve(__dirname, '..', 'recordings');

function pickFile() {
  const arg = process.argv[2];
  if (arg) return path.resolve(arg);
  const files = fs.readdirSync(RECORD_DIR)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => path.join(RECORD_DIR, f))
    .map(p => ({ p, mtime: fs.statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!files.length) { console.error('no recordings'); process.exit(1); }
  return files[0].p;
}

function avg(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function max(a) { return a.length ? Math.max(...a) : 0; }
function min(a) { return a.length ? Math.min(...a) : 0; }

// Split a recording into independent sessions. A new session begins when:
//   - lapCount drops (e.g. 5 -> 0 / new race)
//   - the carCode changes
//   - more than GAP_S seconds elapse with no packets (game paused / menu)
// Returns an array of session objects: { byLap, firstTs, lastTs, officialLapMs, carCode, packetCount }.
const SESSION_GAP_MS = 8_000;

async function loadSessions(file) {
  const stream = fs.createReadStream(file);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const sessions = [];
  let cur = null;
  let pktTotal = 0;
  let prevLap = null;
  let prevTs  = null;
  let prevCar = null;

  function startSession(p) {
    cur = {
      byLap: new Map(),
      officialLapMs: new Map(),
      firstTs: p.t,
      lastTs: p.t,
      carCode: p.carCode ?? null,
      packetCount: 0,
    };
    sessions.push(cur);
    prevLap = null;
  }

  for await (const line of rl) {
    if (!line.trim()) continue;
    let p;
    try { p = JSON.parse(line); } catch { continue; }
    pktTotal++;

    const L = p.lapCount;
    if (L == null) continue;

    const lapReset = (prevLap != null && L < prevLap);
    const carChange = (prevCar != null && p.carCode != null && p.carCode !== prevCar);
    const longGap   = (prevTs != null && (p.t - prevTs) > SESSION_GAP_MS);

    if (!cur || lapReset || carChange || longGap) {
      startSession(p);
    }

    cur.lastTs = p.t;
    cur.packetCount++;
    if (!cur.byLap.has(L)) cur.byLap.set(L, []);
    cur.byLap.get(L).push(p);

    if (prevLap != null && L === prevLap + 1 && p.lastLapTimeMs > 0) {
      if (!cur.officialLapMs.has(prevLap)) cur.officialLapMs.set(prevLap, p.lastLapTimeMs);
    }
    prevLap = L;
    prevTs  = p.t;
    prevCar = p.carCode ?? prevCar;
  }

  return { sessions, pktTotal };
}

function summarizeLap(packets) {
  const speeds   = packets.map(p => p.speedKph);
  const rpms     = packets.map(p => p.engineRpm);
  const throttle = packets.map(p => p.throttle / 2.55);
  const brake    = packets.map(p => p.brake / 2.55);
  const fuel     = packets.map(p => p.fuelLevel);
  const tFL = packets.map(p => p.tireTempC?.fl ?? 0);
  const tFR = packets.map(p => p.tireTempC?.fr ?? 0);
  const tRL = packets.map(p => p.tireTempC?.rl ?? 0);
  const tRR = packets.map(p => p.tireTempC?.rr ?? 0);
  return {
    nPackets:    packets.length,
    durationS:   packets.length / 60,
    maxSpeed:    max(speeds),
    avgSpeed:    avg(speeds),
    minSpeed:    min(speeds),
    maxRpm:      max(rpms),
    avgThrottle: avg(throttle),
    avgBrake:    avg(brake),
    fuelStart:   fuel[0] ?? 0,
    fuelEnd:     fuel[fuel.length - 1] ?? 0,
    fuelUsed:    (fuel[0] ?? 0) - (fuel[fuel.length - 1] ?? 0),
    tireMax: { fl: max(tFL), fr: max(tFR), rl: max(tRL), rr: max(tRR) },
    tireAvg: { fl: avg(tFL), fr: avg(tFR), rl: avg(tRL), rr: avg(tRR) },
  };
}

function pad(s, n, right = false) {
  s = String(s);
  return right ? s.padStart(n) : s.padEnd(n);
}

function printTable(rows) {
  const cols = [
    ['Lap',     3,  true],
    ['Time',    11, true],
    ['vMax',    7,  true],
    ['vAvg',    7,  true],
    ['rpmMax',  7,  true],
    ['Thr%',    5,  true],
    ['Brk%',    5,  true],
    ['Fuel-',   6,  true],
    ['FL',      4,  true],
    ['FR',      4,  true],
    ['RL',      4,  true],
    ['RR',      4,  true],
  ];
  const header = cols.map(([h, w]) => pad(h, w, true)).join(' ');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const r of rows) {
    console.log([
      pad(r.lap, 3, true),
      pad(r.timeStr, 11, true),
      pad(r.maxSpeed.toFixed(1), 7, true),
      pad(r.avgSpeed.toFixed(1), 7, true),
      pad(Math.round(r.maxRpm), 7, true),
      pad(r.avgThrottle.toFixed(0), 5, true),
      pad(r.avgBrake.toFixed(0), 5, true),
      pad(r.fuelUsed.toFixed(1), 6, true),
      pad(r.tireMax.fl.toFixed(0), 4, true),
      pad(r.tireMax.fr.toFixed(0), 4, true),
      pad(r.tireMax.rl.toFixed(0), 4, true),
      pad(r.tireMax.rr.toFixed(0), 4, true),
    ].join(' '));
  }
}

function buildLapTraces(packets, downsample = 1) {
  const out = { t: [], speed: [], rpm: [], throttle: [], brake: [],
                tFL: [], tFR: [], tRL: [], tRR: [],
                posX: [], posZ: [] };
  for (let i = 0; i < packets.length; i += downsample) {
    const p = packets[i];
    out.t.push(+(i / 60).toFixed(2));     // seconds since lap start, assuming ~60 Hz
    out.speed.push(+p.speedKph.toFixed(1));
    out.rpm.push(Math.round(p.engineRpm));
    out.throttle.push(+(p.throttle / 2.55).toFixed(1));
    out.brake.push(+(p.brake / 2.55).toFixed(1));
    out.tFL.push(+(p.tireTempC?.fl ?? 0).toFixed(1));
    out.tFR.push(+(p.tireTempC?.fr ?? 0).toFixed(1));
    out.tRL.push(+(p.tireTempC?.rl ?? 0).toFixed(1));
    out.tRR.push(+(p.tireTempC?.rr ?? 0).toFixed(1));
    out.posX.push(+(p.position?.x ?? 0).toFixed(1));
    out.posZ.push(+(p.position?.z ?? 0).toFixed(1));
  }
  return out;
}

function htmlMulti(payloads, fileLabel) {
  const sessionBlocks = payloads.map((p, i) => sessionBlock(p, i)).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>GT7 Telemetry — ${fileLabel}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
  body { background:#0e1116; color:#e6edf3; font:14px system-ui, sans-serif; margin:24px; }
  h1 { font-size:20px; margin:0 0 4px; }
  h2 { font-size:15px; margin:24px 0 8px; color:#9aa6b2; font-weight:600; text-transform:uppercase; letter-spacing:.04em; }
  h3 { font-size:17px; margin:32px 0 4px; padding-top:24px; border-top:1px solid #1f2937; }
  .meta { color:#9aa6b2; margin-bottom:16px; }
  .smeta { color:#9aa6b2; margin-bottom:8px; font-size:13px; }
  table { border-collapse:collapse; font-variant-numeric:tabular-nums; font-size:13px; }
  th, td { padding:5px 9px; text-align:right; border-bottom:1px solid #1f2937; }
  th { color:#9aa6b2; font-weight:600; text-align:right; background:#11151c; }
  td:first-child, th:first-child { text-align:left; }
  tr.best td { background:#10331a; color:#9be7ad; }
  .grid { display:grid; grid-template-columns: 1fr 1fr; gap:18px; }
  .card { background:#11151c; border:1px solid #1f2937; border-radius:8px; padding:14px; }
  .full { grid-column: 1 / -1; }
  canvas { max-width:100%; }
  select { background:#11151c; color:#e6edf3; border:1px solid #1f2937; padding:4px 8px; border-radius:4px; }
  .toc a { color:#6ad1ff; text-decoration:none; margin-right:14px; }
</style>
</head>
<body>
<h1>GT7 Telemetry Report</h1>
<div class="meta">${fileLabel} &middot; ${payloads.length} session(s)</div>
<div class="toc">
  ${payloads.map((p, i) => `<a href="#s${i}">Session ${i + 1} — car ${p.carCode} — best ${p.bestLap.timeStr}</a>`).join('')}
</div>

${sessionBlocks}

<script>
const SESSIONS = ${JSON.stringify(payloads)};

const COLORS = {
  speed:'#6ad1ff', rpm:'#ffb86b', throttle:'#9be7ad', brake:'#ff7a7a',
  fl:'#6ad1ff', fr:'#ffb86b', rl:'#9be7ad', rr:'#ff7a7a',
};
const GRID = { color:'#1f2937' };
const TICK = { color:'#9aa6b2' };
function baseOpts(extra={}) {
  return {
    responsive:true, animation:false, parsing:false,
    interaction:{ mode:'nearest', intersect:false },
    plugins:{ legend:{ labels:{ color:'#e6edf3' } } },
    scales:{
      x:{ type:'linear', grid:GRID, ticks:TICK, ...(extra.x||{}) },
      y:{ grid:GRID, ticks:TICK, ...(extra.y||{}) },
    },
  };
}
function ds(label, color, points) {
  return { label, borderColor:color, backgroundColor:color+'33',
           borderWidth:1.4, pointRadius:0, tension:0.15, data:points };
}
function pts(xs, ys) { const o=[]; for (let i=0;i<xs.length;i++) o.push({x:xs[i], y:ys[i]}); return o; }

SESSIONS.forEach((DATA, idx) => {
  new Chart(document.getElementById('lapTimes_'+idx), {
    type:'bar',
    data:{ labels: DATA.lapRows.map(r=>'L'+r.lap),
           datasets:[{ label:'lap time (s)', data: DATA.lapRows.map(r=>r.timeMs/1000),
                       backgroundColor: DATA.lapRows.map(r=> r.lap===DATA.bestLap.lap ? '#9be7ad' : '#6ad1ff') }] },
    options:{ responsive:true, animation:false,
              plugins:{ legend:{ display:false }, tooltip:{ callbacks:{ label:c=> c.parsed.y.toFixed(3)+' s' } } },
              scales:{ x:{ grid:GRID, ticks:TICK }, y:{ grid:GRID, ticks:TICK } } },
  });

  new Chart(document.getElementById('speedAll_'+idx), {
    type:'line',
    data:{ datasets: DATA.lapTraces.map((tr,i)=>{
      const isBest = (DATA.lapRows[i].lap === DATA.bestLap.lap);
      return { label:'L'+DATA.lapRows[i].lap,
               borderColor: isBest ? '#9be7ad' : 'rgba(106,209,255,0.35)',
               borderWidth: isBest ? 2 : 1, pointRadius:0, tension:0.15,
               data: pts(tr.t, tr.speed) };
    })},
    options: baseOpts({ x:{ title:{display:true,text:'time in lap (s)',color:'#9aa6b2'} },
                       y:{ title:{display:true,text:'km/h',color:'#9aa6b2'} } }),
  });

  const best = DATA.lapTraces[DATA.bestLapIndex];
  new Chart(document.getElementById('speedBest_'+idx), {
    type:'line',
    data:{ datasets:[ ds('speed (km/h)', COLORS.speed, pts(best.t, best.speed)) ]},
    options: baseOpts({ y:{title:{display:true,text:'km/h',color:'#9aa6b2'}} }),
  });
  new Chart(document.getElementById('inputsBest_'+idx), {
    type:'line',
    data:{ datasets:[
      ds('throttle %', COLORS.throttle, pts(best.t, best.throttle)),
      ds('brake %',    COLORS.brake,    pts(best.t, best.brake)),
    ]},
    options: baseOpts({ y:{min:0,max:100} }),
  });
  new Chart(document.getElementById('tires_'+idx), {
    type:'line',
    data:{ datasets:[
      ds('FL', COLORS.fl, pts(DATA.tireSession.t, DATA.tireSession.fl)),
      ds('FR', COLORS.fr, pts(DATA.tireSession.t, DATA.tireSession.fr)),
      ds('RL', COLORS.rl, pts(DATA.tireSession.t, DATA.tireSession.rl)),
      ds('RR', COLORS.rr, pts(DATA.tireSession.t, DATA.tireSession.rr)),
    ]},
    options: baseOpts({ y:{title:{display:true,text:'°C',color:'#9aa6b2'}} }),
  });

  // Track-map: each lap as a top-down (x,z) line. Best lap highlighted in green.
  new Chart(document.getElementById('trackMap_'+idx), {
    type:'scatter',
    data:{ datasets: DATA.lapTraces.map((tr, i) => {
      const isBest = (DATA.lapRows[i].lap === DATA.bestLap.lap);
      const hue = (i * 47) % 360;
      return {
        label: 'L' + DATA.lapRows[i].lap + ' (' + DATA.lapRows[i].timeStr + ')' + (isBest ? ' ★' : ''),
        borderColor: isBest ? '#9be7ad' : 'hsl(' + hue + ', 70%, 60%)',
        backgroundColor: 'transparent',
        borderWidth: isBest ? 2.5 : 1.2,
        pointRadius: 0,
        showLine: true,
        tension: 0,
        data: pts(tr.posX, tr.posZ),
      };
    })},
    options:{
      responsive:true, animation:false, parsing:false,
      aspectRatio:1.7,
      interaction:{ mode:'nearest', intersect:false },
      plugins:{ legend:{ labels:{ color:'#e6edf3', boxWidth:14 }, position:'right' } },
      scales:{
        x:{ type:'linear', grid:GRID, ticks:TICK, title:{display:true,text:'X (m)',color:'#9aa6b2'} },
        y:{ type:'linear', grid:GRID, ticks:TICK, title:{display:true,text:'Z (m)',color:'#9aa6b2'} },
      },
    },
  });

  let inspector;
  const sel = document.getElementById('lapPick_'+idx);
  function drawInspector(lapIdx) {
    const tr = DATA.lapTraces[lapIdx];
    const data = { datasets:[
      ds('speed (km/h)',    COLORS.speed,    pts(tr.t, tr.speed)),
      ds('throttle %',      COLORS.throttle, pts(tr.t, tr.throttle)),
      ds('brake %',         COLORS.brake,    pts(tr.t, tr.brake)),
    ]};
    if (inspector) inspector.destroy();
    inspector = new Chart(document.getElementById('lapInspector_'+idx), {
      type:'line', data, options: baseOpts(),
    });
  }
  sel.addEventListener('change', () => {
    const lap = Number(sel.value);
    const li = DATA.lapRows.findIndex(r => r.lap === lap);
    if (li >= 0) drawInspector(li);
  });
  drawInspector(DATA.bestLapIndex);
});
</script>
</body>
</html>`;
}

function sessionBlock(p, idx) {
  const startStr = fmtTs(p.firstTs).slice(0, 16);
  const durMin = (((p.lastTs ?? 0) - (p.firstTs ?? 0)) / 60000).toFixed(1);
  const theoLine = p.theo.eligible.length >= 2
    ? ` &middot; theoretical <b>${formatLapTime(p.theo.totalMs)}</b> (gap ${((p.bestLap.timeMs - p.theo.totalMs)/1000).toFixed(2)}s)`
    : ` &middot; theoretical: insufficient laps`;
  return `
<h3 id="s${idx}">Session ${idx + 1} — Car ${p.carCode}</h3>
<div class="smeta">
  ${startStr}Z &middot; ${durMin} min &middot; ${p.packetCount.toLocaleString()} packets &middot;
  best <b>${p.bestLap.timeStr}</b> (L${p.bestLap.lap}) &middot;
  top <b>${p.topSpeed.toFixed(1)} km/h</b>${theoLine}
</div>

<div class="card full">
<table>
<thead>
<tr><th>Lap</th><th>Time</th><th>vMax</th><th>vAvg</th><th>RPMmax</th>
<th>Thr%</th><th>Brk%</th><th>Fuel-</th>
<th>FL</th><th>FR</th><th>RL</th><th>RR</th></tr>
</thead>
<tbody>
${p.lapRows.map(r => `
  <tr class="${r.lap === p.bestLap.lap ? 'best' : ''}">
    <td>${r.lap}</td><td>${r.timeStr}</td>
    <td>${r.maxSpeed.toFixed(1)}</td><td>${r.avgSpeed.toFixed(1)}</td>
    <td>${Math.round(r.maxRpm)}</td>
    <td>${r.avgThrottle.toFixed(0)}</td><td>${r.avgBrake.toFixed(0)}</td>
    <td>${r.fuelUsed.toFixed(2)}</td>
    <td>${r.tireMax.fl.toFixed(0)}</td><td>${r.tireMax.fr.toFixed(0)}</td>
    <td>${r.tireMax.rl.toFixed(0)}</td><td>${r.tireMax.rr.toFixed(0)}</td>
  </tr>`).join('')}
</tbody>
</table>
</div>

<div class="grid" style="margin-top:14px">
  <div class="card full"><h2>Lap times</h2><canvas id="lapTimes_${idx}" height="70"></canvas></div>
  <div class="card full"><h2>Speed traces — all laps</h2><canvas id="speedAll_${idx}" height="120"></canvas></div>
  <div class="card"><h2>Best lap — speed</h2><canvas id="speedBest_${idx}" height="160"></canvas></div>
  <div class="card"><h2>Best lap — throttle / brake</h2><canvas id="inputsBest_${idx}" height="160"></canvas></div>
  <div class="card full"><h2>Tire temps</h2><canvas id="tires_${idx}" height="100"></canvas></div>
  <div class="card full"><h2>Lines taken (top-down) — toggle laps in legend</h2><canvas id="trackMap_${idx}" height="320"></canvas></div>
  <div class="card full">
    <h2>Per-lap inspector</h2>
    <div style="margin-bottom:8px">
      Lap: <select id="lapPick_${idx}">
        ${p.lapRows.map(r => `<option value="${r.lap}" ${r.lap === p.bestLap.lap ? 'selected' : ''}>Lap ${r.lap} — ${r.timeStr}</option>`).join('')}
      </select>
    </div>
    <canvas id="lapInspector_${idx}" height="120"></canvas>
  </div>
</div>`;
}

function htmlUnused_legacy() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>GT7 Telemetry Report — ${fileLabel}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
  body { background:#0e1116; color:#e6edf3; font:14px system-ui, sans-serif; margin:24px; }
  h1 { font-size:20px; margin:0 0 4px; }
  h2 { font-size:15px; margin:24px 0 8px; color:#9aa6b2; font-weight:600; text-transform:uppercase; letter-spacing:.04em; }
  .meta { color:#9aa6b2; margin-bottom:16px; }
  table { border-collapse:collapse; font-variant-numeric:tabular-nums; font-size:13px; }
  th, td { padding:6px 10px; text-align:right; border-bottom:1px solid #1f2937; }
  th { color:#9aa6b2; font-weight:600; text-align:right; background:#11151c; position:sticky; top:0; }
  td:first-child, th:first-child { text-align:left; }
  tr.best td { background:#10331a; color:#9be7ad; }
  .grid { display:grid; grid-template-columns: 1fr 1fr; gap:24px; }
  .card { background:#11151c; border:1px solid #1f2937; border-radius:8px; padding:16px; }
  .full { grid-column: 1 / -1; }
  canvas { max-width:100%; }
  select { background:#11151c; color:#e6edf3; border:1px solid #1f2937; padding:4px 8px; border-radius:4px; }
</style>
</head>
<body>
<h1>GT7 Telemetry Report</h1>
<div class="meta">
  ${fileLabel} &middot; ${payload.lapRows.length} laps &middot;
  best <b>${payload.bestLap.timeStr}</b> (lap ${payload.bestLap.lap}) &middot;
  top speed <b>${payload.topSpeed.toFixed(1)} km/h</b>
</div>

<h2>Lap-by-lap</h2>
<div class="card full">
<table id="laps">
<thead>
<tr>
  <th>Lap</th><th>Time</th><th>vMax km/h</th><th>vAvg km/h</th>
  <th>RPM max</th><th>Thr %</th><th>Brk %</th><th>Fuel used L</th>
  <th>FL °C</th><th>FR °C</th><th>RL °C</th><th>RR °C</th>
</tr>
</thead>
<tbody>
${payload.lapRows.map(r => `
  <tr class="${r.lap === payload.bestLap.lap ? 'best' : ''}">
    <td>${r.lap}</td>
    <td>${r.timeStr}</td>
    <td>${r.maxSpeed.toFixed(1)}</td>
    <td>${r.avgSpeed.toFixed(1)}</td>
    <td>${Math.round(r.maxRpm)}</td>
    <td>${r.avgThrottle.toFixed(0)}</td>
    <td>${r.avgBrake.toFixed(0)}</td>
    <td>${r.fuelUsed.toFixed(2)}</td>
    <td>${r.tireMax.fl.toFixed(0)}</td>
    <td>${r.tireMax.fr.toFixed(0)}</td>
    <td>${r.tireMax.rl.toFixed(0)}</td>
    <td>${r.tireMax.rr.toFixed(0)}</td>
  </tr>`).join('')}
</tbody>
</table>
</div>

<div class="grid" style="margin-top:24px">

<div class="card full">
  <h2>Lap times</h2>
  <canvas id="lapTimes" height="80"></canvas>
</div>

<div class="card full">
  <h2>Speed trace — all laps overlaid</h2>
  <canvas id="speedAll" height="120"></canvas>
</div>

<div class="card">
  <h2>Best lap — speed</h2>
  <canvas id="speedBest" height="160"></canvas>
</div>
<div class="card">
  <h2>Best lap — throttle / brake</h2>
  <canvas id="inputsBest" height="160"></canvas>
</div>

<div class="card full">
  <h2>Tire temperatures across the session</h2>
  <canvas id="tires" height="120"></canvas>
</div>

<div class="card full">
  <h2>Per-lap inspector</h2>
  <div style="margin-bottom:8px">
    Lap: <select id="lapPick">
      ${payload.lapRows.map(r => `<option value="${r.lap}" ${r.lap === payload.bestLap.lap ? 'selected' : ''}>Lap ${r.lap} — ${r.timeStr}</option>`).join('')}
    </select>
  </div>
  <canvas id="lapInspector" height="120"></canvas>
</div>

</div>

<script>
const DATA = ${JSON.stringify(payload)};

const COLORS = {
  speed:'#6ad1ff', rpm:'#ffb86b', throttle:'#9be7ad', brake:'#ff7a7a',
  fl:'#6ad1ff', fr:'#ffb86b', rl:'#9be7ad', rr:'#ff7a7a',
};
const GRID = { color:'#1f2937' };
const TICK = { color:'#9aa6b2' };
function baseOpts(extra={}) {
  return {
    responsive:true, animation:false, parsing:false,
    interaction:{ mode:'nearest', intersect:false },
    plugins:{ legend:{ labels:{ color:'#e6edf3' } }, tooltip:{ enabled:true } },
    scales:{
      x:{ type:'linear', grid:GRID, ticks:TICK, ...(extra.x||{}) },
      y:{ grid:GRID, ticks:TICK, ...(extra.y||{}) },
    },
  };
}
function ds(label, color, points) {
  return { label, borderColor:color, backgroundColor:color+'33',
           borderWidth:1.4, pointRadius:0, tension:0.15, data:points };
}
function pts(xs, ys) { const o=[]; for (let i=0;i<xs.length;i++) o.push({x:xs[i], y:ys[i]}); return o; }

new Chart(document.getElementById('lapTimes'), {
  type:'bar',
  data:{ labels: DATA.lapRows.map(r=>'L'+r.lap),
         datasets:[{ label:'lap time (s)', data: DATA.lapRows.map(r=>r.timeMs/1000),
                     backgroundColor: DATA.lapRows.map(r=> r.lap===DATA.bestLap.lap ? '#9be7ad' : '#6ad1ff') }] },
  options:{ responsive:true, animation:false,
            plugins:{ legend:{ display:false }, tooltip:{ callbacks:{ label:c=> c.parsed.y.toFixed(3)+' s' } } },
            scales:{ x:{ grid:GRID, ticks:TICK }, y:{ grid:GRID, ticks:TICK, title:{display:true,text:'seconds',color:'#9aa6b2'} } } },
});

new Chart(document.getElementById('speedAll'), {
  type:'line',
  data:{ datasets: DATA.lapTraces.map((tr,i)=>{
    const isBest = (DATA.lapRows[i].lap === DATA.bestLap.lap);
    return { label:'L'+DATA.lapRows[i].lap,
             borderColor: isBest ? '#9be7ad' : 'rgba(106,209,255,0.35)',
             borderWidth: isBest ? 2 : 1, pointRadius:0, tension:0.15,
             data: pts(tr.t, tr.speed) };
  })},
  options: baseOpts({ x:{ title:{display:true,text:'time in lap (s)',color:'#9aa6b2'} },
                     y:{ title:{display:true,text:'km/h',color:'#9aa6b2'} } }),
});

const best = DATA.lapTraces[DATA.bestLapIndex];
new Chart(document.getElementById('speedBest'), {
  type:'line',
  data:{ datasets:[ ds('speed (km/h)', COLORS.speed, pts(best.t, best.speed)) ]},
  options: baseOpts({ x:{title:{display:true,text:'time (s)',color:'#9aa6b2'}}, y:{title:{display:true,text:'km/h',color:'#9aa6b2'}} }),
});
new Chart(document.getElementById('inputsBest'), {
  type:'line',
  data:{ datasets:[
    ds('throttle %', COLORS.throttle, pts(best.t, best.throttle)),
    ds('brake %',    COLORS.brake,    pts(best.t, best.brake)),
  ]},
  options: baseOpts({ x:{title:{display:true,text:'time (s)',color:'#9aa6b2'}}, y:{min:0,max:100} }),
});

new Chart(document.getElementById('tires'), {
  type:'line',
  data:{ datasets:[
    ds('FL', COLORS.fl, pts(DATA.tireSession.t, DATA.tireSession.fl)),
    ds('FR', COLORS.fr, pts(DATA.tireSession.t, DATA.tireSession.fr)),
    ds('RL', COLORS.rl, pts(DATA.tireSession.t, DATA.tireSession.rl)),
    ds('RR', COLORS.rr, pts(DATA.tireSession.t, DATA.tireSession.rr)),
  ]},
  options: baseOpts({ x:{title:{display:true,text:'session time (s)',color:'#9aa6b2'}}, y:{title:{display:true,text:'°C',color:'#9aa6b2'}} }),
});

let inspector;
function drawInspector(idx) {
  const tr = DATA.lapTraces[idx];
  const data = { datasets:[
    ds('speed (km/h)',    COLORS.speed,    pts(tr.t, tr.speed)),
    ds('throttle %',      COLORS.throttle, pts(tr.t, tr.throttle)),
    ds('brake %',         COLORS.brake,    pts(tr.t, tr.brake)),
  ]};
  if (inspector) inspector.destroy();
  inspector = new Chart(document.getElementById('lapInspector'), {
    type:'line', data,
    options: baseOpts({ x:{title:{display:true,text:'time in lap (s)',color:'#9aa6b2'}} }),
  });
}
const sel = document.getElementById('lapPick');
sel.addEventListener('change', () => {
  const lap = Number(sel.value);
  const idx = DATA.lapRows.findIndex(r => r.lap === lap);
  if (idx >= 0) drawInspector(idx);
});
drawInspector(DATA.bestLapIndex);
</script>
</body>
</html>`;
}

// --- theoretical best lap ---------------------------------------------------
// Divide each lap into N equal-distance sectors (distance integrated from
// speed). For each sector index, take the fastest sector time across all laps.
// Sum = theoretical best lap. Skip laps whose total distance differs from the
// median by more than ±5% (off-track / pit / shortcut excursions).

const SECTOR_COUNT = 12;
const DT = 1 / 60;   // GT7 telemetry rate

function lapDistanceProfile(packets) {
  const cum = new Array(packets.length);
  let d = 0;
  for (let i = 0; i < packets.length; i++) {
    const v = packets[i].speedKph / 3.6;   // m/s
    d += v * DT;
    cum[i] = d;
  }
  return cum;
}

// Compute per-sector times for a single lap using a SHARED reference distance.
// Each sector spans (refDist / N) meters of physical track; if a lap is short
// it simply won't cover all sectors (returns Infinity for missing ones).
function lapSectorTimes(packets, refDist, sectors) {
  const cum = lapDistanceProfile(packets);
  const total = cum.at(-1) ?? 0;
  const times = new Array(sectors).fill(Infinity);
  const sectorLen = refDist / sectors;
  let idx = 0;
  for (let k = 0; k < sectors; k++) {
    const target = sectorLen * (k + 1);
    if (target > total) break;
    const start = idx;
    while (idx < cum.length && cum[idx] < target) idx++;
    times[k] = (idx - start) * DT;
  }
  return times;
}

function computeTheoretical(lapRows, byLap) {
  const distances = lapRows.map(r => {
    const packets = byLap.get(r.lap);
    return lapDistanceProfile(packets).at(-1) ?? 0;
  });
  // Use median distance of clean laps as the canonical lap length.
  // Drop the slowest two laps (likely warmup / off-track) before taking median.
  const ranked = lapRows
    .map((r, i) => ({ ms: r.timeMs, dist: distances[i] }))
    .sort((a, b) => a.ms - b.ms);
  const cleanDistances = ranked.slice(0, Math.max(1, ranked.length - 2)).map(x => x.dist);
  const sortedDist = cleanDistances.slice().sort((a, b) => a - b);
  const refDist = sortedDist[Math.floor(sortedDist.length / 2)];
  const tol = refDist * 0.03;

  const sectorMins = new Array(SECTOR_COUNT).fill(Infinity);
  const sectorOwner = new Array(SECTOR_COUNT).fill(null);
  const eligible = [];

  for (let i = 0; i < lapRows.length; i++) {
    const dist = distances[i];
    if (Math.abs(dist - refDist) > tol) continue;
    eligible.push(lapRows[i].lap);
    const times = lapSectorTimes(byLap.get(lapRows[i].lap), refDist, SECTOR_COUNT);
    for (let k = 0; k < SECTOR_COUNT; k++) {
      if (Number.isFinite(times[k]) && times[k] > 0 && times[k] < sectorMins[k]) {
        sectorMins[k] = times[k];
        sectorOwner[k] = lapRows[i].lap;
      }
    }
  }

  const totalS = sectorMins.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  return { totalMs: Math.round(totalS * 1000), sectorMins, sectorOwner, eligible, refDist };
}

function buildSessionPayload(session) {
  const completed = [...session.byLap.keys()]
    .sort((a, b) => a - b)
    .filter(L => L >= 1 && session.officialLapMs.has(L));
  if (!completed.length) return null;

  const lapRows = [];
  const lapTraces = [];
  const downsample = 3;
  for (const L of completed) {
    const packets = session.byLap.get(L);
    const s = summarizeLap(packets);
    const ms = session.officialLapMs.get(L);
    lapRows.push({ lap: L, timeMs: ms, timeStr: formatLapTime(ms), ...s });
    lapTraces.push(buildLapTraces(packets, downsample));
  }

  const bestLap = lapRows.reduce((a, b) => (b.timeMs < a.timeMs ? b : a));
  const bestLapIndex = lapRows.findIndex(r => r.lap === bestLap.lap);
  const topSpeed = Math.max(...lapRows.map(r => r.maxSpeed));

  const tireSession = { t: [], fl: [], fr: [], rl: [], rr: [] };
  let i = 0;
  for (const L of completed) {
    const ds = 30;
    const pkts = session.byLap.get(L);
    for (let j = 0; j < pkts.length; j += ds) {
      const p = pkts[j];
      tireSession.t.push(+((i + j) / 60).toFixed(1));
      tireSession.fl.push(+(p.tireTempC?.fl ?? 0).toFixed(1));
      tireSession.fr.push(+(p.tireTempC?.fr ?? 0).toFixed(1));
      tireSession.rl.push(+(p.tireTempC?.rl ?? 0).toFixed(1));
      tireSession.rr.push(+(p.tireTempC?.rr ?? 0).toFixed(1));
    }
    i += pkts.length;
  }

  const theo = computeTheoretical(lapRows, session.byLap);

  return {
    carCode: session.carCode,
    firstTs: session.firstTs,
    lastTs:  session.lastTs,
    packetCount: session.packetCount,
    lapRows, lapTraces, bestLap, bestLapIndex, topSpeed, tireSession, theo,
  };
}

function fmtTs(ts) {
  if (!ts || !Number.isFinite(ts)) return '????-??-?? ??:??:??';
  try { return new Date(ts).toISOString().replace('T', ' ').slice(0, 19); }
  catch { return '????-??-?? ??:??:??'; }
}

function printSessionSummary(idx, p) {
  const startStr = fmtTs(p.firstTs);
  const durMin = (((p.lastTs ?? 0) - (p.firstTs ?? 0)) / 60000).toFixed(1);
  console.log(`\n=== Session ${idx + 1}  car=${p.carCode}  start=${startStr}Z  duration=${durMin}min  packets=${p.packetCount} ===\n`);
  printTable(p.lapRows);
  console.log();
  console.log(`Best lap:        ${p.bestLap.timeStr} (lap ${p.bestLap.lap})`);
  console.log(`Top speed:       ${p.topSpeed.toFixed(1)} km/h`);
  if (p.theo.eligible.length >= 2) {
    const theoStr = formatLapTime(p.theo.totalMs);
    const delta = p.bestLap.timeMs - p.theo.totalMs;
    console.log(`Theoretical lap: ${theoStr}   (${p.theo.eligible.length} laps eligible, ${SECTOR_COUNT} sectors)`);
    console.log(`Time on table:   ${(delta / 1000).toFixed(3)} s vs your best`);
  } else {
    console.log(`Theoretical lap: not enough clean laps to compute (${p.theo.eligible.length} eligible)`);
  }
}

async function main() {
  const file = pickFile();
  console.log('Reading', file);
  const { sessions, pktTotal } = await loadSessions(file);
  console.log(`${pktTotal} packets across ${sessions.length} session(s)`);

  const payloads = sessions
    .map(buildSessionPayload)
    .filter(p => p && p.lapRows.length >= 1);

  if (!payloads.length) {
    console.log('No completed laps in any session.');
    return;
  }

  payloads.forEach((p, i) => printSessionSummary(i, p));

  const fileLabel = path.basename(file);
  const outPath = path.resolve(__dirname, '..', 'report.html');
  fs.writeFileSync(outPath, htmlMulti(payloads, fileLabel));
  const sizeMB = (fs.statSync(outPath).size / 1e6).toFixed(2);
  console.log(`\nHTML report: ${outPath}  (${sizeMB} MB) — ${payloads.length} session(s) rendered.`);
}

main().catch(err => { console.error(err); process.exit(1); });

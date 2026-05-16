// Prometheus exporter for GT7 telemetry.
// Holds the latest parsed packet in memory and renders /metrics on demand.
// No external dependencies — Prometheus text format is plain text.
//
// Usage:
//   const metrics = require('./metrics');
//   metrics.start(9477);                        // boots HTTP server
//   metrics.update(parsedPacket, rxCount, drops); // call per packet
//   metrics.stop();                             // graceful shutdown

const http   = require('node:http');
const fs     = require('node:fs');
const path   = require('node:path');
const config = require('../config');
const lapAnalyzer   = require('../analysis/lap-analyzer');
const ghostStore    = require('../analysis/ghost-store');
const driverStore   = require('../analysis/driver-store');
const cutoffStore   = require('../analysis/cutoff-store');

const state = {
  packet:           null,
  lastUpdateMs:     0,
  packetsReceived:  0,
  packetsDropped:   0,
  meta:             { car: null, track: null, sessionType: null },
};

// GTSH-Rank live integration is intentionally omitted from this public build.
// Stub objects so the rest of metrics.js keeps working without conditional code.
const gtsh = { data: null, lastError: null, ageMs: () => 0, get: async () => null };
function startGtshPoller() { /* noop in public build */ }
function stopGtshPoller() { /* noop in public build */ }

function update(parsed, packetsReceived, packetsDropped, meta, prediction) {
  state.packet           = parsed;
  state.lastUpdateMs     = Date.now();
  state.packetsReceived  = packetsReceived;
  state.packetsDropped   = packetsDropped;
  if (meta) state.meta   = meta;
  state.prediction       = prediction || null;
}

function fmtLabels(labels) {
  if (!labels) return '';
  const parts = [];
  for (const k of Object.keys(labels)) parts.push(`${k}="${labels[k]}"`);
  return '{' + parts.join(',') + '}';
}

function line(name, value, labels) {
  if (value === undefined || value === null || Number.isNaN(value)) return '';
  return `${name}${fmtLabels(labels)} ${value}\n`;
}

function help(name, helpText, type) {
  return `# HELP ${name} ${helpText}\n# TYPE ${name} ${type}\n`;
}

function render() {
  const p = state.packet;
  const ageSec = state.lastUpdateMs ? (Date.now() - state.lastUpdateMs) / 1000 : 9999;

  let out = '';

  out += help('gt7_up', 'exporter is running', 'gauge') + line('gt7_up', 1);
  out += help('gt7_data_age_seconds', 'seconds since last telemetry packet', 'gauge')
       + line('gt7_data_age_seconds', ageSec.toFixed(3));
  out += help('gt7_packets_received_total', 'total UDP packets parsed since exporter started', 'counter')
       + line('gt7_packets_received_total', state.packetsReceived);

  const cfg = config.get();
  out += help('gt7_rig_version', 'increments each time POST /config is called', 'gauge')
       + line('gt7_rig_version', cfg.version);
  out += help('gt7_rig_updated_at_seconds', 'unix time of last rig config change', 'gauge')
       + line('gt7_rig_updated_at_seconds', Math.floor(cfg.updatedAt / 1000));
  out += help('gt7_packets_dropped_total', 'total packets missed (gaps in packetId)', 'counter')
       + line('gt7_packets_dropped_total', state.packetsDropped);

  if (!p) return out;

  // ---- driver inputs & engine ----
  out += help('gt7_speed_kph', 'current speed in km/h', 'gauge')
       + line('gt7_speed_kph', p.speedKph.toFixed(2));
  out += help('gt7_rpm', 'engine RPM', 'gauge')
       + line('gt7_rpm', p.engineRpm.toFixed(0));
  out += help('gt7_rpm_redline', 'redline (max RPM alert) for current car', 'gauge')
       + line('gt7_rpm_redline', p.maxRpmAlert);
  out += help('gt7_max_speed_kph', 'transmission top speed limit', 'gauge')
       + line('gt7_max_speed_kph', p.maxSpeedKph);

  // gear: parser uses raw nibble (0=R, 15=N). Translate to a clean number for graphs.
  let gearVal = p.currentGear;
  if (gearVal === 0)  gearVal = -1;   // R
  if (gearVal === 15) gearVal = 0;    // N
  out += help('gt7_gear', 'current gear (-1=R, 0=N, 1..N)', 'gauge')
       + line('gt7_gear', gearVal);
  if (p.suggestedGear !== undefined && p.suggestedGear !== 15) {
    out += help('gt7_suggested_gear', 'suggested upshift gear (0 if none)', 'gauge')
         + line('gt7_suggested_gear', p.suggestedGear);
  }

  out += help('gt7_throttle_pct', 'throttle pedal 0-100', 'gauge')
       + line('gt7_throttle_pct', (p.throttle / 2.55).toFixed(1));
  out += help('gt7_brake_pct', 'brake pedal 0-100', 'gauge')
       + line('gt7_brake_pct', (p.brake / 2.55).toFixed(1));
  out += help('gt7_clutch_pct', 'clutch pedal 0-100', 'gauge')
       + line('gt7_clutch_pct', (p.clutchPedal * 100).toFixed(1));
  out += help('gt7_clutch_engagement_pct', 'clutch engagement 0-100', 'gauge')
       + line('gt7_clutch_engagement_pct', (p.clutchEngagement * 100).toFixed(1));

  // ---- tire temps (the headline metric for live monitoring) ----
  out += help('gt7_tire_temp_c', 'tire surface temperature in celsius', 'gauge')
       + line('gt7_tire_temp_c', p.tireTempC.fl.toFixed(1), { wheel: 'fl' })
       + line('gt7_tire_temp_c', p.tireTempC.fr.toFixed(1), { wheel: 'fr' })
       + line('gt7_tire_temp_c', p.tireTempC.rl.toFixed(1), { wheel: 'rl' })
       + line('gt7_tire_temp_c', p.tireTempC.rr.toFixed(1), { wheel: 'rr' });

  out += help('gt7_suspension_height_m', 'suspension travel in meters per wheel', 'gauge')
       + line('gt7_suspension_height_m', p.suspensionHeight.fl.toFixed(4), { wheel: 'fl' })
       + line('gt7_suspension_height_m', p.suspensionHeight.fr.toFixed(4), { wheel: 'fr' })
       + line('gt7_suspension_height_m', p.suspensionHeight.rl.toFixed(4), { wheel: 'rl' })
       + line('gt7_suspension_height_m', p.suspensionHeight.rr.toFixed(4), { wheel: 'rr' });

  out += help('gt7_wheel_speed_rad_s', 'wheel rotational speed (rad/s) per wheel', 'gauge')
       + line('gt7_wheel_speed_rad_s', p.wheelRpsRad.fl.toFixed(2), { wheel: 'fl' })
       + line('gt7_wheel_speed_rad_s', p.wheelRpsRad.fr.toFixed(2), { wheel: 'fr' })
       + line('gt7_wheel_speed_rad_s', p.wheelRpsRad.rl.toFixed(2), { wheel: 'rl' })
       + line('gt7_wheel_speed_rad_s', p.wheelRpsRad.rr.toFixed(2), { wheel: 'rr' });

  // ---- powertrain temperatures ----
  out += help('gt7_water_temp_c', 'engine coolant temperature', 'gauge')
       + line('gt7_water_temp_c', p.waterTempC.toFixed(1));
  out += help('gt7_oil_temp_c', 'oil temperature', 'gauge')
       + line('gt7_oil_temp_c', p.oilTempC.toFixed(1));
  out += help('gt7_oil_pressure_bar', 'oil pressure (bar)', 'gauge')
       + line('gt7_oil_pressure_bar', p.oilPressure.toFixed(2));
  out += help('gt7_boost_bar', 'turbo boost (bar above atmospheric)', 'gauge')
       + line('gt7_boost_bar', p.boostBar.toFixed(2));

  // ---- fuel ----
  out += help('gt7_fuel_level_l', 'fuel level in liters', 'gauge')
       + line('gt7_fuel_level_l', p.fuelLevel.toFixed(2));
  out += help('gt7_fuel_capacity_l', 'fuel tank capacity in liters', 'gauge')
       + line('gt7_fuel_capacity_l', p.fuelCapacity.toFixed(2));
  if (p.fuelCapacity > 0) {
    out += help('gt7_fuel_pct', 'fuel percentage 0-100', 'gauge')
         + line('gt7_fuel_pct', (100 * p.fuelLevel / p.fuelCapacity).toFixed(1));
  }

  // ---- race state ----
  out += help('gt7_lap_count', 'current lap number', 'gauge')
       + line('gt7_lap_count', p.lapCount);
  out += help('gt7_laps_in_race', 'total laps in race (0 = open session)', 'gauge')
       + line('gt7_laps_in_race', p.lapsInRace);
  out += help('gt7_race_position', 'current race position (1-based)', 'gauge')
       + line('gt7_race_position', p.racePosition);
  out += help('gt7_total_cars', 'total cars in race', 'gauge')
       + line('gt7_total_cars', p.totalCars);
  if (p.lastLapTimeMs > 0) {
    out += help('gt7_last_lap_ms', 'last completed lap time (ms)', 'gauge')
         + line('gt7_last_lap_ms', p.lastLapTimeMs);
  }
  if (p.bestLapTimeMs > 0) {
    out += help('gt7_best_lap_ms', 'best lap time so far (ms)', 'gauge')
         + line('gt7_best_lap_ms', p.bestLapTimeMs);
  }

  // ---- live lap projection (XZ-trace match against best-lap reference) ----
  const pred = state.prediction;
  if (pred) {
    if (pred.currentLapElapsedMs !== null) {
      out += help('gt7_current_lap_elapsed_ms', 'elapsed time on current lap (ms, wall-clock)', 'gauge')
           + line('gt7_current_lap_elapsed_ms', pred.currentLapElapsedMs);
    }
    if (pred.predictedMs !== null) {
      out += help('gt7_predicted_lap_ms', 'projected current-lap time using best-lap pace reference', 'gauge')
           + line('gt7_predicted_lap_ms', Math.round(pred.predictedMs));
    }
    if (pred.deltaMs !== null) {
      out += help('gt7_lap_delta_ms', 'live delta to PB at current track position (>0 = slower)', 'gauge')
           + line('gt7_lap_delta_ms', Math.round(pred.deltaMs));
    }
    out += help('gt7_predictor_has_reference', '1 once a PB-lap trace has been recorded for projection', 'gauge')
         + line('gt7_predictor_has_reference', pred.hasReference ? 1 : 0);

    // ---- sector tracking ----
    if (pred.currentSector) {
      out += help('gt7_current_sector', 'sector currently being driven (1, 2, or 3)', 'gauge')
           + line('gt7_current_sector', pred.currentSector);
    }
    if (Array.isArray(pred.lastLapSectorMs)) {
      let helped = false;
      for (let i = 0; i < 3; i++) {
        if (pred.lastLapSectorMs[i] != null) {
          if (!helped) {
            out += help('gt7_last_sector_ms', 'sector times from the just-completed lap (ms)', 'gauge');
            helped = true;
          }
          out += line('gt7_last_sector_ms', Math.round(pred.lastLapSectorMs[i]), { sector: String(i + 1) });
        }
      }
    }
    if (Array.isArray(pred.bestSectorMs)) {
      let helped = false;
      for (let i = 0; i < 3; i++) {
        if (pred.bestSectorMs[i] != null) {
          if (!helped) {
            out += help('gt7_best_sector_ms', 'fastest sector time observed this session (ms)', 'gauge');
            helped = true;
          }
          out += line('gt7_best_sector_ms', Math.round(pred.bestSectorMs[i]), { sector: String(i + 1) });
        }
      }
    }
    if (pred.theoreticalBestMs != null) {
      out += help('gt7_theoretical_best_ms', 'sum of fastest sector times across this session (ms)', 'gauge')
           + line('gt7_theoretical_best_ms', Math.round(pred.theoreticalBestMs));
    }
  }

  // ---- world position (useful for live track map) ----
  out += help('gt7_position_m', 'world position (m) per axis', 'gauge')
       + line('gt7_position_m', p.position.x.toFixed(2), { axis: 'x' })
       + line('gt7_position_m', p.position.y.toFixed(2), { axis: 'y' })
       + line('gt7_position_m', p.position.z.toFixed(2), { axis: 'z' });

  // ---- flags ----
  const flag = (k, v) => line('gt7_flag', v ? 1 : 0, { name: k });
  out += help('gt7_flag', 'GT7 telemetry flag bits (1 = active)', 'gauge')
       + flag('in_race',           p.flags.inRace)
       + flag('paused',            p.flags.paused)
       + flag('rev_limiter',       p.flags.revLimiterAlert)
       + flag('handbrake',         p.flags.handBrakeActive)
       + flag('asm',               p.flags.asmActive)
       + flag('tcs',               p.flags.tcsActive)
       + flag('lights',            p.flags.lights)
       + flag('high_beam',         p.flags.highBeam)
       + flag('low_beam',          p.flags.lowBeam)
       + flag('has_turbo',         p.flags.hasTurbo)
       + flag('in_gear',           p.flags.inGear);

  out += help('gt7_car_code', 'GT7 internal car id', 'gauge')
       + line('gt7_car_code', p.carCode, {
           car_name:  state.meta.car?.name  || '',
           car_class: state.meta.car?.class || '',
         });

  // Info-style metric (constant 1) carrying enriched session metadata as labels —
  // safe to join against any other metric by instance.
  out += help('gt7_session_info', 'metadata about the current session (car / track / type)', 'gauge')
       + line('gt7_session_info', 1, {
           car_name:     state.meta.car?.name   || '',
           car_class:    state.meta.car?.class  || '',
           car_code:     p.carCode ? String(p.carCode) : '',
           track_id:     state.meta.track?.id   || '',
           track_name:   state.meta.track?.name || '',
           session_type: state.meta.sessionType || 'unknown',
         });

  // (GTSH-Rank live integration removed in public build.)

  return out;
}

let server = null;

function readJsonBody(req, max = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > max) { req.destroy(); reject(new Error('body too large')); }
    });
    req.on('end',   () => resolve(body));
    req.on('error', reject);
  });
}

function jsonRes(res, code, obj) {
  const body = JSON.stringify(obj, null, 2) + '\n';
  res.writeHead(code, {
    'Content-Type':   'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function handleConfig(req, res) {
  try {
    if (req.method === 'GET') {
      return jsonRes(res, 200, config.get());
    }
    if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') {
      const raw = await readJsonBody(req);
      const partial = raw.trim() ? JSON.parse(raw) : {};
      const result = req.method === 'PUT' ? config.replace(partial) : config.update(partial);
      return jsonRes(res, 200, result);
    }
    return jsonRes(res, 405, { error: 'method not allowed' });
  } catch (e) {
    return jsonRes(res, 400, { error: e.message });
  }
}

function renderGtshHtml() {
  // GTSH-Rank live integration is omitted from this public build.
  // See README for rationale (third-party API, ToS considerations).
  return `<!doctype html><html><head><meta charset="utf-8"><title>GTSH live (disabled)</title>
<style>body{font-family:system-ui;background:#0a0e1a;color:#e0e6f0;padding:24px}
.err{color:#ff5252}</style></head><body>
<h1>GTSH-Rank live integration — disabled</h1>
<p>This build does not include the GTSH-Rank scraper. Use the manual
<a href="/cutoff" style="color:#00d4ff">/cutoff</a> page for leaderboard
context, or implement your own client against an API you have permission
to use.</p>
</body></html>`;
}


// ---- shared HTML chrome ----
const NAV_HTML = `
<style>
  .nav{display:flex;gap:14px;margin-bottom:18px;font-size:13px}
  .nav a{color:#7a8499;text-decoration:none;padding:4px 10px;border:1px solid #1f2a44;border-radius:4px}
  .nav a.active{color:#00d4ff;border-color:#00d4ff}
  .nav a:hover{color:#fff;border-color:#7a8499}
</style>
`;
function navLinks(active) {
  const items = [
    ['/',          'overview'],
    ['/laps',      'laps'],
    ['/micro',     'micro'],
    ['/track',     'track'],
    ['/events',    'events'],
    ['/metrics',   'metrics'],
  ];
  return `<div class="nav">${items.map(([href,label]) =>
    `<a href="${href}"${active===label?' class="active"':''}>${label}</a>`
  ).join('')}</div>`;
}
const BASE_CSS = `
<style>
  body{font-family:-apple-system,system-ui,sans-serif;background:#0a0e1a;color:#e0e6f0;margin:0;padding:20px;font-variant-numeric:tabular-nums}
  h1{margin:0 0 4px;font-weight:300}
  .sub{color:#7a8499;font-size:13px;margin-bottom:18px}
  .panel{background:#0f1626;border:1px solid #1f2a44;border-radius:8px;padding:16px;margin-bottom:16px}
  .panel h2{margin:0 0 12px;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#8aa0d0;font-weight:600}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;color:#7a8499;font-weight:500;padding:6px 8px;border-bottom:1px solid #1a2238}
  td{padding:5px 8px;border-bottom:1px solid #131a2a}
  td.r,th.r{text-align:right}
  tr.pb td{background:#1a1335;color:#d1a8ff}
  tr.bs1 td.s1, tr.bs2 td.s2, tr.bs3 td.s3{color:#b388ff;font-weight:600}
  .ok{color:#00e676}.bad{color:#ff5252}.dim{color:#7a8499}
  a{color:#00d4ff}
</style>
`;

function fmtMsCol(ms) {
  if (ms == null) return '—';
  return (ms / 1000).toFixed(3) + 's';
}
function fmtDelta(ms) {
  if (ms == null || !isFinite(ms)) return '—';
  if (ms === 0) return 'PB';
  const s = (ms / 1000).toFixed(3);
  return (ms > 0 ? '+' : '') + s;
}
function fmtTimeOfDay(ts) {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
}

async function renderLapsHtml() {
  let data;
  try { data = await lapAnalyzer.get(); }
  catch (e) { return `<!doctype html><html><head>${BASE_CSS}</head><body>${navLinks('laps')}<div class="panel">Error: ${e.message}</div></body></html>`; }
  const { laps, pbMs, theoreticalMs, bestSectors } = data;

  // Empty-state: no valid laps yet. Render a clean placeholder.
  if (!laps || laps.length === 0) {
    return `<!doctype html><html><head><meta charset="utf-8">
<title>laps · empty</title>
<meta http-equiv="refresh" content="20">
${BASE_CSS}${NAV_HTML}</head><body>
${navLinks('laps')}
<h1>Today's laps</h1>
<div class="sub">no valid laps yet · driver: <b>${data.driverId || 'player1'}</b> · this page auto-refreshes every 20s</div>
<div class="panel">
  <p>Drive a lap and it'll appear here. The recording is live: <code>recordings/gt7-${new Date().toISOString().slice(0,10)}.jsonl</code></p>
  <p class="sub">If you just cleared today's laps, this is normal — the slate is fresh.</p>
</div>
</body></html>`;
  }

  const rows = laps.map(l => {
    const dPb = l.completedMs - pbMs;
    const cls = [];
    if (l.isPb) cls.push('pb');
    if (bestSectors.s1.lapOrder === l.order) cls.push('bs1');
    if (bestSectors.s2.lapOrder === l.order) cls.push('bs2');
    if (bestSectors.s3.lapOrder === l.order) cls.push('bs3');
    return `<tr class="${cls.join(' ')}">
      <td class="r">${l.isPb ? '★ ' : ''}${l.order}</td>
      <td>${fmtTimeOfDay(l.startT)}</td>
      <td class="r">${l.lapNum}</td>
      <td class="r">${fmtMsCol(l.completedMs)}</td>
      <td class="r">${fmtDelta(dPb)}</td>
      <td class="r s1">${fmtMsCol(l.s1)}</td>
      <td class="r s2">${fmtMsCol(l.s2)}</td>
      <td class="r s3">${fmtMsCol(l.s3)}</td>
    </tr>`;
  }).join('\n');

  // Variation stats
  const times = laps.map(l => l.completedMs);
  const sorted = times.slice().sort((a,b)=>a-b);
  const mean = times.reduce((a,b)=>a+b,0) / (times.length || 1);
  const variance = times.reduce((a,b) => a + (b - mean) ** 2, 0) / (times.length || 1);
  const stddev = Math.sqrt(variance);
  const median = sorted[Math.floor(sorted.length/2)] || 0;
  const range = (sorted[sorted.length-1] || 0) - (sorted[0] || 0);

  return `<!doctype html><html><head><meta charset="utf-8">
<title>laps · ${new Date().toISOString().slice(0,10)}</title>
<meta http-equiv="refresh" content="30">
${BASE_CSS}${NAV_HTML}</head><body>
${navLinks('laps')}
<h1>Today's laps</h1>
<div class="sub">${laps.length} valid laps · PB ${fmtMsCol(pbMs)} · theoretical best ${fmtMsCol(theoreticalMs)} · car #${data.mainCar} · auto-refresh 30s</div>

<div class="panel">
  <h2>Lap table — PB row purple, best-sector cells purple-bold</h2>
  <table>
    <tr><th class="r">#</th><th>time</th><th class="r">lap</th><th class="r">total</th><th class="r">ΔPB</th><th class="r">S1</th><th class="r">S2</th><th class="r">S3</th></tr>
    ${rows}
  </table>
</div>

<div class="panel">
  <h2>Theoretical best & sector breakdown</h2>
  <table>
    <tr><th></th><th class="r">best</th><th class="r">from lap</th><th class="r">delta to PB sector</th></tr>
    <tr><td>S1</td><td class="r">${fmtMsCol(bestSectors.s1.ms)}</td><td class="r">${bestSectors.s1.lapOrder || '—'}</td><td class="r">${fmtDelta(bestSectors.s1.ms - (laps[data.pbOrder-1]?.s1 || 0))}</td></tr>
    <tr><td>S2</td><td class="r">${fmtMsCol(bestSectors.s2.ms)}</td><td class="r">${bestSectors.s2.lapOrder || '—'}</td><td class="r">${fmtDelta(bestSectors.s2.ms - (laps[data.pbOrder-1]?.s2 || 0))}</td></tr>
    <tr><td>S3</td><td class="r">${fmtMsCol(bestSectors.s3.ms)}</td><td class="r">${bestSectors.s3.lapOrder || '—'}</td><td class="r">${fmtDelta(bestSectors.s3.ms - (laps[data.pbOrder-1]?.s3 || 0))}</td></tr>
    <tr><td><b>theoretical</b></td><td class="r"><b>${fmtMsCol(theoreticalMs)}</b></td><td class="r"></td><td class="r"><b>${fmtDelta(theoreticalMs - pbMs)}</b></td></tr>
  </table>
</div>

<div class="panel">
  <h2>Variation</h2>
  <table>
    <tr><th>fastest</th><th class="r">${fmtMsCol(sorted[0])}</th><th>median</th><th class="r">${fmtMsCol(median)}</th><th>stddev</th><th class="r">${(stddev/1000).toFixed(3)}s</th></tr>
    <tr><th>slowest</th><th class="r">${fmtMsCol(sorted[sorted.length-1])}</th><th>mean</th><th class="r">${fmtMsCol(mean)}</th><th>range</th><th class="r">${(range/1000).toFixed(3)}s</th></tr>
  </table>
</div>

<div class="sub">Source: ${path.basename(lapAnalyzer.todayFile())} · <a href="/laps?force=1">force re-analyze</a> · <a href="/laps.json">JSON</a></div>
</body></html>`;
}

async function renderTrackHtml(reqUrl = '') {
  let data;
  try { data = await lapAnalyzer.get(); }
  catch (e) { return `<!doctype html><html><head>${BASE_CSS}</head><body>${navLinks('track')}<div class="panel">Error: ${e.message}</div></body></html>`; }
  const { laps, pbTrace, sectorBoundaries, traceForLap, microSectorsForLap } = data;
  if (!pbTrace || pbTrace.length === 0) {
    return `<!doctype html><html><head>${BASE_CSS}</head><body>${navLinks('track')}<div class="panel">No PB trace yet — drive at least one valid lap.</div></body></html>`;
  }

  // Dark-spot resolution (default 30) and view mode (default cause)
  const mResMatch = reqUrl.match(/[?&]n=(\d+)/);
  const N = Math.max(3, Math.min(120, mResMatch ? Number(mResMatch[1]) : 30));
  const modeMatch = reqUrl.match(/[?&]mode=(cause|loss)/);
  const MODE = modeMatch ? modeMatch[1] : 'cause';

  const lastLap = laps[laps.length - 1];
  const lastTrace = lastLap && !lastLap.isPb && traceForLap ? traceForLap(lastLap._lap) : [];

  // Ghost trace (registered via tools/set-ghost.js — typically a WR replay)
  const ghost = ghostStore.load();
  const ghostTrace = ghost?.trace || [];

  // Dark spots — TWO complementary metrics per μ-sector:
  //
  //   LOSS  (effect): average per-μ-sector delta vs PB. Marks where the car is
  //                   physically slow — usually downstream of the actual mistake
  //                   (e.g. on the straight after a missed apex).
  //
  //   CAUSE (onset): rising-edge detection. A "loss event" is a contiguous run
  //                  of growing delta. Only the FIRST μ-sector of each event is
  //                  marked as cause; subsequent growing sectors are treated as
  //                  echo. Magnitude = how big the loss event eventually grows.
  //                  This isolates the input mistake from its consequences.
  //
  // Sum-check filter excludes laps where the matcher had sync-loss.
  const darkSpots = []; // {x, z, avgDeltaMs, avgOnsetMs, avgLossMs, count, idx}
  if (microSectorsForLap && laps.length >= 2) {
    const pbLapItem = laps.find(l => l.isPb);
    const pbMicros = pbLapItem ? microSectorsForLap(pbLapItem._lap, N) : null;
    if (pbMicros) {
      const onsetSums = new Array(N).fill(0);   // sum of event magnitudes attributed to this μ-sector
      const onsetCounts = new Array(N).fill(0); // # of events that started here
      const lossSums  = new Array(N).fill(0);
      const lossCounts = new Array(N).fill(0);
      const GROW_THRESH_MS    = 12;  // delta must grow by this much per μ to count as "rising"
      const RECOVER_THRESH_MS = 5;   // delta drop that ends a loss event
      const MIN_EVENT_DELTA   = 25;  // ignore micro-events smaller than this

      for (const l of laps) {
        if (l.isPb) continue;
        const m = microSectorsForLap(l._lap, N);
        if (!m) continue;
        const muSum = m.reduce((a,b) => a + (b||0), 0);
        if (Math.abs(muSum - l.completedMs) > 500) continue;

        // Build the per-μ delta series for this lap
        const deltas = new Array(N).fill(null);
        for (let k = 0; k < N; k++) {
          if (m[k] != null && pbMicros[k] != null) deltas[k] = m[k] - pbMicros[k];
        }

        // Loss accumulators (always)
        for (let k = 0; k < N; k++) {
          if (deltas[k] != null) {
            lossSums[k] += deltas[k];
            lossCounts[k]++;
          }
        }

        // Rising-edge detection over deltas
        let edgeStartK = -1;
        let edgeStartDelta = 0;
        let prevDelta = 0;
        let prevWasNull = true;
        for (let k = 0; k < N; k++) {
          const d = deltas[k];
          if (d == null) {
            // Close any open edge using the last known peak
            if (edgeStartK >= 0) {
              const mag = prevDelta - edgeStartDelta;
              if (mag >= MIN_EVENT_DELTA) {
                onsetSums[edgeStartK] += mag;
                onsetCounts[edgeStartK]++;
              }
              edgeStartK = -1;
            }
            prevWasNull = true;
            prevDelta = 0;
            continue;
          }
          // Detect new edge start: significant growth from current baseline
          if (edgeStartK < 0) {
            if (d - prevDelta >= GROW_THRESH_MS) {
              edgeStartK = k;
              edgeStartDelta = prevDelta;
            }
          } else {
            // Already in an edge — check for end (delta has plateaued or recovered)
            if (d <= prevDelta - RECOVER_THRESH_MS || d <= prevDelta) {
              const peakDelta = prevDelta;
              const mag = peakDelta - edgeStartDelta;
              if (mag >= MIN_EVENT_DELTA) {
                onsetSums[edgeStartK] += mag;
                onsetCounts[edgeStartK]++;
              }
              edgeStartK = -1;
              // The current k might itself be a fresh recovery — re-evaluate as potential new edge below in next iteration.
            }
          }
          prevWasNull = false;
          prevDelta = d;
        }
        // Close any open edge at end of lap
        if (edgeStartK >= 0) {
          const mag = prevDelta - edgeStartDelta;
          if (mag >= MIN_EVENT_DELTA) {
            onsetSums[edgeStartK] += mag;
            onsetCounts[edgeStartK]++;
          }
        }
      }

      const totalLaps = laps.filter(l => !l.isPb).length;
      for (let k = 0; k < N; k++) {
        if (lossCounts[k] === 0 && onsetCounts[k] === 0) continue;
        // Onset score: average magnitude PER LAP (not per onset event), so a μ-sector
        // that is the cause in 50% of laps with avg 200ms loss outranks one that's
        // the cause in 5% of laps with avg 600ms loss.
        const onset = totalLaps > 0 ? onsetSums[k] / totalLaps : 0;
        const loss  = lossCounts[k] > 0 ? lossSums[k] / lossCounts[k] : 0;
        const idx = Math.floor(pbTrace.length * (k + 0.5) / N);
        darkSpots.push({
          x: pbTrace[idx].x,
          z: pbTrace[idx].z,
          avgDeltaMs: MODE === 'loss' ? loss : onset, // active metric for sizing
          avgOnsetMs: onset,
          avgLossMs:  loss,
          onsetEventCount: onsetCounts[k],
          count: lossCounts[k],
          idx: k + 1,
        });
      }
    }
  }

  // Project XZ into viewBox, preserving the track's actual aspect ratio so
  // the shape is not distorted. viewBox dimensions = track world dimensions
  // (in meters) — SVG handles the screen-space scaling.
  const all = pbTrace.concat(lastTrace).concat(ghostTrace);
  let minX=Infinity, maxX=-Infinity, minZ=Infinity, maxZ=-Infinity;
  for (const p of all) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
  }
  const padX = (maxX-minX)*0.05 || 1;
  const padZ = (maxZ-minZ)*0.05 || 1;
  minX-=padX; maxX+=padX; minZ-=padZ; maxZ+=padZ;
  const W = maxX - minX;   // world units (m), preserves aspect
  const H = maxZ - minZ;
  function proj(p) {
    // GT7 world coords: X = east-west, Z = north-south (Z increases southward
    // in PD's conventions, based on observed Big Willow telemetry). SVG Y
    // increases downward, so map Z directly to SVG Y — no flip — and the
    // track orientation matches the in-game minimap.
    return [
      (p.x - minX),
      (p.z - minZ),
    ];
  }
  function pathFor(trace) {
    if (!trace.length) return '';
    const [x0,y0] = proj(trace[0]);
    let d = `M ${x0.toFixed(1)} ${y0.toFixed(1)}`;
    for (let i=1;i<trace.length;i++) {
      const [x,y] = proj(trace[i]);
      d += ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
    }
    return d;
  }
  const pbPath = pathFor(pbTrace);
  const lastPath = pathFor(lastTrace);
  const ghostPath = ghostTrace.length ? pathFor(ghostTrace) : '';
  const [s1x,s1y] = proj(sectorBoundaries.s1End);
  const [s2x,s2y] = proj(sectorBoundaries.s2End);
  const [stx,sty] = proj(pbTrace[0]);

  // Live car position (radius scaled to world units; deferred until after we
  // know markerR below, but inline so the template can interpolate it).
  const live = state.packet?.position;
  const liveAvailable = live && Date.now() - state.lastUpdateMs < 5000;
  let livePos = null;
  if (liveAvailable) livePos = proj(live);

  // Stroke widths in world-unit space: ~1.5m for the lines. Marker radii scaled accordingly.
  const stroke = Math.max(W, H) * 0.003;
  const markerR = Math.max(W, H) * 0.008;
  const fontSize = Math.max(W, H) * 0.018;
  const liveCircle = livePos
    ? `<circle cx="${livePos[0].toFixed(1)}" cy="${livePos[1].toFixed(1)}" r="${(markerR*1.2).toFixed(1)}" fill="#00e676" stroke="#fff" stroke-width="${(stroke*0.6).toFixed(2)}"/>`
    : '';

  // Ghost-vs-PB analysis: for each ghost-trace sample, find the nearest PB
  // point. Captures lateral offset (line difference) and input deltas at the
  // same physical track location. When ghost is a WR replay, this shows
  // exactly where the WR carries more speed, brakes less, throttles earlier.
  let comparisonChart = null;
  if (ghostTrace.length > 30 && pbTrace.length > 30) {
    const samples = [];
    for (let i = 0; i < ghostTrace.length; i++) {
      const g = ghostTrace[i];
      let bestD = Infinity, bestPb = null;
      for (const p of pbTrace) {
        const dx = p.x - g.x, dz = p.z - g.z;
        const d2 = dx*dx + dz*dz;
        if (d2 < bestD) { bestD = d2; bestPb = p; }
      }
      samples.push({
        progress: i / (ghostTrace.length - 1),
        devM:        Math.sqrt(bestD),
        speedDelta:  (g.speedKph || 0) - (bestPb?.speedKph || 0),  // + = ghost faster
        brakeDelta:  ((g.brake || 0) - (bestPb?.brake || 0)) / 2.55, // % points: + = ghost brakes more
        throttleDelta: ((g.throttle || 0) - (bestPb?.throttle || 0)) / 2.55,
        ghostSpeed:  g.speedKph || 0,
        pbSpeed:     bestPb?.speedKph || 0,
        ghostBrake:  (g.brake || 0) / 2.55,
        pbBrake:     (bestPb?.brake || 0) / 2.55,
        ghostThr:    (g.throttle || 0) / 2.55,
        pbThr:       (bestPb?.throttle || 0) / 2.55,
        x: g.x, z: g.z,
      });
    }
    comparisonChart = samples;
  }
  // Backwards-compat alias for the existing lateral chart variable name
  const deviationChart = comparisonChart;

  // Build dark-spot SVG circles. Size + opacity scaled by avg delta. Cap radius
  // so the worst spot doesn't eclipse the track; ignore micro-sectors that are
  // FASTER than PB on average (those aren't problems).
  let maxDelta = 0;
  for (const s of darkSpots) if (s.avgDeltaMs > maxDelta) maxDelta = s.avgDeltaMs;
  const fillColor = MODE === 'cause' ? '#ff5252' : '#ff9800'; // red for cause, orange for effect
  const darkSpotsSvg = darkSpots.map(s => {
    if (s.avgDeltaMs <= 0) return '';
    const intensity = maxDelta > 0 ? s.avgDeltaMs / maxDelta : 0;
    const [sx, sy] = proj(s);
    const r = markerR * (0.8 + intensity * 3.5);
    const opacity = 0.18 + intensity * 0.55;
    return `<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="${r.toFixed(1)}" fill="${fillColor}" opacity="${opacity.toFixed(2)}"><title>μ${s.idx} of ${N}: ONSET +${(s.avgOnsetMs/1000).toFixed(3)}s/lap (mistake started here on ${s.onsetEventCount||0} laps) · LOSS ${s.avgLossMs>=0?'+':''}${(s.avgLossMs/1000).toFixed(3)}s avg · XZ(${s.x.toFixed(0)},${s.z.toFixed(0)})</title></circle>`;
  }).join('');

  // Top-5 dark-spot labels — for the worst hot zones, draw a small number tag
  const top5 = darkSpots.slice().filter(s => s.avgDeltaMs > 0).sort((a,b) => b.avgDeltaMs - a.avgDeltaMs).slice(0, 5);
  const topLabelsSvg = top5.map((s, rank) => {
    const [sx, sy] = proj(s);
    return `<text x="${(sx + markerR*1.4).toFixed(1)}" y="${(sy + markerR*0.4).toFixed(1)}" fill="#ffcdd2" font-size="${(fontSize*0.9).toFixed(1)}" font-weight="600">+${(s.avgDeltaMs/1000).toFixed(2)}s</text>`;
  }).join('');

  return `<!doctype html><html><head><meta charset="utf-8">
<title>track</title>
${BASE_CSS}${NAV_HTML}
<style>
  /* Track page overrides — give the map the whole viewport minus chrome */
  body.track-page{padding:12px}
  body.track-page h1{font-size:18px;margin:0}
  body.track-page .sub{margin:2px 0 8px;font-size:12px}
  body.track-page .nav{margin-bottom:8px}
  .track-wrap{display:flex;gap:12px;align-items:flex-start;height:calc(100vh - 110px);min-height:480px}
  body.track-page{overflow-y:auto}
  .track-wrap .map{flex:1 1 auto;background:#070b14;border:1px solid #1f2a44;border-radius:8px;padding:8px;display:flex;align-items:center;justify-content:center;height:100%;min-height:0}
  .track-wrap svg{max-width:100%;max-height:100%;width:auto;height:auto;display:block}
  .track-wrap aside{flex:0 0 220px;background:#0f1626;border:1px solid #1f2a44;border-radius:8px;padding:12px;font-size:13px}
  .track-wrap aside h3{margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#8aa0d0;font-weight:600}
  .track-wrap aside .kv{display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid #1a2238}
  .track-wrap aside .kv:last-child{border:none}
  .track-wrap aside .k{color:#7a8499}
  .track-wrap aside .leg{font-size:11px;color:#7a8499;line-height:1.7;margin-top:8px}
  .track-wrap aside .leg span{display:inline-block;width:10px;height:10px;margin-right:6px;vertical-align:middle;border-radius:2px}
</style>
</head><body class="track-page">
${navLinks('track')}
<h1>Track map · <span style="color:${MODE==='cause'?'#ff5252':'#ff9800'};font-size:14px;text-transform:uppercase;letter-spacing:.1em">${MODE} map</span></h1>
<div class="sub">${state.meta.track?.name || ''} · ${state.meta.car?.name || ''} · ${darkSpots.length} dark spots showing ${MODE === 'cause' ? 'where mistakes START' : 'where you are SLOWEST'}</div>
<div id="hw-banner" style="display:none;padding:8px 12px;border-radius:4px;font-weight:600;margin:0 0 8px 0;font-size:14px"></div>

<div class="track-wrap">
  <div class="map">
    <svg viewBox="0 0 ${W.toFixed(1)} ${H.toFixed(1)}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
      <path d="${pbPath}" fill="none" stroke="#b388ff" stroke-width="${stroke.toFixed(2)}" stroke-linejoin="round" stroke-linecap="round" opacity="0.9"/>
      ${ghostPath ? `<path d="${ghostPath}" fill="none" stroke="#ffeb3b" stroke-width="${(stroke*0.85).toFixed(2)}" stroke-linejoin="round" stroke-linecap="round" stroke-dasharray="${(stroke*2.5).toFixed(1)} ${stroke.toFixed(1)}" opacity="0.95"/>` : ''}
      ${lastPath ? `<path d="${lastPath}" fill="none" stroke="#fff" stroke-width="${(stroke*0.7).toFixed(2)}" stroke-linejoin="round" stroke-linecap="round" opacity="0.75"/>` : ''}
      <g class="dark-spots">${darkSpotsSvg}</g>
      <g class="dark-spots-labels">${topLabelsSvg}</g>
      <circle cx="${stx.toFixed(1)}" cy="${sty.toFixed(1)}" r="${markerR.toFixed(1)}" fill="#00d4ff"/>
      <text x="${(stx+markerR*1.3).toFixed(1)}" y="${(sty-markerR*0.8).toFixed(1)}" fill="#00d4ff" font-size="${fontSize.toFixed(1)}">START</text>
      <circle cx="${s1x.toFixed(1)}" cy="${s1y.toFixed(1)}" r="${(markerR*0.85).toFixed(1)}" fill="#ffeb3b"/>
      <text x="${(s1x+markerR*1.3).toFixed(1)}" y="${(s1y-markerR*0.8).toFixed(1)}" fill="#ffeb3b" font-size="${fontSize.toFixed(1)}">S1→S2</text>
      <circle cx="${s2x.toFixed(1)}" cy="${s2y.toFixed(1)}" r="${(markerR*0.85).toFixed(1)}" fill="#ffeb3b"/>
      <text x="${(s2x+markerR*1.3).toFixed(1)}" y="${(s2y-markerR*0.8).toFixed(1)}" fill="#ffeb3b" font-size="${fontSize.toFixed(1)}">S2→S3</text>
      ${liveCircle}
    </svg>
  </div>
  <aside>
    <h3>Audio coach</h3>
    <button id="audio-toggle" onclick="toggleAudio()" style="width:100%;padding:8px;background:#1a2238;color:#7a8499;border:1px solid #1f2a44;border-radius:4px;cursor:pointer;font-size:12px;margin-bottom:6px">Audio coach: OFF</button>
    <button id="bt-toggle" onclick="toggleBt()" style="width:100%;padding:6px;background:#1a2238;color:#7a8499;border:1px solid #1f2a44;border-radius:4px;cursor:pointer;font-size:11px;margin-bottom:4px">BT mode: OFF</button>
    <div id="bt-latency-row" style="display:none;font-size:11px;margin-bottom:6px">
      Speaker lag: <span id="bt-latency-val">200 ms</span><br>
      <input type="range" min="50" max="500" step="10" value="200" oninput="setBtLatency(this.value)" style="width:100%">
    </div>
    <button onclick="testTone()" style="width:100%;padding:5px;background:transparent;color:#7a8499;border:1px dashed #1f2a44;border-radius:4px;cursor:pointer;font-size:11px;margin-bottom:6px">▶ test tone (severe pattern)</button>
    <div class="leg" style="font-size:10px;margin:0 0 12px">Fires aviation-style tones before dark spots. Severe ≥250ms: low+high beep T-1.1s. Moderate ≥150ms: T-0.9s. Mild ≥80ms: T-0.6s. <b>BT mode</b> emits a sub-audible carrier so the speaker stays awake, AND fires earlier by your speaker-lag estimate.</div>
    <h3>Live</h3>
    <div class="kv"><span class="k">speed</span><span id="av-speed">—</span></div>
    <div class="kv"><span class="k">gear</span><span id="av-gear">—</span></div>
    <div class="kv"><span class="k">throttle</span><span id="av-thr">—</span></div>
    <div class="kv"><span class="k">brake</span><span id="av-brk">—</span></div>
    <h3 style="margin-top:14px">Brake-stuck monitor</h3>
    <div id="hw-stat" style="font-size:11px;line-height:1.6;color:#7a8499">
      current: <b>0.00s</b><br>worst this lap: <b>0.00s</b><br>total today: <b>0.0s</b><br>warnings fired: <b>0</b>
    </div>
    <div class="leg" style="font-size:10px;margin-top:6px">Fires when brake >2% AND throttle >50% for ≥250ms continuously. Triple-pulse alert tone (audio coach must be on). Banner stays visible while the conflict persists.</div>
    <h3 style="margin-top:14px">Dark-spot mode</h3>
    <div class="leg" style="margin-bottom:6px;line-height:1.5">
      <a href="/track?n=${N}&mode=cause" style="margin-right:6px;padding:3px 8px;border:1px solid ${MODE==='cause'?'#ff5252':'#1f2a44'};border-radius:3px;color:${MODE==='cause'?'#ff5252':'#7a8499'};text-decoration:none">cause</a>
      <a href="/track?n=${N}&mode=loss" style="padding:3px 8px;border:1px solid ${MODE==='loss'?'#ff9800':'#1f2a44'};border-radius:3px;color:${MODE==='loss'?'#ff9800':'#7a8499'};text-decoration:none">loss</a>
      <div style="margin-top:6px;color:#7a8499;font-size:10px">
        <b style="color:${MODE==='cause'?'#ff5252':'#7a8499'}">cause</b>: where time loss STARTS (input mistake — closer to upstream of the corner)<br>
        <b style="color:${MODE==='loss'?'#ff9800':'#7a8499'}">loss</b>: where you're slowest (effect — usually downstream on the next straight)
      </div>
    </div>
    <h3 style="margin-top:14px">Resolution</h3>
    <div class="leg" style="margin-bottom:6px">
      ${[10,30,60,100].map(k => `<a href="/track?n=${k}&mode=${MODE}" style="margin-right:6px;color:${k===N?'#00d4ff':'#7a8499'};text-decoration:none">${k}</a>`).join('')}
    </div>
    <h3 style="margin-top:14px">Top spots — ${MODE === 'cause' ? 'CAUSE' : 'LOSS'}</h3>
    <div style="font-size:11px">
      ${top5.map(s => `<div class="kv"><span class="k">μ${s.idx}</span><span class="bad">+${(s.avgDeltaMs/1000).toFixed(3)}s</span></div>`).join('') || '<div class="leg">no data yet</div>'}
    </div>
    <h3 style="margin-top:14px">Legend</h3>
    <div class="leg">
      <div><span style="background:#b388ff"></span>PB lap trace</div>
      ${ghost ? `<div><span style="background:#ffeb3b"></span>Ghost: ${ghost.label || 'reference'} (${(ghost.completedMs/1000).toFixed(3)}s)</div>` : ''}
      <div><span style="background:#fff"></span>Last lap trace</div>
      <div><span style="background:#00e676"></span>Live car position</div>
      <div><span style="background:${fillColor};opacity:.7"></span>Dark spot — <b>${MODE}</b> map</div>
      <div><span style="background:#ffeb3b"></span>Sector boundary</div>
      <div><span style="background:#00d4ff"></span>Start / finish</div>
    </div>
    <div class="leg" style="margin-top:10px">
      Track ${W.toFixed(0)}×${H.toFixed(0)}m · ${N} μ-sectors · <b>${MODE}</b> mode<br>
      ${darkSpots.length} measured · across ${laps.length - 1} non-PB laps
    </div>
  </aside>
</div>

<script>
// ============================================================
// Audio coach: aviation-style proximity warnings for dark spots.
// ============================================================
const DARK_SPOTS = ${JSON.stringify(darkSpots.filter(s => s.avgDeltaMs > 0).map(s => ({
  x: s.x, z: s.z, avgDeltaMs: Math.round(s.avgDeltaMs), idx: s.idx
})))};
const SEVERITY_TIERS = [
  { min: 250, label: 'severe',   armAtMs: 2200, fireAtMs: 1100, freq1: 220, freq2: 440 },
  { min: 150, label: 'moderate', armAtMs: 1800, fireAtMs: 900,  freq1: 330, freq2: 0   },
  { min: 80,  label: 'mild',     armAtMs: 1200, fireAtMs: 600,  freq1: 440, freq2: 0   },
];
function tierFor(deltaMs) {
  for (const t of SEVERITY_TIERS) if (deltaMs >= t.min) return t;
  return null;
}

// Hardware-anomaly tracking (ship-named: brake-stuck detection)
const hwState = {
  // Sliding window of recent (t, brake%, throttle%) — used to detect "brake AND
  // throttle both pressed" sustained beyond a normal trail-braking window.
  // Threshold values are deliberately conservative: only fire if the conflict
  // lasts >250ms continuously, which is well beyond any human input overlap.
  conflictStartT: null,
  lastWarnAtT: 0,
  totalWarnings: 0,
  totalConflictMs: 0,
  // Live counters shown in sidebar
  currentConflictMs: 0,
  worstThisLapMs: 0,
  lastLapCountSeen: null,
};
const BRAKE_DEADZONE_PCT  = 2.0;   // applied to all anomaly logic — matches recommended GT7 deadzone
const THROTTLE_TRIGGER_PCT = 50;
const STUCK_WARN_MS = 250;          // how long the conflict must persist before warning
const STUCK_REWARN_MS = 1500;       // don't spam — re-warn at most every 1.5s

const audio = {
  ctx: null,
  enabled: false,
  btMode: false,            // when true: keeps BT speaker awake + fires warnings earlier
  btLatencyMs: 200,         // estimated BT speaker latency to compensate for
  carrier: null,            // {osc, gain} — sub-audible hum that holds BT channel open
  spotState: new Map(),
  lastPositions: [],
  lastLapCount: null,
  enable() {
    if (this.enabled) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.enabled = true;
    document.getElementById('audio-toggle').textContent = 'Audio coach: ON';
    document.getElementById('audio-toggle').style.color = '#00e676';
    this.tone(660, 0.18, 0.05); // confirmation chime
    if (this.btMode) this.startCarrier();
  },
  disable() {
    this.enabled = false;
    this.stopCarrier();
    if (this.ctx) { this.ctx.close().catch(()=>{}); this.ctx = null; }
    document.getElementById('audio-toggle').textContent = 'Audio coach: OFF';
    document.getElementById('audio-toggle').style.color = '#7a8499';
  },
  startCarrier() {
    if (!this.ctx || this.carrier) return;
    // Very quiet, low-frequency hum — keeps BT speaker from sleeping/reconnecting
    // between warning tones. Inaudible against game audio but enough to hold the
    // audio session active (no wake-up latency on subsequent tones).
    const osc = this.ctx.createOscillator();
    const g   = this.ctx.createGain();
    osc.frequency.value = 80;
    osc.type = 'sine';
    g.gain.value = 0.0008;  // ~−60 dB. Below conscious perception over game audio.
    osc.connect(g); g.connect(this.ctx.destination);
    osc.start();
    this.carrier = { osc, gain: g };
  },
  stopCarrier() {
    if (!this.carrier) return;
    try { this.carrier.osc.stop(); this.carrier.osc.disconnect(); this.carrier.gain.disconnect(); } catch {}
    this.carrier = null;
  },
  setBtMode(on) {
    this.btMode = on;
    document.getElementById('bt-toggle').textContent = on ? 'BT mode: ON (carrier + early-fire)' : 'BT mode: OFF';
    document.getElementById('bt-toggle').style.color = on ? '#00e676' : '#7a8499';
    document.getElementById('bt-latency-row').style.display = on ? '' : 'none';
    if (this.enabled) {
      if (on) { this.startCarrier(); this.warmup(); }
      else this.stopCarrier();
    }
  },
  setBtLatency(ms) {
    this.btLatencyMs = Math.max(0, Math.min(800, Number(ms) || 200));
    document.getElementById('bt-latency-val').textContent = this.btLatencyMs + ' ms';
  },
  warmup() {
    // Brief sub-audible click to wake the speaker right before a warning batch.
    // Only used when BT mode is on.
    if (!this.enabled || !this.ctx) return;
    const t0 = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g   = this.ctx.createGain();
    osc.frequency.value = 1000;
    osc.type = 'sine';
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.005, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.06);
    osc.connect(g); g.connect(this.ctx.destination);
    osc.start(t0); osc.stop(t0 + 0.08);
  },
  tone(freqHz, durSec, gain) {
    if (!this.enabled || !this.ctx) return;
    const t0 = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g   = this.ctx.createGain();
    osc.frequency.value = freqHz;
    osc.type = 'sine';
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain || 0.15, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + durSec);
    osc.connect(g); g.connect(this.ctx.destination);
    osc.start(t0); osc.stop(t0 + durSec + 0.05);
  },
  testTone() {
    if (!this.enabled) return;
    if (this.btMode) this.warmup();
    setTimeout(() => { this.tone(330, 0.14, 0.18); setTimeout(() => this.tone(660, 0.14, 0.18), 180); }, this.btMode ? 60 : 0);
  },
};

window.toggleAudio = function() {
  if (audio.enabled) audio.disable(); else audio.enable();
};
window.toggleBt = function() { audio.setBtMode(!audio.btMode); };
window.setBtLatency = function(v) { audio.setBtLatency(v); };
window.testTone = function() { audio.testTone(); };

async function pollPosition() {
  try {
    const r = await fetch('/position.json', { cache: 'no-store' });
    const p = await r.json();
    if (!p.ok) return;
    const now = Date.now();
    audio.lastPositions.push({ t: now, x: p.x, z: p.z, speed: p.speedKph });
    if (audio.lastPositions.length > 6) audio.lastPositions.shift();
    // On lap change, reset per-spot armed state + per-lap hardware counters
    if (p.lapCount !== audio.lastLapCount) {
      audio.spotState.clear();
      audio.lastLapCount = p.lapCount;
      hwState.worstThisLapMs = 0;
      hwState.lastLapCountSeen = p.lapCount;
    }
    // Update on-screen vitals
    document.getElementById('av-speed').textContent = (p.speedKph || 0).toFixed(0) + ' kph';
    document.getElementById('av-gear').textContent  = p.gear === 0 ? 'R' : p.gear === 15 ? 'N' : String(p.gear);
    document.getElementById('av-thr').textContent   = Math.round((p.throttle||0)/2.55) + '%';
    document.getElementById('av-brk').textContent   = Math.round((p.brake||0)/2.55) + '%';
    // Hardware-anomaly check (always on, independent of audio coach toggle)
    checkBrakeStuck(p, now);
    // Compute heading + audio cue work
    if (audio.enabled && audio.lastPositions.length >= 2 && (p.speedKph || 0) > 30) {
      checkProximity(p);
    }
  } catch (e) {}
}

function checkBrakeStuck(p, now) {
  const brakePct = (p.brake || 0) / 2.55;
  const thrPct   = (p.throttle || 0) / 2.55;
  const conflict = (brakePct > BRAKE_DEADZONE_PCT) && (thrPct > THROTTLE_TRIGGER_PCT);
  const banner = document.getElementById('hw-banner');

  if (conflict) {
    if (hwState.conflictStartT === null) hwState.conflictStartT = now;
    const dur = now - hwState.conflictStartT;
    hwState.currentConflictMs = dur;
    if (dur > hwState.worstThisLapMs) hwState.worstThisLapMs = dur;
    if (dur >= STUCK_WARN_MS) {
      banner.style.display = 'block';
      banner.style.background = '#ff5252';
      banner.style.color = '#fff';
      banner.textContent = '⚠ BRAKE STUCK — ' + (dur/1000).toFixed(2) + 's of brake+throttle conflict (brake ' + brakePct.toFixed(0) + '%, throttle ' + thrPct.toFixed(0) + '%)';
      // Audible warning: distinct from dark-spot tones — a fast triple-pulse
      if (audio.enabled && (now - hwState.lastWarnAtT) > STUCK_REWARN_MS) {
        if (audio.btMode) audio.warmup();
        const d = audio.btMode ? 60 : 0;
        setTimeout(() => audio.tone(880, 0.10, 0.20), d);
        setTimeout(() => audio.tone(880, 0.10, 0.20), d + 130);
        setTimeout(() => audio.tone(880, 0.10, 0.20), d + 260);
        hwState.lastWarnAtT = now;
        hwState.totalWarnings++;
      }
    }
  } else {
    // Conflict cleared
    if (hwState.conflictStartT !== null) {
      hwState.totalConflictMs += (now - hwState.conflictStartT);
      hwState.conflictStartT = null;
    }
    hwState.currentConflictMs = 0;
    if (banner.style.display === 'block') {
      // Hold warning for a beat so the user sees it, then fade
      setTimeout(() => { if (hwState.conflictStartT === null) banner.style.display = 'none'; }, 1500);
    }
  }
  // Update sidebar live counter
  const stat = document.getElementById('hw-stat');
  if (stat) {
    stat.innerHTML =
      'current: <b>' + (hwState.currentConflictMs/1000).toFixed(2) + 's</b><br>' +
      'worst this lap: <b>' + (hwState.worstThisLapMs/1000).toFixed(2) + 's</b><br>' +
      'total today: <b>' + (hwState.totalConflictMs/1000).toFixed(1) + 's</b><br>' +
      'warnings fired: <b>' + hwState.totalWarnings + '</b>';
  }
}

function checkProximity(p) {
  // Heading: vector from earliest in window to current, normalized.
  const a = audio.lastPositions[0];
  const b = audio.lastPositions[audio.lastPositions.length - 1];
  const hx = b.x - a.x, hz = b.z - a.z;
  const hmag = Math.hypot(hx, hz);
  if (hmag < 1) return; // too slow to estimate heading
  const ux = hx / hmag, uz = hz / hmag;
  const speedMs = (p.speedKph || 0) / 3.6;
  const now = Date.now();
  // BT mode: pull warning timing forward to compensate for speaker latency.
  const earlyMs = audio.btMode ? audio.btLatencyMs : 0;

  for (const s of DARK_SPOTS) {
    const tier = tierFor(s.avgDeltaMs);
    if (!tier) continue;
    const dx = s.x - p.x, dz = s.z - p.z;
    const forward = dx * ux + dz * uz;
    if (forward <= 0) continue;
    const lateral = Math.abs(dx * (-uz) + dz * ux);
    if (lateral > 40) continue;
    const timeToMs = (forward / speedMs) * 1000;
    const armAt  = tier.armAtMs  + earlyMs;
    const fireAt = tier.fireAtMs + earlyMs;
    if (timeToMs > armAt) continue;
    const st = audio.spotState.get(s.idx) || { armedAt: 0, firedAt: 0 };
    if (now - (st.firedAt || 0) < 5000) continue;
    if (timeToMs <= fireAt) {
      // BT mode: warmup pulse first (wakes the speaker), then the actual tone(s).
      if (audio.btMode) audio.warmup();
      const fireDelay = audio.btMode ? 60 : 0;
      setTimeout(() => audio.tone(tier.freq1, 0.18, 0.18), fireDelay);
      if (tier.freq2) setTimeout(() => audio.tone(tier.freq2, 0.18, 0.18), fireDelay + 200);
      st.firedAt = now;
      audio.spotState.set(s.idx, st);
    } else if (!st.armedAt) {
      audio.tone(tier.freq1 * 0.6, 0.10, 0.07);
      st.armedAt = now;
      audio.spotState.set(s.idx, st);
    }
  }
}

setInterval(pollPosition, 200);
pollPosition();
</script>

${comparisonChart ? `
<div class="panel" style="margin-top:8px">
  <h2>Speed delta: ghost (${ghost.label || 'reference'}) vs your PB</h2>
  <p class="sub" style="margin:-6px 0 8px 0">Positive = ghost is FASTER at this point. Where this is consistently positive at corners, the ghost is carrying more momentum (less braking, earlier throttle).</p>
  <svg viewBox="0 0 800 160" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:160px;background:#070b14;border-radius:6px;display:block">
    ${(() => {
      const maxAbs = Math.max(...comparisonChart.map(s => Math.abs(s.speedDelta)), 5);
      const zeroY = 80;
      const path = comparisonChart.map((s, i) => {
        const x = s.progress * 800;
        const y = zeroY - (s.speedDelta / maxAbs) * 70;
        return (i === 0 ? 'M' : 'L') + ` ${x.toFixed(1)} ${y.toFixed(1)}`;
      }).join(' ');
      const pos = comparisonChart.map((s, i) => {
        const x = s.progress * 800;
        const y = zeroY - (Math.max(0, s.speedDelta) / maxAbs) * 70;
        return (i === 0 ? 'M' : 'L') + ` ${x.toFixed(1)} ${y.toFixed(1)}`;
      }).join(' ');
      const grid = [25,50,75].map(p => `<line x1="${p*8}" y1="0" x2="${p*8}" y2="160" stroke="#1a2238"/>`).join('');
      const pbS  = (comparisonChart.reduce((a,s) => a + s.pbSpeed, 0) / comparisonChart.length);
      const ghS  = (comparisonChart.reduce((a,s) => a + s.ghostSpeed, 0) / comparisonChart.length);
      // Top-5 positive deltas (where ghost is most ahead)
      const peaks = comparisonChart.map((s, i) => ({ ...s, idx: i }))
        .sort((a,b) => b.speedDelta - a.speedDelta).slice(0, 5);
      const peakMarkers = peaks.map(p => {
        const x = p.progress * 800;
        const y = zeroY - (p.speedDelta / maxAbs) * 70;
        return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="#00e676"/>` +
               `<text x="${(x+6).toFixed(1)}" y="${(y-2).toFixed(1)}" fill="#00e676" font-size="11">+${p.speedDelta.toFixed(0)} kph @ XZ(${p.x.toFixed(0)},${p.z.toFixed(0)})</text>`;
      }).join('');
      return `${grid}
        <line x1="0" y1="${zeroY}" x2="800" y2="${zeroY}" stroke="#3d5a96" stroke-dasharray="3 3"/>
        <path d="${path}" fill="none" stroke="#ffeb3b" stroke-width="1.5"/>
        ${peakMarkers}
        <text x="6" y="14" fill="#7a8499" font-size="11">+${maxAbs.toFixed(0)} kph (ghost faster)</text>
        <text x="6" y="155" fill="#7a8499" font-size="11">−${maxAbs.toFixed(0)} kph (ghost slower)</text>
        <text x="780" y="14" fill="#7a8499" font-size="11" text-anchor="end">avg ghost ${ghS.toFixed(0)} vs PB ${pbS.toFixed(0)} kph</text>`;
    })()}
  </svg>
  <p class="sub" style="margin:6px 0 0 0">Lap progress 0% → 100% left to right. Yellow = speed delta. Green dots = top-5 points where ghost is fastest relative to you.</p>
</div>

<div class="panel" style="margin-top:8px">
  <h2>Brake & throttle deltas</h2>
  <p class="sub" style="margin:-6px 0 8px 0">Red = ghost brakes more here. Green = ghost throttles more here. Patterns at corners reveal the input differences that produce the speed deltas above.</p>
  <svg viewBox="0 0 800 160" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:160px;background:#070b14;border-radius:6px;display:block">
    ${(() => {
      const zeroY = 80;
      const grid = [25,50,75].map(p => `<line x1="${p*8}" y1="0" x2="${p*8}" y2="160" stroke="#1a2238"/>`).join('');
      // Brake delta in red, throttle delta in green. Both clamped to ±100 (percentage points).
      const brakePath = comparisonChart.map((s, i) => {
        const x = s.progress * 800;
        const v = Math.max(-100, Math.min(100, s.brakeDelta));
        const y = zeroY - (v / 100) * 70;
        return (i === 0 ? 'M' : 'L') + ` ${x.toFixed(1)} ${y.toFixed(1)}`;
      }).join(' ');
      const throttlePath = comparisonChart.map((s, i) => {
        const x = s.progress * 800;
        const v = Math.max(-100, Math.min(100, s.throttleDelta));
        const y = zeroY - (v / 100) * 70;
        return (i === 0 ? 'M' : 'L') + ` ${x.toFixed(1)} ${y.toFixed(1)}`;
      }).join(' ');
      const ghBrakeAvg = comparisonChart.reduce((a,s)=>a+s.ghostBrake,0)/comparisonChart.length;
      const pbBrakeAvg = comparisonChart.reduce((a,s)=>a+s.pbBrake,0)/comparisonChart.length;
      const ghThrAvg   = comparisonChart.reduce((a,s)=>a+s.ghostThr,0)/comparisonChart.length;
      const pbThrAvg   = comparisonChart.reduce((a,s)=>a+s.pbThr,0)/comparisonChart.length;
      return `${grid}
        <line x1="0" y1="${zeroY}" x2="800" y2="${zeroY}" stroke="#3d5a96" stroke-dasharray="3 3"/>
        <path d="${brakePath}" fill="none" stroke="#ff5252" stroke-width="1.4" opacity="0.85"/>
        <path d="${throttlePath}" fill="none" stroke="#00e676" stroke-width="1.4" opacity="0.85"/>
        <text x="6" y="14" fill="#7a8499" font-size="11">+100% (ghost more)</text>
        <text x="6" y="155" fill="#7a8499" font-size="11">−100% (ghost less)</text>
        <text x="780" y="14" fill="#ff5252" font-size="11" text-anchor="end">brake avg: ghost ${ghBrakeAvg.toFixed(1)}% vs PB ${pbBrakeAvg.toFixed(1)}%</text>
        <text x="780" y="28" fill="#00e676" font-size="11" text-anchor="end">throttle avg: ghost ${ghThrAvg.toFixed(1)}% vs PB ${pbThrAvg.toFixed(1)}%</text>`;
    })()}
  </svg>
</div>

<div class="panel" style="margin-top:8px">
  <h2>Lateral deviation: your PB line vs ghost (${ghost.label || 'reference'})</h2>
  <p class="sub" style="margin:-6px 0 8px 0">Distance in meters between your PB racing line and the ghost line at each point of the lap. Peaks identify corners where the two racing lines diverge most. Clicking on the chart at a peak tells you which corner to study on the map above.</p>
  <svg viewBox="0 0 800 140" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:140px;background:#070b14;border-radius:6px;display:block">
    ${(() => {
      const maxDev = Math.max(...deviationChart.map(s => s.devM), 1);
      const meanDev = deviationChart.reduce((a,b) => a+b.devM, 0) / deviationChart.length;
      const path = deviationChart.map((s, i) => {
        const x = s.progress * 800;
        const y = 140 - (s.devM / maxDev) * 130;
        return (i === 0 ? 'M' : 'L') + ` ${x.toFixed(1)} ${y.toFixed(1)}`;
      }).join(' ');
      // Gridlines at 25%, 50%, 75%
      const grid = [25,50,75].map(p => `<line x1="${p*8}" y1="0" x2="${p*8}" y2="140" stroke="#1a2238"/>`).join('');
      // Mean line
      const meanY = 140 - (meanDev / maxDev) * 130;
      // Top-3 deviation peaks
      const peaks = deviationChart
        .map((s, i) => ({ ...s, idx: i }))
        .filter((s, i, arr) => i > 1 && i < arr.length-1 && s.devM > arr[i-1].devM && s.devM > arr[i+1].devM)
        .sort((a,b) => b.devM - a.devM).slice(0, 5);
      const peakMarkers = peaks.map(p => {
        const x = p.progress * 800;
        const y = 140 - (p.devM / maxDev) * 130;
        return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="#ff5252"/>` +
               `<text x="${(x+6).toFixed(1)}" y="${(y+4).toFixed(1)}" fill="#ff5252" font-size="11">${p.devM.toFixed(1)}m @ XZ(${p.x.toFixed(0)},${p.z.toFixed(0)})</text>`;
      }).join('');
      return `${grid}<line x1="0" y1="${meanY.toFixed(1)}" x2="800" y2="${meanY.toFixed(1)}" stroke="#3d5a96" stroke-dasharray="3 3"/>
        <path d="${path}" fill="none" stroke="#ffeb3b" stroke-width="1.5"/>
        ${peakMarkers}
        <text x="6" y="14" fill="#7a8499" font-size="11">max ${maxDev.toFixed(1)}m</text>
        <text x="6" y="135" fill="#7a8499" font-size="11">0</text>
        <text x="780" y="14" fill="#7a8499" font-size="11" text-anchor="end">avg ${meanDev.toFixed(2)}m</text>
        <text x="6" y="${(meanY-3).toFixed(1)}" fill="#3d5a96" font-size="10">avg</text>`;
    })()}
  </svg>
  <div class="sub" style="margin-top:6px">
    Lap progress: 0% (start) → 100% (finish), left to right. Yellow line = lateral deviation in meters. Red dots = top-5 divergence peaks. Each peak is a corner where the ghost takes a meaningfully different line than you do.
  </div>
</div>
` : ''}

<!-- legacy live-state block (kept hidden for backward compat) -->
<div class="panel" style="display:none">
  <h2>Live state</h2>
  <table>
    <tr><th>connected</th><td class="r">${liveAvailable ? '<span class="ok">yes</span>' : '<span class="bad">no (no packet in 5s)</span>'}</td>
    <th>speed</th><td class="r">${state.packet ? state.packet.speedKph.toFixed(0)+' kph' : '—'}</td>
    <th>gear</th><td class="r">${state.packet ? (state.packet.currentGear === 0 ? 'R' : state.packet.currentGear === 15 ? 'N' : state.packet.currentGear) : '—'}</td>
    <th>XZ</th><td class="r">${state.packet ? `(${state.packet.position.x.toFixed(0)}, ${state.packet.position.z.toFixed(0)})` : '—'}</td></tr>
  </table>
</div>

<div class="sub">Source: ${path.basename(lapAnalyzer.todayFile())}</div>
</body></html>`;
}

async function renderMicroHtml(n) {
  let data;
  try { data = await lapAnalyzer.get(); }
  catch (e) { return `<!doctype html><html><head>${BASE_CSS}</head><body>${navLinks('micro')}<div class="panel">Error: ${e.message}</div></body></html>`; }
  const { laps, pbMs, microSectorsForLap, pbTrace, sectorBoundaries } = data;
  if (!laps || laps.length === 0 || !microSectorsForLap) {
    return `<!doctype html><html><head>${BASE_CSS}${NAV_HTML}</head><body>${navLinks('micro')}<div class="panel">No laps yet.</div></body></html>`;
  }

  const N = Math.max(3, Math.min(120, Number(n) || 30));

  // Compute micro-sectors per lap. The PB lap is the baseline.
  const pbLap = laps.find(l => l.isPb);
  const pbMicros = microSectorsForLap(pbLap._lap, N);

  const rowsData = laps.map(l => ({
    lap: l,
    micros: microSectorsForLap(l._lap, N),
  })).filter(r => r.micros);

  // Track-section labels (XZ midpoint of each micro-sector for tooltips)
  const sectionXZ = [];
  for (let k = 0; k < N; k++) {
    const idx = Math.floor(pbTrace.length * (k + 0.5) / N);
    sectionXZ.push(pbTrace[idx]);
  }

  // Sanity-tag each lap: μ-sum must match the actual lap total within 500ms.
  // Laps that drift (matcher sync-loss on off-track or replay-like jumps)
  // produce impossibly small μ-times — exclude them from the theoretical-best.
  for (const r of rowsData) {
    const sum = r.micros.reduce((a,b) => a + (b || 0), 0);
    r.muSumOk = Math.abs(sum - r.lap.completedMs) < 500;
    r.muSumDiff = sum - r.lap.completedMs;
  }
  const validRows = rowsData.filter(r => r.muSumOk);
  const droppedCount = rowsData.length - validRows.length;

  // Theoretical-best: min across VALID laps for each micro-sector.
  // Additional guard: reject any μ-time less than 25% of the PB's μ-time
  // (catches any residual sub-cell artifacts).
  const bestPerMicro = new Array(N).fill(Infinity);
  const bestLapForMicro = new Array(N).fill(null);
  for (const r of validRows) {
    for (let k = 0; k < N; k++) {
      const v = r.micros[k];
      if (v == null) continue;
      if (pbMicros[k] != null && v < pbMicros[k] * 0.25) continue; // too fast to be real
      if (v < bestPerMicro[k]) {
        bestPerMicro[k] = v;
        bestLapForMicro[k] = r.lap.order;
      }
    }
  }
  const microTheoreticalMs = bestPerMicro.reduce((a,b) => a + (isFinite(b) ? b : 0), 0);

  // Color scale: signed delta (ms). Caps at ±300ms for color saturation.
  function deltaColor(ms) {
    if (ms == null || !isFinite(ms)) return '#1a2238';
    const cap = 300;
    const v = Math.max(-cap, Math.min(cap, ms));
    if (v >= 0) {
      // 0..cap → black → deep red
      const t = v / cap;
      const r = Math.round(40 + t * 215);
      return `rgb(${r},${Math.round(40 - t*30)},${Math.round(50 - t*40)})`;
    } else {
      const t = -v / cap;
      const g = Math.round(40 + t * 200);
      return `rgb(${Math.round(40 - t*30)},${g},${Math.round(50 + t*40)})`;
    }
  }

  function tooltipFor(microIdx, micros) {
    const ms = micros[microIdx];
    if (ms == null) return 'no data';
    const pbMs = pbMicros[microIdx];
    const delta = pbMs != null ? ms - pbMs : null;
    const xz = sectionXZ[microIdx];
    return `μ${microIdx+1}: ${(ms/1000).toFixed(3)}s  Δ${delta != null ? ((delta>=0?'+':'')+(delta/1000).toFixed(3)+'s') : '—'}  XZ(${xz.x.toFixed(0)},${xz.z.toFixed(0)})`;
  }

  // Render rows — reverse order so most recent is at top
  const tableRows = rowsData.slice().reverse().map(r => {
    const cells = [];
    let bestCount = 0;
    for (let k = 0; k < N; k++) {
      const ms = r.micros[k];
      const pbMicro = pbMicros[k];
      const delta = (ms != null && pbMicro != null) ? ms - pbMicro : null;
      const isBest = bestLapForMicro[k] === r.lap.order;
      if (isBest) bestCount++;
      const color = deltaColor(delta);
      const border = isBest ? 'box-shadow:inset 0 0 0 2px #b388ff' : '';
      cells.push(`<td title="${tooltipFor(k, r.micros)}" style="background:${color};${border}"></td>`);
    }
    const dPb = r.lap.completedMs - pbMs;
    const lapLabel = r.lap.isPb ? `★ ${r.lap.order}` : r.lap.order;
    return `<tr>
      <td class="rowlbl">${lapLabel}</td>
      <td class="rowlbl">${fmtMsCol(r.lap.completedMs)}</td>
      <td class="rowlbl ${dPb===0?'':(dPb<0?'ok':'bad')}">${fmtDelta(dPb)}</td>
      <td class="rowlbl">${bestCount}</td>
      ${cells.join('')}
    </tr>`;
  }).join('\n');

  // PB row at top (all zeros)
  const pbRowCells = pbMicros.map((ms, k) => {
    return `<td title="${tooltipFor(k, pbMicros)}" style="background:#241935"></td>`;
  }).join('');

  // Theoretical-best row
  const tbRowCells = bestPerMicro.map((ms, k) => {
    const delta = pbMicros[k] != null ? ms - pbMicros[k] : null;
    return `<td title="μ${k+1}: ${(ms/1000).toFixed(3)}s (lap #${bestLapForMicro[k]})  Δ${delta!=null?((delta>=0?'+':'')+(delta/1000).toFixed(3)):'—'}" style="background:${deltaColor(delta)};box-shadow:inset 0 0 0 1px #b388ff"></td>`;
  }).join('');

  // Per-μ-sector summary — TWO views (matching /track):
  //  - avgLoss: avg delta vs PB (effect — where you're slowest)
  //  - avgOnset: rising-edge attribution (cause — only the START of each loss event)
  const microMeans = new Array(N).fill(0).map((_, k) => ({ idx: k, avgLoss: 0, lossCount: 0, avgOnset: 0, onsetEvents: 0 }));
  const GROW_THRESH_MS = 12, MIN_EVENT_DELTA = 25;
  for (const r of validRows) {
    const deltas = new Array(N).fill(null);
    for (let k = 0; k < N; k++) {
      const v = r.micros[k], pbv = pbMicros[k];
      if (v != null && pbv != null) deltas[k] = v - pbv;
    }
    for (let k = 0; k < N; k++) {
      if (deltas[k] != null) { microMeans[k].avgLoss += deltas[k]; microMeans[k].lossCount++; }
    }
    let edgeStartK = -1, edgeStartDelta = 0, prevDelta = 0;
    for (let k = 0; k < N; k++) {
      const d = deltas[k];
      if (d == null) {
        if (edgeStartK >= 0) {
          const mag = prevDelta - edgeStartDelta;
          if (mag >= MIN_EVENT_DELTA) { microMeans[edgeStartK].avgOnset += mag; microMeans[edgeStartK].onsetEvents++; }
          edgeStartK = -1;
        }
        prevDelta = 0;
        continue;
      }
      if (edgeStartK < 0) {
        if (d - prevDelta >= GROW_THRESH_MS) { edgeStartK = k; edgeStartDelta = prevDelta; }
      } else if (d <= prevDelta) {
        const mag = prevDelta - edgeStartDelta;
        if (mag >= MIN_EVENT_DELTA) { microMeans[edgeStartK].avgOnset += mag; microMeans[edgeStartK].onsetEvents++; }
        edgeStartK = -1;
      }
      prevDelta = d;
    }
    if (edgeStartK >= 0) {
      const mag = prevDelta - edgeStartDelta;
      if (mag >= MIN_EVENT_DELTA) { microMeans[edgeStartK].avgOnset += mag; microMeans[edgeStartK].onsetEvents++; }
    }
  }
  const totalLaps = validRows.length || 1;
  for (const m of microMeans) {
    if (m.lossCount > 0) m.avgLoss /= m.lossCount;
    m.avgOnset = m.avgOnset / totalLaps;  // average per lap, not per event
  }
  const worstMicros = microMeans.slice().sort((a,b) => b.avgOnset - a.avgOnset).slice(0, 10);

  return `<!doctype html><html><head><meta charset="utf-8">
<title>μ-sectors</title>
<meta http-equiv="refresh" content="60">
${BASE_CSS}${NAV_HTML}
<style>
  .heat{border-collapse:collapse;font-size:11px;font-variant-numeric:tabular-nums}
  .heat td{width:8px;height:14px;padding:0;border:1px solid #0a0e1a}
  .heat td.rowlbl{width:auto;background:transparent;padding:2px 8px;border:none;color:#e0e6f0;font-size:12px;text-align:right;white-space:nowrap}
  .heat tr:first-child td.rowlbl{color:#7a8499;font-size:11px}
  .heat thead td{height:auto;background:transparent;color:#7a8499;writing-mode:vertical-rl;transform:rotate(180deg);font-size:9px;padding:2px 0;border:none}
  .scale-bar{display:flex;height:14px;width:300px;margin-top:6px}
  .scale-bar div{flex:1}
  .resolution-picker a{margin-right:8px;padding:4px 10px;border:1px solid #1f2a44;border-radius:4px;color:#7a8499;text-decoration:none;font-size:12px}
  .resolution-picker a.active{color:#00d4ff;border-color:#00d4ff}
</style>
</head><body>
${navLinks('micro')}
<h1>Micro-sectors</h1>
<div class="sub">${N} slices of the PB trace · ${rowsData.length} laps (${validRows.length} valid for theoretical-best${droppedCount ? `, ${droppedCount} dropped for μ-matcher sync-loss` : ''}) · μ-theoretical-best <b>${fmtMsCol(microTheoreticalMs)}</b> (vs 3-sector theoretical ${fmtMsCol(data.theoreticalMs)})</div>

<div class="panel resolution-picker">
  Resolution:
  ${[3, 10, 30, 60, 100].map(k => `<a href="/micro?n=${k}"${k===N?' class="active"':''}>${k}</a>`).join('')}
  &nbsp; &nbsp; Each μ-sector ≈ ${(pbMs/N/1000).toFixed(3)}s on the PB lap
</div>

<div class="panel">
  <h2>Heatmap — green = faster than PB at this point, red = slower (capped at ±300ms)</h2>
  <table class="heat">
    <tr>
      <td class="rowlbl"><b>PB ★ #${pbLap.order}</b></td>
      <td class="rowlbl">${fmtMsCol(pbMs)}</td>
      <td class="rowlbl">—</td>
      <td class="rowlbl">—</td>
      ${pbRowCells}
    </tr>
    <tr>
      <td class="rowlbl"><b>theor.</b></td>
      <td class="rowlbl">${fmtMsCol(microTheoreticalMs)}</td>
      <td class="rowlbl ok">${fmtDelta(microTheoreticalMs - pbMs)}</td>
      <td class="rowlbl">${N}</td>
      ${tbRowCells}
    </tr>
    ${tableRows}
  </table>
  <div class="sub" style="margin-top:10px">
    Columns left→right = μ-sector 1..${N} (lap-elapsed order). Purple ring = best μ-sector achieved on that lap. Hover any cell for time + Δ + XZ.<br>
    Row legend: lap#, total, ΔPB, # of μ-bests held.
  </div>
</div>

<div class="panel">
  <h2>Worst μ-sectors — where time loss STARTS (drift onset, the cause)</h2>
  <p class="sub" style="margin:-6px 0 12px 0">Sorted by avg jump in delta vs previous μ-sector. This points at the input mistake (brake too late, lift early). The "avg loss" column shows where the time eventually shows up — usually a few μ-sectors downstream.</p>
  <table>
    <tr><th>μ-sector</th><th class="r">avg ONSET (cause)</th><th class="r">avg loss (effect)</th><th class="r">events/laps</th><th>track XZ</th><th class="r">PB time</th></tr>
    ${worstMicros.map(w => `<tr><td>μ${w.idx+1} of ${N}</td><td class="r bad">+${(w.avgOnset/1000).toFixed(3)}s</td><td class="r">${fmtDelta(w.avgLoss)}</td><td class="r">${w.onsetEvents}/${totalLaps}</td><td>(${sectionXZ[w.idx].x.toFixed(0)}, ${sectionXZ[w.idx].z.toFixed(0)})</td><td class="r">${fmtMsCol(pbMicros[w.idx])}</td></tr>`).join('')}
  </table>
</div>

<div class="sub">Source: ${path.basename(lapAnalyzer.todayFile())} · <a href="/micro.json?n=${N}">JSON</a></div>
</body></html>`;
}

function renderEventsHtml() {
  const file = path.join(__dirname, '..', '..', 'recordings', `events-${new Date().toISOString().slice(0,10)}.jsonl`);
  let lines = [];
  let err = null;
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      lines = raw.split('\n').filter(Boolean).slice(-200).reverse();
    }
  } catch (e) { err = e.message; }
  const events = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const rows = events.map(e => {
    const time = new Date(e.t).toLocaleTimeString('en-GB');
    let detail = '';
    if (e.type === 'lap_end') {
      const secs = (e.sectors || []).map(v => v == null ? '—' : (v/1000).toFixed(3)).join(' / ');
      detail = `lap #${e.lapNumber} · ${(e.totalMs/1000).toFixed(3)}s · S=${secs}`;
    } else if (e.type === 'pb_set') {
      detail = `<b>PB ${(e.totalMs/1000).toFixed(3)}s</b>`;
    } else if (e.type === 'session_start') {
      detail = `${e.car?.name || '—'} · ${e.track?.name || '—'} · ${e.sessionType}`;
    }
    return `<tr><td>${time}</td><td>${e.type}</td><td>${detail}</td></tr>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>events</title>
<meta http-equiv="refresh" content="10">
${BASE_CSS}${NAV_HTML}</head><body>
${navLinks('events')}
<h1>Events</h1>
<div class="sub">${events.length} events today · ${err ? `<span class="bad">${err}</span>` : path.basename(file)}</div>
<div class="panel">
  <table><tr><th>time</th><th>type</th><th>detail</th></tr>${rows || '<tr><td colspan="3" class="dim">no events yet — drive a lap to generate</td></tr>'}</table>
</div>
</body></html>`;
}

function renderOverviewHtml() {
  const drivers = driverStore.listDrivers();
  const active  = driverStore.getActive();
  const driverPickerHtml = drivers.map(d => {
    const isActive = d.id === active.id;
    return `<a href="/driver/switch?id=${encodeURIComponent(d.id)}" style="display:inline-block;margin-right:8px;padding:6px 14px;border:1px solid ${isActive?d.color:'#1f2a44'};border-radius:4px;color:${isActive?d.color:'#7a8499'};text-decoration:none;font-weight:${isActive?'600':'400'}">${d.label}${d.psn?` (${d.psn})`:''}</a>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>GT7 telemetry analyzer</title>
${BASE_CSS}${NAV_HTML}</head><body>
${navLinks('')}
<h1>GT7 Telemetry Analyzer</h1>
<div class="sub">Local interface · ${new Date().toLocaleString()} · driver: <b style="color:${active.color}">${active.label}</b></div>

${(() => {
  const c = cutoffStore.load();
  const ageH = cutoffStore.ageHours();
  if (!c) return '';
  const stale = ageH != null && ageH > 6;
  const pbMs  = state.packet?.bestLapTimeMs;
  const gapStr = pbMs ? `gap to cutoff: <b style="color:${pbMs <= c.ms ? '#00e676' : '#ffeb3b'}">${pbMs <= c.ms ? '−' : '+'}${Math.abs(pbMs - c.ms)} ms</b>` : '';
  return `<div class="panel" style="${stale ? 'border-color:#a04040' : ''}">
    <h2>Top-500 cutoff ${stale ? '<span style="color:#ff5252;font-weight:400">· STALE (' + ageH.toFixed(1) + 'h old, refresh recommended)</span>' : ''}</h2>
    <div style="font-size:24px;font-weight:300">${c.time} <span style="font-size:13px;color:#7a8499">(${c.ms} ms · ${c.driverName || '—'})</span></div>
    <div class="sub">${gapStr}${gapStr?' · ':''}captured ${ageH != null ? ageH.toFixed(1)+'h ago' : 'unknown'} · <a href="/cutoff">update</a></div>
  </div>`;
})()}

<div class="panel">
  <h2>Active driver</h2>
  <div style="margin:6px 0">${driverPickerHtml}</div>
  <p class="sub" style="margin:6px 0 8px 0">All new packets recorded are tagged with the active driver. Analysis pages (/laps, /micro, /track) only show that driver's laps. Click another driver to switch — the next packet captured is theirs. Add a new driver with: <code style="color:#00d4ff">node tools/driver.js add &lt;id&gt; --label "Name" --psn YOUR_PSN_ID --color "#ff9800"</code></p>
</div>
<div class="panel">
  <h2>Pages</h2>
  <ul>
    <li><a href="/laps">/laps</a> — every lap from today, sector splits, theoretical best, variation stats</li>
    <li><a href="/track">/track</a> — live SVG track map: PB lap, last lap, current car position, sector markers</li>
    <li><a href="/events">/events</a> — structured event log (session_start, lap_end, pb_set)</li>
    <li><a href="/metrics">/metrics</a> — Prometheus exposition (for Grafana)</li>
    <li><a href="/laps.json">/laps.json</a> — raw JSON for scripting</li>
  </ul>
</div>
<div class="panel">
  <h2>Live status</h2>
  <table>
    <tr><th>GT7 connected</th><td class="r">${state.packet && (Date.now() - state.lastUpdateMs < 5000) ? '<span class="ok">yes</span>' : '<span class="bad">no</span>'}</td></tr>
    <tr><th>Packets received</th><td class="r">${state.packetsReceived.toLocaleString()}</td></tr>
    <tr><th>Car</th><td class="r">${state.meta.car?.name || '—'}</td></tr>
    <tr><th>Track</th><td class="r">${state.meta.track?.name || '—'}</td></tr>
    <tr><th>Best lap</th><td class="r">${state.packet?.bestLapTimeMs ? (state.packet.bestLapTimeMs/1000).toFixed(3)+'s' : '—'}</td></tr>
  </table>
</div>
</body></html>`;
}

function start(port, host = '0.0.0.0') {
  startGtshPoller();
  server = http.createServer(async (req, res) => {
    try {
    if (req.url === '/metrics') {
      const body = render();
      res.writeHead(200, {
        'Content-Type':   'text/plain; version=0.0.4; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
    } else if (req.url === '/' || req.url === '/index.html') {
      const body = renderOverviewHtml();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    } else if (req.url === '/laps' || req.url.startsWith('/laps?')) {
      const force = /[?&]force=1/.test(req.url);
      if (force) await lapAnalyzer.get({ force: true });
      const body = await renderLapsHtml();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    } else if (req.url === '/laps.json' || req.url.startsWith('/laps.json?')) {
      const force = /[?&]force=1/.test(req.url);
      const d = await lapAnalyzer.get({ force });
      const safe = {
        mainCar: d.mainCar,
        pbMs: d.pbMs,
        pbOrder: d.pbOrder,
        theoreticalMs: d.theoreticalMs,
        bestSectors: d.bestSectors,
        laps: (d.laps || []).map(l => ({
          order: l.order, lapNum: l.lapNum, startT: l.startT,
          completedMs: l.completedMs, s1: l.s1, s2: l.s2, s3: l.s3, isPb: l.isPb,
        })),
      };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(safe, null, 2));
    } else if (req.url === '/micro' || req.url.startsWith('/micro?')) {
      const m = req.url.match(/[?&]n=(\d+)/);
      const body = await renderMicroHtml(m ? Number(m[1]) : 30);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    } else if (req.url === '/micro.json' || req.url.startsWith('/micro.json?')) {
      const m = req.url.match(/[?&]n=(\d+)/);
      const N = m ? Math.max(3, Math.min(120, Number(m[1]))) : 30;
      const d = await lapAnalyzer.get();
      const out = (d.laps || []).map(l => ({
        order: l.order, lapNum: l.lapNum, completedMs: l.completedMs, isPb: l.isPb,
        micros: d.microSectorsForLap ? d.microSectorsForLap(l._lap, N) : null,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ n: N, pbMs: d.pbMs, laps: out }, null, 2));
    } else if (req.url === '/track' || req.url.startsWith('/track?')) {
      const body = await renderTrackHtml(req.url);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    } else if (req.url === '/cutoff' || req.url.startsWith('/cutoff?')) {
      // GET /cutoff           — show current cutoff status (HTML)
      // POST /cutoff?ms=78586&time=1:18.586&driver=foo&rank=500
      // GET  /cutoff?ms=78586 — also accepted as a quick-update GET
      const setMatch = req.url.match(/[?&]ms=(\d+)/) || req.url.match(/[?&]time=([^&]+)/);
      if (req.method === 'POST' || setMatch) {
        const params = new URLSearchParams(req.url.split('?')[1] || '');
        const msArg = params.get('ms');
        const timeArg = params.get('time');
        const ms = msArg ? Number(msArg) : cutoffStore.parseTimeToMs(timeArg);
        if (!ms || ms < 30000 || ms > 600000) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('bad time. use ?ms=78586 or ?time=1:18.586\n');
        } else {
          const rec = cutoffStore.save({
            time: timeArg || (ms/1000).toFixed(3),
            ms,
            source: params.get('source') || 'manual',
            driverName: params.get('driver') || null,
            rank: params.get('rank') ? Number(params.get('rank')) : 500,
            combo: params.get('combo') || 'Daily B',
            capturedAt: new Date().toISOString(),
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(rec, null, 2));
        }
      } else {
        const c = cutoffStore.load();
        const ageH = cutoffStore.ageHours();
        const body = `<!doctype html><html><head><meta charset="utf-8"><title>cutoff</title>${BASE_CSS}${NAV_HTML}</head><body>
${navLinks('')}
<h1>Top-500 cutoff</h1>
${c ? `
<div class="panel">
  <div style="font-size:36px;font-weight:300;color:#ffeb3b">${c.time}<span style="font-size:14px;color:#7a8499;margin-left:12px">${c.ms} ms</span></div>
  <div class="sub">${c.driverName || 'unknown'} · rank #${c.rank} · ${c.combo} · captured ${ageH != null ? ageH.toFixed(1)+'h ago' : 'unknown'} (source: ${c.source})</div>
</div>
` : `<div class="panel">No cutoff recorded.</div>`}
<div class="panel">
  <h2>Update cutoff</h2>
  <p class="sub" style="margin:0 0 8px 0">Easiest: hit <code>http://localhost:9477/cutoff?ms=78400&driver=NewLeader500</code> from any browser tab. Or use the form below.</p>
  <form method="POST" action="/cutoff" style="display:flex;gap:6px;flex-wrap:wrap">
    <input name="time" placeholder="1:18.400" style="background:#0a0e1a;color:#fff;border:1px solid #1f2a44;border-radius:4px;padding:6px 8px">
    <input name="driver" placeholder="driver name" style="background:#0a0e1a;color:#fff;border:1px solid #1f2a44;border-radius:4px;padding:6px 8px">
    <input name="rank" placeholder="500" value="500" style="width:60px;background:#0a0e1a;color:#fff;border:1px solid #1f2a44;border-radius:4px;padding:6px 8px">
    <button style="background:#00d4ff;color:#0a0e1a;border:none;border-radius:4px;padding:6px 14px;cursor:pointer;font-weight:600">Update</button>
  </form>
</div>
</body></html>`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(body);
      }
    } else if (req.url.startsWith('/driver/switch?')) {
      const m = req.url.match(/[?&]id=([^&]+)/);
      const id = m ? decodeURIComponent(m[1]) : null;
      try {
        if (!id) throw new Error('missing id');
        driverStore.setActive(id);
        // Bounce back to overview
        res.writeHead(302, { Location: '/' });
        res.end();
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('driver switch failed: ' + e.message);
      }
    } else if (req.url === '/drivers.json') {
      const body = JSON.stringify({
        drivers: driverStore.listDrivers(),
        active: driverStore.getActive(),
      }, null, 2);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    } else if (req.url === '/position.json') {
      // High-frequency endpoint used by the live track-page audio coach.
      // Returns just the position + speed + a sample-id so the client can
      // compute heading from successive samples.
      const p = state.packet;
      const ageMs = Date.now() - state.lastUpdateMs;
      const body = JSON.stringify(p ? {
        ok: true,
        ageMs,
        sampleId: p.packetId || 0,
        x: p.position.x, y: p.position.y, z: p.position.z,
        speedKph: p.speedKph,
        lapCount: p.lapCount,
        gear: p.currentGear,
        throttle: p.throttle, brake: p.brake,
      } : { ok: false, ageMs });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    } else if (req.url === '/events' || req.url.startsWith('/events?')) {
      const body = renderEventsHtml();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    } else if (req.url === '/gtsh' || req.url.startsWith('/gtsh?')) {
      // Public build: GTSH-Rank scraper is intentionally omitted.
      const body = renderGtshHtml();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    } else if (req.url === '/config') {
      handleConfig(req, res);
    } else if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok\n');
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found\n');
    }
    } catch (e) {
      process.stderr.write(`[http] handler error on ${req.url}: ${e.stack}\n`);
      try {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('internal error: ' + e.message + '\n');
      } catch {}
    }
  });
  server.listen(port, host, () => {
    process.stdout.write(`[metrics] listening on http://${host}:${port}/metrics\n`);
    process.stdout.write(`[ui]      overview at http://localhost:${port}/\n`);
    process.stdout.write(`[ui]      laps     /laps  · track /track  · events /events  · cutoff /cutoff\n`);
  });
  server.on('error', (err) => {
    process.stderr.write(`[metrics] server error: ${err.message}\n`);
  });
}

function stop() {
  stopGtshPoller();
  if (server) {
    server.close();
    server = null;
  }
}

module.exports = { update, start, stop, render };

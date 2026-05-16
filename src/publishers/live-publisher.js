// Grafana Live HTTP push publisher.
//
// Posts each parsed GT7 packet to /api/live/push/<channel> in InfluxDB line
// protocol so a streaming time-series panel subscribed to that channel renders
// at packet rate (~60Hz) over a WebSocket — bypassing Grafana's 5-second
// auto-refresh floor.
//
// Auth: looks for a Bearer token in data/grafana-token.json (auto-provisioned
// at startup by tools/grafana-token.js). Falls back to basic auth admin/admin
// (Grafana default; only useful on a fresh install).
//
// Channels published:
//   gt7/hud    — fast inputs: speed, rpm, gear, throttle, brake, fuel%, etc
//   gt7/lap    — lap counters & times
//   gt7/tires  — fl/fr/rl/rr surface temps
//   gt7/engine — water, oil, boost, oil pressure
//   gt7/pos    — world x, y, z

const http = require('node:http');
const fs   = require('node:fs');
const path = require('node:path');

const GRAFANA_HOST = process.env.GRAFANA_HOST || 'localhost';
const GRAFANA_PORT = Number(process.env.GRAFANA_PORT || 3000);
const TOKEN_FILE   = path.resolve(__dirname, '..', '..', 'data', 'grafana-token.json');

let bearer = null;
let basicAuth = 'Basic ' + Buffer.from('admin:admin').toString('base64');
try {
  if (fs.existsSync(TOKEN_FILE)) {
    bearer = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')).token;
  }
} catch {}

// Persistent keep-alive agent — 60 POSTs/sec to localhost stays cheap.
const agent = new http.Agent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 4 });

let pushedCount = 0;
let errorCount  = 0;
let lastErrorAt = 0;
let lastErrorMsg = null;
let consecFails = 0;
let suspendedUntil = 0;

function authHeader() {
  return bearer ? `Bearer ${bearer}` : basicAuth;
}

// Escape a value for InfluxDB line protocol.
function lpField(v) {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    if (Number.isInteger(v)) return v + 'i';
    return v.toString();
  }
  if (typeof v === 'string') return '"' + v.replace(/"/g, '\\"') + '"';
  if (typeof v === 'boolean') return v ? 'T' : 'F';
  return null;
}

function buildLine(measurement, fields) {
  const parts = [];
  for (const k of Object.keys(fields)) {
    const v = lpField(fields[k]);
    if (v === null) continue;
    parts.push(`${k}=${v}`);
  }
  if (!parts.length) return null;
  // Grafana Live wants ms-precision timestamps in nanoseconds.
  const ts = Date.now() * 1_000_000;
  return `${measurement} ${parts.join(',')} ${ts}`;
}

function pushChannel(channelPath, line) {
  if (!line) return;
  if (Date.now() < suspendedUntil) return; // back-off after repeated failures
  const req = http.request({
    method: 'POST',
    host: GRAFANA_HOST,
    port: GRAFANA_PORT,
    path: `/api/live/push/${channelPath}`,
    agent,
    headers: {
      'Authorization': authHeader(),
      'Content-Type':  'application/x-www-form-urlencoded; charset=utf-8',
      'Content-Length': Buffer.byteLength(line),
    },
  }, (res) => {
    res.resume();
    if (res.statusCode >= 200 && res.statusCode < 300) {
      pushedCount++;
      consecFails = 0;
    } else {
      errorCount++;
      consecFails++;
      lastErrorAt = Date.now();
      lastErrorMsg = `HTTP ${res.statusCode}`;
      if (consecFails > 60) {
        // Auth or config wrong — back off 30s to avoid spamming the log
        suspendedUntil = Date.now() + 30_000;
      }
    }
  });
  req.on('error', (e) => {
    errorCount++;
    consecFails++;
    lastErrorAt = Date.now();
    lastErrorMsg = e.message;
    if (consecFails > 60) suspendedUntil = Date.now() + 30_000;
  });
  req.write(line);
  req.end();
}

function publishPacket(parsed) {
  if (!parsed) return;
  const gear = parsed.currentGear === 0 ? -1 : (parsed.currentGear === 15 ? 0 : parsed.currentGear);
  // Fast HUD channel — everything that should refresh at packet rate
  pushChannel('gt7/hud', buildLine('hud', {
    speed_kph:   round(parsed.speedKph, 2),
    rpm:         Math.round(parsed.engineRpm),
    rpm_redline: parsed.maxRpmAlert,
    gear,
    throttle_pct: round((parsed.throttle || 0) / 2.55, 1),
    brake_pct:    round((parsed.brake    || 0) / 2.55, 1),
    clutch_pct:   round((parsed.clutchPedal || 0) * 100, 1),
    fuel_l:       round(parsed.fuelLevel, 2),
    fuel_pct:     parsed.fuelCapacity > 0 ? round(100 * parsed.fuelLevel / parsed.fuelCapacity, 1) : null,
    boost_bar:    round(parsed.boostBar, 3),
    rev_limiter:  parsed.flags.revLimiterAlert ? 1 : 0,
    asm:          parsed.flags.asmActive ? 1 : 0,
    tcs:          parsed.flags.tcsActive ? 1 : 0,
  }));
  pushChannel('gt7/lap', buildLine('lap', {
    lap_count:    parsed.lapCount,
    laps_in_race: parsed.lapsInRace,
    race_pos:     parsed.racePosition,
    last_lap_ms:  parsed.lastLapTimeMs > 0 ? parsed.lastLapTimeMs : null,
    best_lap_ms:  parsed.bestLapTimeMs > 0 ? parsed.bestLapTimeMs : null,
  }));
  pushChannel('gt7/tires', buildLine('tires', {
    fl_c: round(parsed.tireTempC.fl, 1),
    fr_c: round(parsed.tireTempC.fr, 1),
    rl_c: round(parsed.tireTempC.rl, 1),
    rr_c: round(parsed.tireTempC.rr, 1),
  }));
  pushChannel('gt7/engine', buildLine('engine', {
    water_c:      round(parsed.waterTempC, 1),
    oil_c:        round(parsed.oilTempC, 1),
    oil_bar:      round(parsed.oilPressure, 2),
    boost_bar:    round(parsed.boostBar, 3),
  }));
  pushChannel('gt7/pos', buildLine('pos', {
    x: round(parsed.position.x, 2),
    y: round(parsed.position.y, 2),
    z: round(parsed.position.z, 2),
  }));
}

function round(n, d) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const m = Math.pow(10, d);
  return Math.round(n * m) / m;
}

function stats() {
  return {
    pushedCount, errorCount, consecFails, lastErrorMsg,
    lastErrorAgeS: lastErrorAt ? (Date.now() - lastErrorAt) / 1000 : null,
    suspendedFor: Math.max(0, suspendedUntil - Date.now()),
    bearerSet: !!bearer,
  };
}

function setBearer(token) {
  bearer = token;
  consecFails = 0;
  suspendedUntil = 0;
}

module.exports = { publishPacket, stats, setBearer };

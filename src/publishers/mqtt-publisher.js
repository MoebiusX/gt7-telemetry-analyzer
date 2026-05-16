// Minimal MQTT 3.1.1 publisher.
//
// Connects to the broker at MQTT_URL (default mqtt://localhost:1883) ONLY if
// MQTT_URL is set in the env or the broker is reachable. Silently noops
// otherwise so the project stays useful without an MQTT broker installed.
//
// Implements only the wire-level pieces we need: CONNECT (clean session, no
// auth) and PUBLISH (QoS 0). No npm dependency — keeps package.json clean.
//
// Topics published per packet:
//   gt7/hud/<field>     — speed, rpm, gear, throttle, brake, etc
//   gt7/lap/<field>     — lap counters & times
//   gt7/tires/<wheel>   — fl/fr/rl/rr surface temp
//   gt7/engine/<field>  — water, oil, boost, oil pressure
//   gt7/pos/<axis>      — x, y, z

const net = require('node:net');
const url = require('node:url');

const URL_STR = process.env.MQTT_URL || '';
const ENABLED = !!URL_STR;

let sock = null;
let connected = false;
let publishedCount = 0;
let errorCount = 0;
let lastError = null;
let reconnectTimer = null;

function parseUrl() {
  try {
    const u = new url.URL(URL_STR);
    return { host: u.hostname, port: Number(u.port || 1883) };
  } catch { return null; }
}

function connect() {
  if (!ENABLED) return;
  const cfg = parseUrl();
  if (!cfg) { lastError = 'bad MQTT_URL'; return; }
  sock = net.createConnection({ host: cfg.host, port: cfg.port });
  sock.setNoDelay(true);
  sock.on('connect', () => {
    sendConnect();
  });
  sock.on('data', (buf) => {
    // Expect CONNACK (type 0x20). We don't strictly validate.
    if (buf.length >= 4 && (buf[0] >> 4) === 0x2 && buf[3] === 0) {
      connected = true;
    }
  });
  sock.on('error', (e) => {
    lastError = e.message;
    errorCount++;
    teardown();
    scheduleReconnect();
  });
  sock.on('close', () => {
    connected = false;
    sock = null;
    scheduleReconnect();
  });
}

function teardown() {
  if (sock) {
    try { sock.destroy(); } catch {}
    sock = null;
  }
  connected = false;
}

function scheduleReconnect() {
  if (!ENABLED) return;
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 5000);
}

// MQTT 3.1.1 CONNECT for clean session, no auth, client id "gt7-exporter-<rnd>"
function sendConnect() {
  const clientId = 'gt7-exporter-' + Math.random().toString(36).slice(2, 10);
  const proto = Buffer.from([0x00, 0x04, 0x4D, 0x51, 0x54, 0x54]); // "MQTT"
  const protoLevel = Buffer.from([0x04]); // 3.1.1
  const flags = Buffer.from([0x02]); // clean session
  const keepAlive = Buffer.from([0x00, 0x3C]); // 60s
  const cidBuf = Buffer.from(clientId, 'utf8');
  const cidLen = Buffer.from([(cidBuf.length >> 8) & 0xff, cidBuf.length & 0xff]);
  const variable = Buffer.concat([proto, protoLevel, flags, keepAlive]);
  const payload = Buffer.concat([cidLen, cidBuf]);
  const remaining = encodeRemainingLength(variable.length + payload.length);
  const fixed = Buffer.concat([Buffer.from([0x10]), remaining]); // CONNECT
  sock.write(Buffer.concat([fixed, variable, payload]));
}

function encodeRemainingLength(n) {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Buffer.from(out);
}

// PUBLISH QoS 0
function publishRaw(topic, payload) {
  if (!connected || !sock) return false;
  const tBuf = Buffer.from(topic, 'utf8');
  const tLen = Buffer.from([(tBuf.length >> 8) & 0xff, tBuf.length & 0xff]);
  const pBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const variable = Buffer.concat([tLen, tBuf]);
  const remaining = encodeRemainingLength(variable.length + pBuf.length);
  const fixed = Buffer.concat([Buffer.from([0x30]), remaining]); // PUBLISH QoS 0
  try {
    sock.write(Buffer.concat([fixed, variable, pBuf]));
    publishedCount++;
    return true;
  } catch (e) {
    lastError = e.message;
    errorCount++;
    return false;
  }
}

function publishPacket(parsed) {
  if (!ENABLED || !connected || !parsed) return;
  const gear = parsed.currentGear === 0 ? -1 : (parsed.currentGear === 15 ? 0 : parsed.currentGear);
  const ts = Date.now();
  const sample = (vals) => JSON.stringify({ ts, ...vals });
  publishRaw('gt7/hud',    sample({
    speed_kph: parsed.speedKph, rpm: parsed.engineRpm,
    gear, throttle_pct: (parsed.throttle||0)/2.55, brake_pct: (parsed.brake||0)/2.55,
    rpm_redline: parsed.maxRpmAlert, fuel_l: parsed.fuelLevel,
  }));
  publishRaw('gt7/lap', sample({
    lap_count: parsed.lapCount, race_pos: parsed.racePosition,
    last_lap_ms: parsed.lastLapTimeMs, best_lap_ms: parsed.bestLapTimeMs,
  }));
  publishRaw('gt7/tires', sample(parsed.tireTempC));
  publishRaw('gt7/engine', sample({
    water_c: parsed.waterTempC, oil_c: parsed.oilTempC,
    oil_bar: parsed.oilPressure, boost_bar: parsed.boostBar,
  }));
  publishRaw('gt7/pos', sample(parsed.position));
}

function stats() {
  return { enabled: ENABLED, connected, publishedCount, errorCount, lastError };
}

if (ENABLED) connect();

module.exports = { publishPacket, stats };

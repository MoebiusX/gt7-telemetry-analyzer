#!/usr/bin/env node
// GT7 telemetry capture for PlayStation 5.
//
// Sends a heartbeat byte to the PS5 on UDP/33739, listens on UDP/33740,
// decrypts each packet with Salsa20, parses it, prints a live HUD,
// and records every packet to a JSONL log under ./recordings/.
//
//   node index.js --ps5 <YOUR_PS5_IP>    # set your PS5's LAN IP (required)
//   node index.js --no-record           # disable disk recording
//   node index.js --quiet               # disable HUD (still records)
//
// Or set env var: GT7_PS5_HOST=<YOUR_PS5_IP> node index.js

const dgram = require('node:dgram');
const fs    = require('node:fs');
const path  = require('node:path');
const { decrypt } = require('./src/capture/salsa20');
const { parse, formatLapTime } = require('./src/capture/parser');
const metrics  = require('./src/server/metrics');
const config   = require('./src/config');
const metadata = require('./src/capture/metadata');
const { LapPredictor } = require('./src/analysis/lap-predictor');
const { EventLogger }  = require('./src/analysis/event-logger');
const driverStore      = require('./src/analysis/driver-store');
const livePublisher    = require('./src/publishers/live-publisher');
const mqttPublisher    = require('./src/publishers/mqtt-publisher');
const sseBroker        = require('./src/publishers/sse-broker');

const predictor = new LapPredictor();
let events = null; // initialized after RECORD_DIR is established
let activeDriverId = driverStore.getActive().id;

// ---------- config ----------

const argv = process.argv.slice(2);
function arg(flag, fallback) {
  const i = argv.indexOf(flag);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  return (!v || v.startsWith('--')) ? true : v;
}

const PS5_HOST       = arg('--ps5', process.env.GT7_PS5_HOST || '');
if (!PS5_HOST) {
  process.stderr.write('error: PS5 host required. Pass --ps5 <YOUR_PS5_IP> or set GT7_PS5_HOST.\n');
  process.exit(1);
}
const HEARTBEAT_PORT = Number(arg('--hb-port', 33739));
const RECEIVE_PORT   = Number(arg('--rx-port', 33740));
const RECORD         = !argv.includes('--no-record');
const QUIET          = argv.includes('--quiet');
const METRICS_OFF    = argv.includes('--no-metrics');
const METRICS_PORT   = Number(arg('--metrics-port', 9477));
const RECORD_DIR     = path.resolve(__dirname, 'recordings');

// Salsa20 key/nonce derivation — community-discovered constants.
const KEY = Buffer.from('Simulator Interface Packet GT7 ver 0.0', 'ascii').subarray(0, 32);
const IV_MAGIC = 0xDEADBEAF;

// ---------- state ----------

let receivedCount   = 0;
let lastPacketId    = -1;
let droppedCount    = 0;
let firstPacketAt   = 0;
let lastPrintAt     = 0;
let recordStream    = null;
let recordPath      = null;
let started         = Date.now();

// ---------- session metadata ----------
let currentCarCode     = null;
let currentSessionType = null;
let trackMatch         = null;
let fingerprinter      = new metadata.Fingerprinter();
let lastFpCheckAt      = 0;

function resetSessionMeta() {
  currentCarCode     = null;
  currentSessionType = null;
  trackMatch         = null;
  fingerprinter      = new metadata.Fingerprinter();
  lastFpCheckAt      = 0;
  predictor.reset();
}

function metaPath() {
  return recordPath ? recordPath.replace(/\.jsonl$/, '.meta.json') : null;
}

function writeMetaSidecar() {
  const mp = metaPath();
  if (!mp) return;
  const carMeta = metadata.lookupCar(currentCarCode);
  const obj = {
    recording:   recordPath ? path.basename(recordPath) : null,
    updatedAt:   new Date().toISOString(),
    car: currentCarCode ? {
      carCode: currentCarCode,
      name:    carMeta?.name  || null,
      class:   carMeta?.class || null,
    } : null,
    track: trackMatch ? {
      id:           trackMatch.id,
      name:         trackMatch.name,
      lapDistanceM: trackMatch.lapDistanceM,
    } : null,
    sessionType: currentSessionType || 'unknown',
  };
  try { fs.writeFileSync(mp, JSON.stringify(obj, null, 2) + '\n'); }
  catch (e) { process.stderr.write(`[meta] sidecar write failed: ${e.message}\n`); }
}

function updateSessionMeta(parsed) {
  if (parsed.carCode && parsed.carCode !== currentCarCode) {
    const wasCar = currentCarCode;
    currentCarCode = parsed.carCode;
    const carMeta  = metadata.lookupCar(parsed.carCode);
    if (carMeta) {
      process.stdout.write(`[meta] car: ${carMeta.name} (${carMeta.class}) [code=${parsed.carCode}]\n`);
    } else {
      process.stdout.write(`[meta] car: UNKNOWN carCode=${parsed.carCode}  (add to data/cars.json)\n`);
    }
    if (wasCar !== null) predictor.reset();
    writeMetaSidecar();
  }

  const newSessionType = metadata.detectSessionType(parsed);
  if (newSessionType !== currentSessionType && newSessionType !== 'unknown') {
    currentSessionType = newSessionType;
    process.stdout.write(`[meta] session: ${newSessionType}\n`);
    writeMetaSidecar();
  }

  fingerprinter.accumulate(parsed);
  const now = Date.now();
  if (!trackMatch && fingerprinter.ready() && now - lastFpCheckAt > 30_000) {
    lastFpCheckAt = now;
    const fp    = fingerprinter.fingerprint();
    const match = metadata.matchTrack(fp);
    if (match) {
      trackMatch = match;
      process.stdout.write(`[meta] track: ${match.name} [id=${match.id}]\n`);
    } else {
      const reg = metadata.registerUnknownTrack(fp);
      trackMatch = reg;
      process.stdout.write(`[meta] track: UNKNOWN — registered as ${reg.id} in data/tracks.json (rename it!)\n`);
    }
    writeMetaSidecar();
  }
}

// ---------- recording ----------
// One file per local calendar day: gt7-YYYY-MM-DD.jsonl. Append on restart,
// rotate at local midnight so a single day's driving lives in one file.

function todayLocal() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

let recordingSuspended = false;
let recordingErrors    = 0;
let recordingLastErrAt = 0;

function attachRecordingErrorHandler(stream, srcPath) {
  // Without this, a write error (ENOSPC, EIO, etc.) emits 'error' on the stream
  // and Node treats it as fatal — taking the whole exporter down. We catch it,
  // suspend recording, and keep the UDP + metrics + SSE paths alive so the
  // dashboards stay usable while the user frees space.
  stream.on('error', (err) => {
    recordingErrors++;
    recordingLastErrAt = Date.now();
    if (!recordingSuspended) {
      recordingSuspended = true;
      process.stderr.write(`\n[rec] WRITE ERROR (${err.code || err.message}) on ${srcPath} — suspending recording. Exporter will keep running for live HUD; restart after freeing disk space.\n`);
    }
    try { stream.destroy(); } catch {}
  });
}

function openRecording() {
  if (!RECORD) return;
  try {
    fs.mkdirSync(RECORD_DIR, { recursive: true });
    recordPath = path.join(RECORD_DIR, `gt7-${todayLocal()}.jsonl`);
    recordStream = fs.createWriteStream(recordPath, { flags: 'a' });
    attachRecordingErrorHandler(recordStream, recordPath);
    recordingSuspended = false;
    process.stdout.write(`[rec] writing to ${recordPath}\n`);
    scheduleRotation();
  } catch (e) {
    recordingSuspended = true;
    process.stderr.write(`[rec] could not open recording: ${e.message}. Live HUD will run; recording disabled.\n`);
  }
}

function scheduleRotation() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 100);
  setTimeout(rotateRecording, next.getTime() - now.getTime());
}

function rotateRecording() {
  const oldPath = recordPath;
  const oldStream = recordStream;
  recordPath = path.join(RECORD_DIR, `gt7-${todayLocal()}.jsonl`);
  recordStream = fs.createWriteStream(recordPath, { flags: 'a' });
  attachRecordingErrorHandler(recordStream, recordPath);
  recordingSuspended = false;
  process.stdout.write(`[rec] rotated -> ${recordPath}\n`);
  if (oldStream) oldStream.end(() => process.stdout.write(`[rec] closed ${oldPath}\n`));
  resetSessionMeta();
  scheduleRotation();
}

let lastWrittenCfgV = -1;

function recordPacket(parsed) {
  if (!recordStream || recordingSuspended) return;
  const cfg = config.get();
  // Refresh active-driver every ~5s in case the user switched via the UI.
  if (Date.now() - (recordPacket.lastDriverCheckAt || 0) > 5000) {
    activeDriverId = driverStore.getActive().id;
    recordPacket.lastDriverCheckAt = Date.now();
  }
  // Write a "config marker" line whenever the rig config changes, so the JSONL
  // stays compact (we don't repeat the full rig object on every 60Hz packet).
  if (cfg.version !== lastWrittenCfgV) {
    recordStream.write(JSON.stringify({
      type: 'config',
      t: Date.now(),
      cfgV: cfg.version,
      driver: activeDriverId,
      rig: cfg.config,
      updatedAt: cfg.updatedAt,
    }) + '\n');
    lastWrittenCfgV = cfg.version;
  }
  recordStream.write(JSON.stringify({ t: Date.now(), cfgV: cfg.version, driver: activeDriverId, ...parsed }) + '\n');
}

// ---------- network ----------

const sock = dgram.createSocket('udp4');

function sendHeartbeat() {
  const buf = Buffer.from('A');
  sock.send(buf, 0, buf.length, HEARTBEAT_PORT, PS5_HOST, (err) => {
    if (err && !QUIET) process.stderr.write(`[hb] send error: ${err.message}\n`);
  });
}

function decryptPacket(encrypted) {
  if (encrypted.length < 0x44) return null;
  const iv1 = encrypted.readUInt32LE(0x40);
  const iv2 = (iv1 ^ IV_MAGIC) >>> 0;
  const nonce = Buffer.alloc(8);
  nonce.writeUInt32LE(iv2, 0);
  nonce.writeUInt32LE(iv1, 4);
  return decrypt(KEY, nonce, encrypted);
}

sock.on('error', (err) => {
  process.stderr.write(`[udp] error: ${err.message}\n`);
  sock.close();
  process.exit(1);
});

sock.on('listening', () => {
  const addr = sock.address();
  process.stdout.write(`[udp] listening on ${addr.address}:${addr.port}\n`);
  process.stdout.write(`[udp] heartbeat -> ${PS5_HOST}:${HEARTBEAT_PORT} every 1.5s\n\n`);
  sendHeartbeat();
  setInterval(sendHeartbeat, 1500);
});

sock.on('message', (msg) => {
  const decrypted = decryptPacket(msg);
  if (!decrypted) return;
  const parsed = parse(decrypted);
  if (!parsed) return;

  receivedCount++;
  if (firstPacketAt === 0) firstPacketAt = Date.now();
  if (lastPacketId !== -1 && parsed.packetId > lastPacketId + 1) {
    droppedCount += parsed.packetId - lastPacketId - 1;
  }
  lastPacketId = parsed.packetId;

  updateSessionMeta(parsed);
  recordPacket(parsed);
  const prediction = predictor.update(parsed);
  const meta = { car: metadata.lookupCar(currentCarCode), track: trackMatch, sessionType: currentSessionType };
  metrics.update(parsed, receivedCount, droppedCount, meta, prediction);

  if (events) {
    events.sessionUpdate(meta);
    if (prediction.lapJustEnded && prediction.completedLapMs) {
      events.lapEnd({
        lapNumber: parsed.lapCount, // GT7 has already incremented to next lap by this packet
        totalMs: prediction.completedLapMs,
        sectors: prediction.completedSectorMs,
        car: meta.car ? meta.car.carCode : null,
        track: meta.track ? meta.track.id : null,
        bestSectorMs: prediction.bestSectorMs,
        theoreticalBestMs: prediction.theoreticalBestMs,
      });
    }
  }

  // Fire-and-forget streaming pushes. Errors are swallowed inside the
  // publishers so a slow downstream doesn't stall the UDP loop.
  livePublisher.publishPacket(parsed);
  mqttPublisher.publishPacket(parsed);

  // 60Hz SSE broadcast for /hud60 — only does work if browsers are subscribed.
  if (sseBroker.subscriberCount('hud60') > 0) {
    sseBroker.broadcast('hud60', {
      t:    Date.now(),
      sp:   parsed.speedKph,
      rpm:  parsed.engineRpm,
      maxRpm: parsed.maxRpmAlert,
      gear: parsed.currentGear,
      sgear: parsed.suggestedGear,
      thr:  parsed.throttle,
      brk:  parsed.brake,
      fuel: parsed.fuelLevel,
      fuelCap: parsed.fuelCapacity,
      lap:  parsed.lapCount,
      laps: parsed.lapsInRace,
      pos:  parsed.racePosition,
      lastMs: parsed.lastLapTimeMs,
      bestMs: parsed.bestLapTimeMs,
      water: parsed.waterTempC,
      oil:   parsed.oilTempC,
      oilP:  parsed.oilPressure,
      boost: parsed.boostBar,
      tFL: parsed.tireTempC.fl, tFR: parsed.tireTempC.fr,
      tRL: parsed.tireTempC.rl, tRR: parsed.tireTempC.rr,
      x: parsed.position.x, y: parsed.position.y, z: parsed.position.z,
      flags: {
        rev:  parsed.flags.revLimiterAlert ? 1 : 0,
        asm:  parsed.flags.asmActive ? 1 : 0,
        tcs:  parsed.flags.tcsActive ? 1 : 0,
        race: parsed.flags.inRace ? 1 : 0,
        paus: parsed.flags.paused ? 1 : 0,
      },
    });
  }

  // GT7 sends ~60 packets/sec — re-arm heartbeat every 100 packets.
  if (receivedCount % 100 === 0) sendHeartbeat();

  if (!QUIET) maybeRenderHud(parsed);
});

// ---------- HUD ----------

function bar(value, max, width = 20, fillCh = '#', emptyCh = '-') {
  const n = Math.max(0, Math.min(width, Math.round((value / max) * width)));
  return fillCh.repeat(n) + emptyCh.repeat(width - n);
}

function gearLabel(parsed) {
  if (parsed.currentGear === 0) return 'R';
  if (parsed.currentGear === 15) return 'N';
  return String(parsed.currentGear);
}

function maybeRenderHud(p) {
  const now = Date.now();
  if (now - lastPrintAt < 100) return;   // throttle to 10 Hz
  lastPrintAt = now;

  const rpmPct = p.maxRpmAlert > 0 ? p.engineRpm / p.maxRpmAlert : 0;
  const lines = [
    '\x1b[2J\x1b[H',
    `GT7 Telemetry  ${PS5_HOST}   pkts=${receivedCount}  drops=${droppedCount}  ` +
      `uptime=${((now - started) / 1000).toFixed(0)}s`,
    recordPath ? `recording: ${path.basename(recordPath)}` : 'recording: off',
    '',
    `Gear  ${gearLabel(p)}` + (p.suggestedGear && p.suggestedGear !== 15 ? `  >> shift ${p.suggestedGear}` : ''),
    `Speed ${p.speedKph.toFixed(1).padStart(6)} km/h    RPM ${Math.round(p.engineRpm).toString().padStart(5)} / ${p.maxRpmAlert}`,
    `      [${bar(rpmPct, 1, 30, '=', ' ')}]`,
    '',
    `Throttle [${bar(p.throttle, 255, 25)}] ${Math.round(p.throttle / 2.55)}%`,
    `Brake    [${bar(p.brake,    255, 25)}] ${Math.round(p.brake    / 2.55)}%`,
    `Clutch   ${(p.clutchPedal * 100).toFixed(0)}%   Engagement ${(p.clutchEngagement * 100).toFixed(0)}%`,
    '',
    `Lap   ${p.lapCount} / ${p.lapsInRace}    Pos ${p.racePosition} / ${p.totalCars}`,
    `Last  ${formatLapTime(p.lastLapTimeMs)}   Best ${formatLapTime(p.bestLapTimeMs)}`,
    '',
    `Fuel   ${p.fuelLevel.toFixed(1)} / ${p.fuelCapacity.toFixed(0)} L`,
    `Water  ${p.waterTempC.toFixed(1)} C    Oil  ${p.oilTempC.toFixed(1)} C @ ${p.oilPressure.toFixed(2)} bar`,
    `Boost  ${p.boostBar.toFixed(2)} bar`,
    `Tires  FL ${p.tireTempC.fl.toFixed(0)}  FR ${p.tireTempC.fr.toFixed(0)}  ` +
           `RL ${p.tireTempC.rl.toFixed(0)}  RR ${p.tireTempC.rr.toFixed(0)} (C)`,
    '',
    `Pos    x=${p.position.x.toFixed(1)}  y=${p.position.y.toFixed(1)}  z=${p.position.z.toFixed(1)}`,
    `Flags  ${activeFlags(p.flags)}`,
    '',
    'Ctrl-C to stop.',
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

function activeFlags(f) {
  return Object.entries(f).filter(([, v]) => v).map(([k]) => k).join(' ') || '(none)';
}

// ---------- shutdown ----------

function shutdown() {
  process.stdout.write('\n[bye] flushing recording...\n');
  metrics.stop();
  if (events) events.close();
  if (recordStream) {
    recordStream.end(() => {
      if (recordPath) process.stdout.write(`[rec] saved ${recordPath}\n`);
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ---------- go ----------

openRecording();
if (RECORD) events = new EventLogger(RECORD_DIR);
if (!METRICS_OFF) metrics.start(METRICS_PORT);
sock.bind(RECEIVE_PORT);

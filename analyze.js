#!/usr/bin/env node
// Summarize a recorded GT7 telemetry session.
//
//   node analyze.js                              # picks newest recording
//   node analyze.js recordings/gt7-XYZ.jsonl     # specific file

const fs   = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { formatLapTime } = require('./parser');
const metadata = require('./metadata');

const RECORD_DIR = path.resolve(__dirname, 'recordings');

function pickFile() {
  const arg = process.argv[2];
  if (arg) return path.resolve(arg);
  if (!fs.existsSync(RECORD_DIR)) die(`no recordings dir at ${RECORD_DIR}`);
  const files = fs.readdirSync(RECORD_DIR)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => path.join(RECORD_DIR, f))
    .map(p => ({ p, mtime: fs.statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!files.length) die(`no .jsonl files in ${RECORD_DIR}`);
  return files[0].p;
}

function die(msg) { process.stderr.write(`error: ${msg}\n`); process.exit(1); }

function pct(values, p) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

function avg(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function maxOf(values) {
  let m = -Infinity;
  for (let i = 0; i < values.length; i++) if (values[i] > m) m = values[i];
  return m === -Infinity ? 0 : m;
}

async function main() {
  const file = pickFile();
  process.stdout.write(`Analyzing ${file}\n\n`);

  const stream = fs.createReadStream(file);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const speeds = [];
  const rpms   = [];
  const throttles = [];
  const brakes = [];
  const lapTimes = new Map();   // lapCount -> lastLapTimeMs (recorded once it completes)
  const tireMax  = { fl: 0, fr: 0, rl: 0, rr: 0 };
  const carCodes = new Set();
  const gearCounts = new Array(16).fill(0);
  let bestLap = 0;
  let firstTs = 0, lastTs = 0;
  let count = 0;
  let bothFeet = 0;     // throttle+brake simultaneously > 20%

  const fp = new metadata.Fingerprinter();
  let sessionType = 'unknown';

  for await (const line of rl) {
    if (!line.trim()) continue;
    let p;
    try { p = JSON.parse(line); } catch { continue; }
    count++;
    if (!firstTs) firstTs = p.t;
    lastTs = p.t;

    speeds.push(p.speedKph);
    rpms.push(p.engineRpm);
    throttles.push(p.throttle / 2.55);
    brakes.push(p.brake / 2.55);
    if (p.throttle > 50 && p.brake > 50) bothFeet++;
    if (p.currentGear >= 0 && p.currentGear < 16) gearCounts[p.currentGear]++;

    for (const w of ['fl', 'fr', 'rl', 'rr']) {
      if (p.tireTempC?.[w] > tireMax[w]) tireMax[w] = p.tireTempC[w];
    }
    if (p.carCode) carCodes.add(p.carCode);
    fp.accumulate(p);
    if (sessionType === 'unknown') sessionType = metadata.detectSessionType(p);
    if (p.bestLapTimeMs > 0 && (bestLap === 0 || p.bestLapTimeMs < bestLap)) bestLap = p.bestLapTimeMs;
    if (p.lastLapTimeMs > 0 && p.lapCount > 0) {
      // Record per-lap time (last value seen on that lap = the official last-lap when it just rolled over)
      const key = p.lapCount - 1;     // lastLap belongs to the previously completed lap
      if (key > 0) lapTimes.set(key, p.lastLapTimeMs);
    }
  }

  if (!count) die('no parseable packets in file');

  const durSec = (lastTs - firstTs) / 1000;
  process.stdout.write(`packets:        ${count}  (${(count / Math.max(durSec, 1)).toFixed(1)} Hz)\n`);
  process.stdout.write(`duration:       ${durSec.toFixed(1)} s\n`);

  // ---- metadata ----
  const carLabels = [...carCodes].map(c => {
    const m = metadata.lookupCar(c);
    return m ? `${m.name} (${m.class}) [${c}]` : `UNKNOWN [${c}]`;
  });
  process.stdout.write(`car:            ${carLabels.join(', ') || '(none)'}\n`);

  const captured = fp.fingerprint();
  if (captured.lapDistanceM > 0) {
    const trackMatch = metadata.matchTrack(captured);
    if (trackMatch) {
      process.stdout.write(`track:          ${trackMatch.name} [${trackMatch.id}]  (lap ~${captured.lapDistanceM}m)\n`);
    } else {
      process.stdout.write(`track:          UNKNOWN  (lap ~${captured.lapDistanceM}m, bounds ${JSON.stringify(captured.bounds)})\n`);
    }
  } else {
    process.stdout.write(`track:          insufficient data to fingerprint\n`);
  }
  process.stdout.write(`session:        ${sessionType}\n\n`);

  process.stdout.write('SPEED\n');
  process.stdout.write(`  max:    ${maxOf(speeds).toFixed(1)} km/h\n`);
  process.stdout.write(`  avg:    ${avg(speeds).toFixed(1)} km/h\n`);
  process.stdout.write(`  p95:    ${pct(speeds, 95).toFixed(1)} km/h\n\n`);

  process.stdout.write('RPM\n');
  process.stdout.write(`  max:    ${Math.round(maxOf(rpms))}\n`);
  process.stdout.write(`  avg:    ${Math.round(avg(rpms))}\n\n`);

  process.stdout.write('INPUTS\n');
  process.stdout.write(`  throttle avg: ${avg(throttles).toFixed(1)}%\n`);
  process.stdout.write(`  brake avg:    ${avg(brakes).toFixed(1)}%\n`);
  process.stdout.write(`  both >50%:    ${bothFeet} packets (${(100 * bothFeet / count).toFixed(1)}%)\n\n`);

  process.stdout.write('GEAR USAGE (% of time)\n');
  for (let g = 0; g < gearCounts.length; g++) {
    if (!gearCounts[g]) continue;
    const label = g === 0 ? 'R' : g === 15 ? 'N' : String(g);
    const pctTime = (100 * gearCounts[g] / count).toFixed(1);
    process.stdout.write(`  ${label.padStart(2)}: ${pctTime}%\n`);
  }
  process.stdout.write('\n');

  process.stdout.write('TIRE TEMP MAX (C)\n');
  process.stdout.write(`  FL ${tireMax.fl.toFixed(0)}  FR ${tireMax.fr.toFixed(0)}  ` +
                      `RL ${tireMax.rl.toFixed(0)}  RR ${tireMax.rr.toFixed(0)}\n\n`);

  process.stdout.write(`BEST LAP: ${formatLapTime(bestLap)}\n`);
  if (lapTimes.size) {
    process.stdout.write('LAP TIMES (recorded as each lap completed)\n');
    const keys = [...lapTimes.keys()].sort((a, b) => a - b);
    for (const k of keys) {
      process.stdout.write(`  lap ${String(k).padStart(2)}: ${formatLapTime(lapTimes.get(k))}\n`);
    }
  }
}

main().catch(err => { console.error(err); process.exit(1); });

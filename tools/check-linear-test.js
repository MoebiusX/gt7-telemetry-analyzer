#!/usr/bin/env node
// Per-lap brake hygiene report. Useful for diagnosing brake-pedal anomalies:
//   - "stuck events" (brake + throttle pressed >300ms continuously at >50%/2%)
//   - peak brake pressure per lap
//   - brake noise on clear straights
//   - total brake-on percentage of lap
//
// Defaults to today's recording. Override with --file <path>.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

function todayFile() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return path.resolve(__dirname, '..', 'recordings', `gt7-${y}-${m}-${dd}.jsonl`);
}

const CAR_FILTER    = arg('--car', null) ? Number(arg('--car')) : null;
const DRIVER_FILTER = arg('--driver', null);

(async () => {
  const file = arg('--file', todayFile());
  if (!fs.existsSync(file)) { console.log('no recording at', file); return; }
  console.log('Reading', file);
  if (CAR_FILTER) console.log('  filter: carCode =', CAR_FILTER);
  if (DRIVER_FILTER) console.log('  filter: driver =', DRIVER_FILTER);
  const stream = fs.createReadStream(file);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const packets = [];
  for await (const line of rl) {
    try {
      const p = JSON.parse(line);
      if (p.type === 'config' || !p.position) continue;
      // Filter by car if requested (else accept all)
      if (CAR_FILTER && p.carCode !== CAR_FILTER) continue;
      // Filter by driver tag if requested (else accept all)
      if (DRIVER_FILTER && p.driver && p.driver !== DRIVER_FILTER) continue;
      packets.push({ t: p.t, lap: p.lapCount, lastMs: p.lastLapTimeMs, brake: p.brake, throttle: p.throttle, speedKph: p.speedKph });
    } catch {}
  }
  rl.close();
  console.log('Total packets today:', packets.length);
  if (!packets.length) return;

  const laps = [];
  let cs = 0;
  for (let i = 1; i < packets.length; i++) {
    if (packets[i].lap !== packets[i-1].lap) {
      const c = packets[i].lastMs;
      const wallMs = packets[i-1].t - packets[cs].t;
      if (typeof c === 'number' && c > 30000 && c < 600000 && wallMs > c * 0.85) {
        laps.push({ num: packets[i-1].lap, startIdx: cs, endIdx: i-1, completedMs: c, startT: packets[cs].t });
      }
      cs = i;
    }
  }
  console.log('Valid laps:', laps.length);
  if (!laps.length) return;
  console.log('');
  console.log('Per-lap brake hygiene (post linear-curve change):');
  console.log('#   time     total     peakBr  stuck-ms  brake-on-straight%  total-brake%');
  let stuckEventCount = 0;
  let stuckTotalMs = 0;
  for (const lap of laps) {
    let peakBr = 0, stuckStart = null, stuckMs = 0;
    let strightSamples = 0, strightBrakeSamples = 0, brakePosSamples = 0;
    let lapEventCount = 0;
    const total = lap.endIdx - lap.startIdx + 1;
    for (let i = lap.startIdx; i <= lap.endIdx; i++) {
      const p = packets[i];
      const brakePct = p.brake / 2.55;
      const thrPct = p.throttle / 2.55;
      if (brakePct > peakBr) peakBr = brakePct;
      if (brakePct > 2 && thrPct > 50) {
        if (stuckStart === null) stuckStart = p.t;
      } else {
        if (stuckStart !== null) {
          const dur = p.t - stuckStart;
          if (dur >= 300) { lapEventCount++; stuckMs += dur; }
          stuckStart = null;
        }
      }
      if (thrPct > 80 && p.speedKph > 150) {
        strightSamples++;
        if (brakePct > 0.5) strightBrakeSamples++;
      }
      if (p.brake > 0) brakePosSamples++;
    }
    if (stuckStart !== null) {
      const dur = packets[lap.endIdx].t - stuckStart;
      if (dur >= 300) { lapEventCount++; stuckMs += dur; }
    }
    stuckEventCount += lapEventCount;
    stuckTotalMs += stuckMs;
    const t = new Date(lap.startT).toLocaleTimeString('en-GB').slice(0,8);
    const straightBrakePct = strightSamples > 0 ? (100*strightBrakeSamples/strightSamples).toFixed(2) : '—';
    const totalBrakePct = (100*brakePosSamples/total).toFixed(1);
    console.log(String(laps.indexOf(lap)).padStart(3), t, ' '+(lap.completedMs/1000).toFixed(3)+'s ', peakBr.toFixed(0).padStart(4)+'%', String(stuckMs).padStart(7)+'ms', String(lapEventCount).padStart(2)+' ev', String(straightBrakePct).padStart(6)+'%        ', totalBrakePct+'%');
  }
  console.log('');
  console.log('SUMMARY today:', laps.length, 'laps,', stuckEventCount, 'stuck events totaling', (stuckTotalMs/1000).toFixed(2)+'s');
  console.log('YESTERDAY (for reference): 173 events totaling 243.24s across 9 days of recordings');
})();

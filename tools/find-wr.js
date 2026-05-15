#!/usr/bin/env node
// Scan recordings to find the WR capture (bestLapTimeMs ~= 91933).
const fs   = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const DIR = path.resolve(__dirname, '..', 'recordings');
const files = fs.readdirSync(DIR)
  .filter(f => f.endsWith('.jsonl'))
  .filter(f => fs.statSync(path.join(DIR, f)).size > 1_000_000)
  .map(f => path.join(DIR, f));

(async () => {
  for (const f of files) {
    let n = 0, bestSeen = Infinity, lapMax = -1, carCodes = new Set();
    let firstX = null, firstZ = null;
    const stream = fs.createReadStream(f);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      n++;
      if (n > 60_000) break; // sample ~16 minutes
      try {
        const p = JSON.parse(line);
        if (p.type === 'config') continue;
        if (typeof p.bestLapTimeMs === 'number' && p.bestLapTimeMs > 30_000 && p.bestLapTimeMs < 600_000) {
          if (p.bestLapTimeMs < bestSeen) bestSeen = p.bestLapTimeMs;
        }
        if (typeof p.lapCount === 'number' && p.lapCount > lapMax) lapMax = p.lapCount;
        if (typeof p.carCode === 'number') carCodes.add(p.carCode);
        if (firstX === null && p.position) { firstX = p.position.x; firstZ = p.position.z; }
      } catch {}
    }
    rl.close();
    const sizeMb = (fs.statSync(f).size / 1024 / 1024).toFixed(1);
    console.log(`${path.basename(f)}  ${sizeMb}MB  packets≈${n}  bestSeen=${bestSeen===Infinity?'-':bestSeen}  maxLap=${lapMax}  cars=[${[...carCodes].join(',')}]  startXZ=(${firstX?.toFixed(1)},${firstZ?.toFixed(1)})`);
  }
})();

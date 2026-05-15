#!/usr/bin/env node
// Show every lapCount/lastLapTimeMs transition in the WR file.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const FILE = path.resolve(__dirname, '..', 'recordings',
  'gt7-2026-05-06T17-14-57-957Z.jsonl');

(async () => {
  const stream = fs.createReadStream(FILE);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let prev = null;
  let n = 0;
  let pktInRace = 0;
  const transitions = [];
  for await (const line of rl) {
    let p; try { p = JSON.parse(line); } catch { continue; }
    if (p.type === 'config') continue;
    if (typeof p.lapCount !== 'number') continue;
    n++;
    if (p.flags?.inRace) pktInRace++;
    if (prev) {
      if (p.lapCount !== prev.lapCount || p.lastLapTimeMs !== prev.lastLapTimeMs || p.bestLapTimeMs !== prev.bestLapTimeMs) {
        transitions.push({
          packetIdx: n-1,
          lapCount: p.lapCount,
          prevLap: prev.lapCount,
          lastLapTimeMs: p.lastLapTimeMs,
          bestLapTimeMs: p.bestLapTimeMs,
          inRace: p.flags?.inRace,
          paused: p.flags?.paused,
          x: p.position?.x?.toFixed(0),
          z: p.position?.z?.toFixed(0),
        });
      }
    }
    prev = p;
  }
  rl.close();
  console.log(`Total packets: ${n}, inRace: ${pktInRace}`);
  console.log(`Total transitions: ${transitions.length}`);
  console.log('First 30 transitions:');
  transitions.slice(0, 30).forEach(t => console.log(JSON.stringify(t)));
})();

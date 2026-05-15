#!/usr/bin/env node
// Quick debug: find the lap producing 9.5s S3 — print its completedMs, wall-clock duration, num
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const FILE = path.resolve(__dirname, '..', 'recordings', 'gt7-2026-05-13.jsonl');

(async () => {
  const targetCar = 2166;
  const packets = [];
  const stream = fs.createReadStream(FILE);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    try {
      const p = JSON.parse(line);
      if (p.type === 'config') continue;
      if (p.carCode !== targetCar || !p.position) continue;
      packets.push({ t: p.t, lap: p.lapCount, lastMs: p.lastLapTimeMs, x: p.position.x, z: p.position.z });
    } catch {}
  }
  rl.close();

  // Slice into laps with full info
  const laps = [];
  let cs = 0;
  for (let i = 1; i < packets.length; i++) {
    if (packets[i].lap !== packets[i-1].lap) {
      const c = packets[i].lastMs;
      const wallMs = packets[i-1].t - packets[cs].t;
      if (typeof c === 'number' && c > 30_000 && c < 600_000 && wallMs > c * 0.9) {
        laps.push({ num: packets[i-1].lap, start: cs, end: i-1, c, wallMs });
      }
      cs = i;
    }
  }
  console.log(`Total laps: ${laps.length}`);

  // Show short laps (under 70s)
  console.log('\nLaps with completedMs < 70s:');
  for (const l of laps.filter(x => x.c < 70_000)) {
    console.log(`  order=${laps.indexOf(l)} num=${l.num} completedMs=${(l.c/1000).toFixed(3)}s wallMs=${(l.wallMs/1000).toFixed(3)}s`);
  }
  // PB lap by order
  let pbMs = Infinity, pbIdx = -1;
  for (let i = 0; i < laps.length; i++) if (laps[i].c < pbMs) { pbMs = laps[i].c; pbIdx = i; }
  console.log(`\nPB lap: order=${pbIdx} num=${laps[pbIdx].num} completedMs=${(pbMs/1000).toFixed(3)}s`);

  // Show top-10 fastest laps to understand the distribution
  const sorted = laps.slice().sort((a,b) => a.c - b.c);
  console.log('\nTop-15 fastest laps:');
  for (const l of sorted.slice(0, 15)) {
    console.log(`  order=${laps.indexOf(l)} num=${l.num} completedMs=${(l.c/1000).toFixed(3)}s`);
  }
})();

#!/usr/bin/env node
// Plot WR-lap elevation profile + mark the brake zones,
// to identify which zones are in the "valley".
const fs = require('node:fs');
const path = require('node:path');
const data = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, 'wr-corners.json'), 'utf8'));

console.log('Brake zone elevations (apex Y, lower = lower elevation):\n');
console.log('# │  lap%  │ apex Y  │ X      │ Z      │ entry-spd│ apex-spd│ turn');
console.log('──┼────────┼─────────┼────────┼────────┼──────────┼─────────┼─────');
data.brakeZones.forEach((z, i) => {
  console.log(
    `${String(i+1).padStart(2)} │ ${String(z.lapPct).padStart(5)}% │ ` +
    `${z.yApex.toFixed(1).padStart(6)} │ ${z.xApex.toFixed(0).padStart(6)} │ ` +
    `${z.zApex.toFixed(0).padStart(6)} │ ${z.entrySpeed.toFixed(0).padStart(7)} │ ` +
    `${z.minSpeed.toFixed(0).padStart(6)} │`
  );
});

// Show range
const ys = data.brakeZones.map(z => z.yApex);
const yMin = Math.min(...ys), yMax = Math.max(...ys);
console.log(`\nY range across brake apexes: ${yMin.toFixed(1)} to ${yMax.toFixed(1)} (delta ${(yMax-yMin).toFixed(1)} m)`);
console.log(`The lowest 3 by Y: ` +
  data.brakeZones
    .map((z,i) => ({i:i+1, y:z.yApex, lap:z.lapPct}))
    .sort((a,b) => a.y - b.y)
    .slice(0, 3)
    .map(x => `#${x.i} (lap ${x.lap}%, Y=${x.y.toFixed(1)})`)
    .join(', ')
);

// Find consecutive pair of low-Y zones
console.log('\nConsecutive brake-zone pairs (gap and avg Y):');
for (let i = 0; i < data.brakeZones.length - 1; i++) {
  const a = data.brakeZones[i], b = data.brakeZones[i+1];
  const lapGap = (parseFloat(b.lapPct) - parseFloat(a.lapPct)).toFixed(1);
  const avgY = ((a.yApex + b.yApex) / 2).toFixed(1);
  console.log(`  ${i+1}→${i+2}  lap gap ${lapGap}%  avg apex Y=${avgY}`);
}

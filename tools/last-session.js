#!/usr/bin/env node
// Snapshot of today's most recent session: sectors, theoretical, last-N stats.
const lapAnalyzer = require('../src/analysis/lap-analyzer');
(async () => {
  const d = await lapAnalyzer.get({ force: true });
  const laps = (d.laps || []).filter(l => l.s1 != null);
  console.log('Total laps with sectors:', laps.length);
  console.log('PB:', (d.pbMs/1000).toFixed(3) + 's lap #' + d.pbOrder);
  console.log('Theoretical:', d.theoreticalMs ? (d.theoreticalMs/1000).toFixed(3)+'s' : '—');
  console.log('Best S1:', (d.bestSectors.s1.ms/1000).toFixed(3) + 's lap #' + d.bestSectors.s1.lapOrder);
  console.log('Best S2:', (d.bestSectors.s2.ms/1000).toFixed(3) + 's lap #' + d.bestSectors.s2.lapOrder);
  console.log('Best S3:', (d.bestSectors.s3.ms/1000).toFixed(3) + 's lap #' + d.bestSectors.s3.lapOrder);

  // Identify "last session" by finding the largest time-gap between consecutive laps
  let sessionStart = 0;
  let biggestGap = 0;
  for (let i = 1; i < laps.length; i++) {
    const gap = laps[i].startT - laps[i-1].startT;
    if (gap > biggestGap) { biggestGap = gap; sessionStart = i; }
  }
  const recent = laps.slice(sessionStart);
  console.log('');
  console.log('=== Last session (' + recent.length + ' laps, started ' + new Date(recent[0].startT).toLocaleTimeString('en-GB') + ', gap-before ' + (biggestGap/60000).toFixed(0) + ' min) ===');
  console.log('order time      total     S1       S2       S3       ΔPB');
  for (const l of recent) {
    const t = new Date(l.startT).toLocaleTimeString('en-GB');
    const dPb = l.completedMs - d.pbMs;
    console.log(String(l.order).padStart(4), t, (l.completedMs/1000).toFixed(3)+'s', (l.s1/1000).toFixed(3)+'s', (l.s2/1000).toFixed(3)+'s', (l.s3/1000).toFixed(3)+'s',
      (dPb===0?'★ PB':((dPb>=0?'+':'')+(dPb/1000).toFixed(3)+'s')));
  }
  const times = recent.map(l => l.completedMs);
  const sorted = times.slice().sort((a,b)=>a-b);
  const mean = times.reduce((a,b)=>a+b,0) / times.length;
  const stddev = Math.sqrt(times.reduce((a,b)=>a+(b-mean)**2,0) / times.length);
  console.log('');
  console.log('Last-session stats:');
  console.log('  fastest:', (sorted[0]/1000).toFixed(3)+'s   slowest:', (sorted[sorted.length-1]/1000).toFixed(3)+'s');
  console.log('  median: ', (sorted[Math.floor(sorted.length/2)]/1000).toFixed(3)+'s   mean: ', (mean/1000).toFixed(3)+'s');
  console.log('  stddev: ', (stddev/1000).toFixed(3)+'s   range:', ((sorted[sorted.length-1]-sorted[0])/1000).toFixed(3)+'s');
})();

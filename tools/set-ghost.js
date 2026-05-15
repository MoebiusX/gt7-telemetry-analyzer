#!/usr/bin/env node
// Register a ghost lap for /track overlay.
//
// Usage:
//   node tools/set-ghost.js --file <recording.jsonl> [--lap <N>] [--target <ms>] [--label "WR — Big Willow Alfa 4C"]
//   node tools/set-ghost.js --clear
//   node tools/set-ghost.js --show
//
// If neither --lap nor --target is given, the fastest lap in the file is picked.

const ghost = require('../ghost-store');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  return process.argv[i + 1];
}

(async () => {
  if (process.argv.includes('--clear')) {
    ghost.clear();
    console.log('Ghost cleared.');
    return;
  }
  if (process.argv.includes('--show')) {
    const g = ghost.load();
    if (!g) console.log('No ghost registered.');
    else console.log({
      label: g.label, sourceFile: g.sourceFile, lapNumber: g.lapNumber,
      completedMs: g.completedMs, carCode: g.carCode, traceSamples: g.trace?.length || 0,
    });
    return;
  }

  const file = arg('--file');
  if (!file) {
    console.error('--file <recording.jsonl> required (relative to recordings/ or absolute path)');
    process.exit(1);
  }
  const lapNumber = arg('--lap');
  const target = arg('--target');
  const label = arg('--label', `${file} lap${lapNumber ? ' #' + lapNumber : ''}`);

  console.log(`Scanning ${file}...`);
  const ext = await ghost.extractLapFromFile({
    file,
    lapNumber: lapNumber ? Number(lapNumber) : undefined,
    targetCompletedMs: target ? Number(target) : undefined,
  });
  const record = {
    label,
    registeredAt: new Date().toISOString(),
    sourceFile: ext.sourceFile,
    carCode: ext.carCode,
    lapNumber: ext.lapNumber,
    completedMs: ext.completedMs,
    trace: ext.trace,
  };
  ghost.set(record);
  console.log(`Registered ghost:`);
  console.log(`  label:       ${label}`);
  console.log(`  source:      ${ext.sourceFile}`);
  console.log(`  car:         ${ext.carCode}`);
  console.log(`  lap #:       ${ext.lapNumber}`);
  console.log(`  completed:   ${(ext.completedMs/1000).toFixed(3)}s`);
  console.log(`  samples:     ${ext.trace.length} (20Hz)`);
  console.log(`  saved to:    ${ghost.GHOST_FILE}`);
  console.log(`  → reload http://localhost:9477/track to see the yellow ghost overlay.`);
})();

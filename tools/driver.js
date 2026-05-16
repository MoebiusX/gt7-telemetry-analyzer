#!/usr/bin/env node
// Driver profile management.
//
// Usage:
//   node tools/driver.js list
//   node tools/driver.js add <id> --label "Name" [--psn YOUR_PSN_ID] [--color "#ff9800"]
//   node tools/driver.js remove <id>
//   node tools/driver.js use <id>            # set active driver

const ds = require('../src/analysis/driver-store');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  return process.argv[i + 1];
}

const cmd = process.argv[2];
const id  = process.argv[3];

if (cmd === 'list') {
  const active = ds.getActive();
  for (const d of ds.listDrivers()) {
    const marker = d.id === active.id ? '★' : ' ';
    console.log(`${marker} ${d.id.padEnd(12)} ${d.label.padEnd(20)} psn=${d.psn || '-'}  color=${d.color}`);
  }
} else if (cmd === 'add') {
  if (!id) { console.error('id required: node tools/driver.js add <id> --label "Name"'); process.exit(1); }
  ds.addDriver({
    id,
    label: arg('--label', id),
    psn:   arg('--psn', ''),
    color: arg('--color', '#ff9800'),
  });
  console.log(`Added driver: ${id}`);
} else if (cmd === 'remove') {
  if (!id) { console.error('id required'); process.exit(1); }
  ds.removeDriver(id);
  console.log(`Removed: ${id}`);
} else if (cmd === 'use') {
  if (!id) { console.error('id required'); process.exit(1); }
  ds.setActive(id);
  console.log(`Active driver is now: ${id}`);
} else {
  console.log('Commands: list | add <id> [--label X --psn Y --color "#xxxxxx"] | remove <id> | use <id>');
  process.exit(1);
}

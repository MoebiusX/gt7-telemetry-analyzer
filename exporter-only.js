#!/usr/bin/env node
// Standalone Prometheus exporter — no UDP capture.
// Use when index.js can't bind the GT7 UDP port (e.g. Windows port reservation
// after a crash) but you still want the /metrics endpoint up so Prometheus
// stays "up" and the dashboard plumbing is validated.
//
// All telemetry metrics will report empty / stale (gt7_data_age_seconds=9999,
// gt7_packets_received_total=0) — only gt7_up=1 confirms the exporter itself.
//
//   node exporter-only.js                   # default port 9477
//   node exporter-only.js --port 9477

const argv = process.argv.slice(2);
function arg(flag, fallback) {
  const i = argv.indexOf(flag);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  return (!v || v.startsWith('--')) ? true : v;
}

const PORT = Number(arg('--port', 9477));
const metrics = require('./metrics');
metrics.start(PORT);

process.on('SIGINT',  () => { metrics.stop(); process.exit(0); });
process.on('SIGTERM', () => { metrics.stop(); process.exit(0); });

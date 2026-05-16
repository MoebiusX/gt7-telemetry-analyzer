#!/usr/bin/env node
// Watchdog for the GT7 telemetry capture.
// Spawns `node index.js`, restarts it if it exits for any reason, and writes
// every restart event to watchdog.log. Each restart produces its own
// timestamped recording file (index.js already names recordings by start time),
// so no data from prior runs is overwritten.
//
//   node watchdog.js                    # forwards all args to index.js
//   node watchdog.js --ps5 192.168.1.42
//
// Stop with Ctrl-C — the watchdog forwards SIGINT to the child, waits for it
// to flush the recording, then exits cleanly.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const LOG_PATH = path.resolve(__dirname, '..', 'watchdog.log');
const CHILD_SCRIPT = path.resolve(__dirname, '..', 'index.js');
const childArgs = process.argv.slice(2);

const MIN_RESTART_INTERVAL_MS = 2000;   // backoff if child crashes immediately
const MAX_BACKOFF_MS = 30_000;

let child = null;
let shuttingDown = false;
let restartCount = 0;
let consecutiveFastFails = 0;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  fs.appendFileSync(LOG_PATH, line);
}

function spawnChild() {
  const startedAt = Date.now();
  log(`starting child: node index.js ${childArgs.join(' ')}`);
  child = spawn(process.execPath, [CHILD_SCRIPT, ...childArgs], {
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });

  child.on('exit', (code, signal) => {
    const lifeMs = Date.now() - startedAt;
    log(`child exited code=${code} signal=${signal} after ${lifeMs}ms`);

    if (shuttingDown) {
      log('shutdown requested — watchdog exiting');
      process.exit(0);
    }

    restartCount++;
    if (lifeMs < MIN_RESTART_INTERVAL_MS) {
      consecutiveFastFails++;
    } else {
      consecutiveFastFails = 0;
    }
    const backoff = Math.min(
      MIN_RESTART_INTERVAL_MS * Math.pow(2, consecutiveFastFails),
      MAX_BACKOFF_MS,
    );
    log(`restart #${restartCount} in ${backoff}ms (consecutive fast-fails: ${consecutiveFastFails})`);
    setTimeout(spawnChild, backoff);
  });

  child.on('error', (err) => {
    log(`spawn error: ${err.message}`);
  });
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`watchdog received ${signal} — forwarding to child`);
  if (child && !child.killed) {
    child.kill('SIGINT');
    setTimeout(() => {
      if (child && !child.killed) {
        log('child did not exit in 5s — sending SIGKILL');
        child.kill('SIGKILL');
      }
    }, 5000);
  } else {
    process.exit(0);
  }
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

log(`watchdog starting (pid=${process.pid})`);
spawnChild();

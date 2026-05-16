// Append-only structured event stream.
//
// Writes one JSON object per line to recordings/events-YYYY-MM-DD.jsonl.
// Events are *moments in time* (lap_end, session_start, pb_set) — distinct
// from the 60Hz packet stream. Useful for replay, dashboards, and asking
// "what changed on lap 17?" without scrubbing 5GB of packets.

const fs   = require('node:fs');
const path = require('node:path');

class EventLogger {
  constructor(dir) {
    this.dir = dir;
    this.stream = null;
    this.path = null;
    this.lastSeenPbMs = null;
    this.lastSessionFingerprint = null;
    this._openForToday();
  }

  _openForToday() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const fname = `events-${y}-${m}-${day}.jsonl`;
    const p = path.join(this.dir, fname);
    if (p === this.path) return;
    try {
      if (this.stream) this.stream.end();
      fs.mkdirSync(this.dir, { recursive: true });
      this.stream = fs.createWriteStream(p, { flags: 'a' });
      this.path = p;
    } catch (e) {
      process.stderr.write(`[events] open failed: ${e.message}\n`);
    }
  }

  _write(ev) {
    // Auto-rotate at midnight without polling — check filename on every write.
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const expected = path.join(this.dir, `events-${y}-${m}-${day}.jsonl`);
    if (expected !== this.path) this._openForToday();
    if (!this.stream) return;
    this.stream.write(JSON.stringify(ev) + '\n');
  }

  emit(type, payload) {
    this._write({ type, t: Date.now(), ...payload });
  }

  // Convenience: report a session-meta change as a session_start event.
  // Called whenever (car, track, sessionType) changes — fingerprint detects diffs.
  sessionUpdate(meta) {
    const fp = JSON.stringify({
      car: meta.car?.carCode || null,
      track: meta.track?.id || null,
      type: meta.sessionType || null,
    });
    if (fp === this.lastSessionFingerprint) return;
    this.lastSessionFingerprint = fp;
    this.emit('session_start', {
      car: meta.car ? { code: meta.car.carCode, name: meta.car.name, class: meta.car.class } : null,
      track: meta.track ? { id: meta.track.id, name: meta.track.name } : null,
      sessionType: meta.sessionType || 'unknown',
    });
  }

  // Convenience: emit lap_end + (maybe) pb_set when a lap finishes.
  lapEnd(payload) {
    this.emit('lap_end', payload);
    if (payload.totalMs && (this.lastSeenPbMs === null || payload.totalMs < this.lastSeenPbMs)) {
      this.lastSeenPbMs = payload.totalMs;
      this.emit('pb_set', {
        totalMs: payload.totalMs,
        sectors: payload.sectors || null,
        lapNumber: payload.lapNumber || null,
      });
    }
  }

  close() {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
  }
}

module.exports = { EventLogger };

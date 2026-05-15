// Live lap-time predictor + sector tracker.
//
// Records the XZ-position trace + elapsed time of the current best lap.
// While driving the next lap, finds the nearest point on the best-lap trace
// by XZ distance and projects:
//
//   predicted = currentLapElapsedMs + (bestLapMs - bestLapElapsedAtSameProgress)
//
// Also tracks sector times. Sectors are defined as equal-length thirds of the
// PB trace; boundaries are recomputed each time a new PB lap is captured.
// Per-lap sector times are derived from the lastMatchIdx as the car progresses
// through the reference trace.
//
// Limitations:
//   - First lap of a session has no reference; predicted = null, sectors null.
//   - Track changes (carCode/track switch) reset the reference — caller must
//     call reset() so we don't match against a stale trace.

const SAMPLE_INTERVAL_MS = 50; // 20 Hz reference trace (plenty for projection)
const SEARCH_WINDOW = 80;      // ± 80 samples around last match (≈4s of trace)

class LapPredictor {
  constructor() {
    this.reset();
  }

  reset() {
    this.bestLapMs        = null;
    this.bestTrace        = null;   // array of {t, x, z} where t is ms from lap start
    this.sectorBoundaryT  = null;   // [pbTimeAtS1End, pbTimeAtS2End] derived from bestTrace
    this.sectorBoundaryIdx = null;  // [s1EndIdx, s2EndIdx] into bestTrace
    this.currentTrace     = [];
    this.lapStartT        = null;   // ms wall-clock when current lap started
    this.lastSampleAtT    = 0;
    this.lastMatchIdx     = 0;      // hint for nearest-point search
    this.prevLapCount     = null;
    this.prevLastLapMs    = null;
    this.prevBestLapMs    = null;
    // Sector state for the lap currently being driven
    this.currentSector       = 1;       // 1 | 2 | 3
    this.sectorEnterElapsed  = [0, null, null]; // wall-clock elapsed when entering S1/S2/S3
    // Sector results
    this.lastLapSectorMs  = [null, null, null]; // result of last completed lap
    this.bestSectorMs     = [null, null, null]; // best-ever per sector
  }

  // Called once per packet.
  // Returns {
  //   predictedMs, deltaMs, currentLapElapsedMs, hasReference,
  //   currentSector, lastLapSectorMs, bestSectorMs,
  //   sectorBoundaryReady, theoreticalBestMs
  // } — any of these may be null when there isn't enough info yet.
  update(parsed, nowMs = Date.now()) {
    const out = {
      predictedMs: null,
      deltaMs: null,
      currentLapElapsedMs: null,
      hasReference: !!this.bestTrace,
      currentSector: this.currentSector,
      lastLapSectorMs: this.lastLapSectorMs.slice(),
      bestSectorMs: this.bestSectorMs.slice(),
      theoreticalBestMs: this._theoreticalBest(),
      sectorBoundaryReady: this.sectorBoundaryT !== null,
      lapJustEnded: false,        // set true on the packet that ends a lap
      completedLapMs: null,       // only set when lapJustEnded
      completedSectorMs: null,    // only set when lapJustEnded
    };

    if (!parsed || !parsed.position) return out;
    const lapCount = parsed.lapCount;
    const lastLapMs = parsed.lastLapTimeMs;
    const bestLapMs = parsed.bestLapTimeMs;

    // Detect lap transition: lapCount strictly increases.
    const lapJustEnded =
      this.prevLapCount !== null &&
      typeof lapCount === 'number' &&
      lapCount > this.prevLapCount;

    if (lapJustEnded) {
      const completedMs = lastLapMs;
      // Finalize sector times for the just-completed lap. Use the wall-clock
      // sector enter-times we accumulated during the lap.
      const sec = this._finalizeSectors(completedMs);
      this.lastLapSectorMs = sec;
      // Update best-sector tracker
      for (let i = 0; i < 3; i++) {
        if (sec[i] != null && (this.bestSectorMs[i] == null || sec[i] < this.bestSectorMs[i])) {
          this.bestSectorMs[i] = sec[i];
        }
      }
      // Install new PB trace if the just-completed lap is a new (or matching) PB
      if (
        completedMs > 30_000 && completedMs < 600_000 &&
        this.currentTrace.length > 10 &&
        (this.bestLapMs === null || completedMs <= this.bestLapMs)
      ) {
        this.bestLapMs = completedMs;
        this.bestTrace = this.currentTrace;
        this._recomputeSectorBoundaries();
      }
      // Surface the completion in the return value before we reset state.
      out.lapJustEnded = true;
      out.completedLapMs = completedMs;
      out.completedSectorMs = sec;
      // Start a fresh trace for the new lap.
      this.currentTrace        = [];
      this.lapStartT           = nowMs;
      this.lastSampleAtT       = 0;
      this.lastMatchIdx        = 0;
      this.currentSector       = 1;
      this.sectorEnterElapsed  = [0, null, null];
    } else if (this.lapStartT === null) {
      this.lapStartT = nowMs;
    }

    // Also pick up a PB that improved DURING the lap (rare — defensive only).
    if (typeof bestLapMs === 'number' && bestLapMs > 0 &&
        (this.bestLapMs === null || bestLapMs < this.bestLapMs)) {
      this.bestLapMs = bestLapMs;
    }

    this.prevLapCount  = lapCount;
    this.prevLastLapMs = lastLapMs;
    this.prevBestLapMs = bestLapMs;

    if (this.lapStartT === null) return out;

    const elapsed = nowMs - this.lapStartT;
    out.currentLapElapsedMs = elapsed;

    // Sample the current lap's trace at fixed cadence (bounded memory)
    if (elapsed - this.lastSampleAtT >= SAMPLE_INTERVAL_MS) {
      this.currentTrace.push({
        t: elapsed,
        x: parsed.position.x,
        z: parsed.position.z,
      });
      this.lastSampleAtT = elapsed;
    }

    if (!this.bestTrace || !this.bestLapMs) return out;

    // Windowed nearest-neighbor on reference trace
    const ref = this.bestTrace;
    const cx = parsed.position.x;
    const cz = parsed.position.z;
    let bestIdx = -1;
    let bestD2  = Infinity;
    const lo = Math.max(0, this.lastMatchIdx - 10);
    const hi = Math.min(ref.length - 1, this.lastMatchIdx + SEARCH_WINDOW);
    for (let i = lo; i <= hi; i++) {
      const dx = ref[i].x - cx, dz = ref[i].z - cz;
      const d2 = dx*dx + dz*dz;
      if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
    }
    if (bestIdx === hi || bestIdx === -1 || bestD2 > 1_000_000) {
      bestD2 = Infinity;
      for (let i = 0; i < ref.length; i++) {
        const dx = ref[i].x - cx, dz = ref[i].z - cz;
        const d2 = dx*dx + dz*dz;
        if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
      }
    }
    if (bestIdx === -1) return out;
    this.lastMatchIdx = bestIdx;

    // Sector-progress tracking (only if boundaries are known)
    if (this.sectorBoundaryIdx) {
      const [s1EndIdx, s2EndIdx] = this.sectorBoundaryIdx;
      let newSector = this.currentSector;
      if (bestIdx < s1EndIdx) newSector = 1;
      else if (bestIdx < s2EndIdx) newSector = 2;
      else newSector = 3;
      // Only allow forward sector progression in a lap (no flipping back across the line)
      if (newSector === this.currentSector + 1) {
        this.sectorEnterElapsed[newSector - 1] = elapsed;
        this.currentSector = newSector;
      }
      out.currentSector = this.currentSector;
    }

    const bestElapsedAtSamePoint = ref[bestIdx].t;
    out.deltaMs     = elapsed - bestElapsedAtSamePoint;
    out.predictedMs = elapsed + (this.bestLapMs - bestElapsedAtSamePoint);

    return out;
  }

  // Compute sector boundaries by walking ref-trace samples and dividing into thirds.
  _recomputeSectorBoundaries() {
    if (!this.bestTrace || this.bestTrace.length < 3) {
      this.sectorBoundaryIdx = null;
      this.sectorBoundaryT = null;
      return;
    }
    const n = this.bestTrace.length;
    const s1EndIdx = Math.floor(n / 3);
    const s2EndIdx = Math.floor(2 * n / 3);
    this.sectorBoundaryIdx = [s1EndIdx, s2EndIdx];
    this.sectorBoundaryT = [this.bestTrace[s1EndIdx].t, this.bestTrace[s2EndIdx].t];
  }

  // Derive sector times from the wall-clock sector-enter elapsed values.
  // Returns [s1ms, s2ms, s3ms] or [null,null,null] if not enough info.
  _finalizeSectors(completedLapMs) {
    if (!this.sectorBoundaryT) return [null, null, null];
    const s1Enter = this.sectorEnterElapsed[0]; // always 0
    const s2Enter = this.sectorEnterElapsed[1];
    const s3Enter = this.sectorEnterElapsed[2];
    if (s2Enter == null || s3Enter == null) return [null, null, null];
    const s1 = s2Enter - s1Enter;
    const s2 = s3Enter - s2Enter;
    const s3 = completedLapMs - s3Enter;
    if (s1 <= 0 || s2 <= 0 || s3 <= 0) return [null, null, null];
    return [s1, s2, s3];
  }

  _theoreticalBest() {
    if (this.bestSectorMs[0] == null || this.bestSectorMs[1] == null || this.bestSectorMs[2] == null) {
      return null;
    }
    return this.bestSectorMs[0] + this.bestSectorMs[1] + this.bestSectorMs[2];
  }
}

module.exports = { LapPredictor };

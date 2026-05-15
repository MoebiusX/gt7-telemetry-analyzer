// Live rig configuration store.
// Persisted to rig-config.json so it survives capture restarts.
// Mutated via the /config REST endpoint (see metrics.js).
// Each JSONL packet gets the current config + version stamped onto it
// so post-session analysis can group laps by setup.
//
// ============================================================
// RECOMMENDED SCHEMA (any extra keys allowed; nothing enforced)
// ============================================================
// {
//   "pedals": {
//     // Logitech PRO Racing Pedals — 6 elastomers ship, 3 used in stack.
//     // 1 short (of 2: soft beige LARGE for desk, firm beige SMALL for rig)
//     // + 2 long (of 4 colored: yellow softest → red → brown firmest;
//     //          a "black" 4th long is reported by community but not in
//     //          Logitech's published spare-parts list — leave for now).
//     // Hardness order (community-confirmed, no published Shore values):
//     //          brown > red > yellow.
//     // Logitech: large beige short MUST NOT be used in a hard-mounted rig.
//     "shortElastomer": "firm",            // "firm" | "soft"
//     "longElastomers": ["red", "brown"],  // pick 2 from yellow|red|brown|black
//     "brakeForceKg":   30                 // G HUB slider — kg load to reach
//                                          // 100% axis. Competitive rig range
//                                          // 30–50; desk 18–25; max sensor 100kg.
//   },
//   "rig": {
//     "seatBack":      "+2cm",  // +/-cm from a baseline you define
//     "seatHeight":    "0",
//     "pedalDistance": "stock"
//   },
//   "visual": {
//     "screenSizeInch": 55,
//     "eyeDistanceCm":  95,
//     "eyeLevel":       "mid"   // "mid" | "high" | "low" relative to screen center
//   },
//   "ffb": {
//     // G HUB (wheelbase hardware) — RS50 caps at 8 Nm; PRO Wheel at 11 Nm.
//     "ghubStrengthNm": 7,      // user runs 7 (down from 8 for thermal)
//     "ghubFilter":     11,     // 0=raw … 20+=heavy. competitive median ~11
//     "ghubDamper":     5,      // 0–5 for "raw" feel; 15–20 Logitech default
//     // GT7 in-game (1-10 sliders, NOT Nm)
//     "gt7MaxTorque":    5,     // alien consensus for Gr.3 on RS / DD wheels
//     "gt7Sensitivity":  2,     // Logitech says 1; competitive 2–10, median 2
//     "steeringDeg":    1080    // let GT7 auto-set per-car
//   },
//   "notes": "free-form text"
// }

const fs   = require('node:fs');
const path = require('node:path');

const CONFIG_PATH = path.resolve(__dirname, 'rig-config.json');

let state = { config: {}, version: 0, updatedAt: 0 };

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    state = {
      config:    j.config    || {},
      version:   j.version   || 0,
      updatedAt: j.updatedAt || 0,
    };
  } catch (e) {
    // first run — no file yet
  }
}

function save() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(state, null, 2));
}

function get() {
  return { config: { ...state.config }, version: state.version, updatedAt: state.updatedAt };
}

// Merge partial keys into existing config. Pass {key: null} to delete a key.
function update(partial) {
  if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
    throw new Error('config update body must be a JSON object');
  }
  const merged = { ...state.config };
  for (const k of Object.keys(partial)) {
    if (partial[k] === null) delete merged[k];
    else                     merged[k] = partial[k];
  }
  state.config    = merged;
  state.version  += 1;
  state.updatedAt = Date.now();
  save();
  return get();
}

// Wholesale replace.
function replace(full) {
  if (!full || typeof full !== 'object' || Array.isArray(full)) {
    throw new Error('config replace body must be a JSON object');
  }
  state.config    = { ...full };
  state.version  += 1;
  state.updatedAt = Date.now();
  save();
  return get();
}

load();

module.exports = { get, update, replace };

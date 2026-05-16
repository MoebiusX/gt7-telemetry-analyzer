// Top-500 cutoff store.
//
// Persisted in data/cutoff.json:
//   { time: "1:18.586", ms: 78586, source: "manual|scrape", driverName: "...", capturedAt: ISO }
//
// Updated either by:
//  - POST /cutoff?ms=78586&time=1%3A18.586&source=manual&driver=Driver-A
//  - background scraper attempting to parse the daily page (best-effort)

const fs   = require('node:fs');
const path = require('node:path');

const DATA_DIR    = path.resolve(__dirname, '..', '..', 'data');
const CUTOFF_FILE = path.join(DATA_DIR, 'cutoff.json');

function load() {
  try { return JSON.parse(fs.readFileSync(CUTOFF_FILE, 'utf8')); }
  catch { return null; }
}

function save(record) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CUTOFF_FILE, JSON.stringify(record, null, 2) + '\n');
  return record;
}

function ageHours() {
  const c = load();
  if (!c?.capturedAt) return null;
  return (Date.now() - new Date(c.capturedAt).getTime()) / 3_600_000;
}

// Parse a "1:18.586" → 78586ms; "78586" → 78586ms; "78.586" → 78586ms.
function parseTimeToMs(s) {
  if (typeof s === 'number') return s;
  s = String(s).trim();
  let m;
  if ((m = s.match(/^(\d+):(\d+)\.(\d{1,3})$/))) {
    const min = Number(m[1]), sec = Number(m[2]), frac = (m[3] + '000').slice(0,3);
    return min*60_000 + sec*1000 + Number(frac);
  }
  if ((m = s.match(/^(\d+)\.(\d{1,3})$/))) {
    return Number(m[1])*1000 + Number((m[2]+'000').slice(0,3));
  }
  if (/^\d+$/.test(s)) return Number(s);
  return null;
}

module.exports = { load, save, ageHours, parseTimeToMs, CUTOFF_FILE };

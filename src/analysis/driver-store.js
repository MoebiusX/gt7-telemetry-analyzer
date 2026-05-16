// Driver profile store.
//
// data/drivers.json    — list of driver profiles (label, color, etc.)
// data/active-driver.json  — { id } pointing at one of them
//
// Each recorded packet, going forward, is tagged with the active driver id
// via a 'driver' field on the JSONL line. Old recordings have no driver tag
// — they're treated as the default profile (Player 1) for backward compat.

const fs   = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.resolve(__dirname, '..', '..', 'data');
const DRIVERS_FILE = path.join(DATA_DIR, 'drivers.json');
const ACTIVE_FILE  = path.join(DATA_DIR, 'active-driver.json');

const DEFAULTS = [
  { id: 'player1', label: 'Player 1', psn: '', color: '#00d4ff', isDefault: true },
];

function ensure() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DRIVERS_FILE)) {
    fs.writeFileSync(DRIVERS_FILE, JSON.stringify(DEFAULTS, null, 2) + '\n');
  }
  if (!fs.existsSync(ACTIVE_FILE)) {
    fs.writeFileSync(ACTIVE_FILE, JSON.stringify({ id: 'player1' }, null, 2) + '\n');
  }
}

function listDrivers() {
  ensure();
  try { return JSON.parse(fs.readFileSync(DRIVERS_FILE, 'utf8')); }
  catch { return DEFAULTS; }
}

function getActive() {
  ensure();
  let activeId = 'player1';
  try { activeId = JSON.parse(fs.readFileSync(ACTIVE_FILE, 'utf8')).id || 'player1'; }
  catch {}
  const drivers = listDrivers();
  return drivers.find(d => d.id === activeId) || drivers[0];
}

function setActive(id) {
  ensure();
  const drivers = listDrivers();
  if (!drivers.find(d => d.id === id)) throw new Error(`unknown driver id: ${id}`);
  fs.writeFileSync(ACTIVE_FILE, JSON.stringify({ id }, null, 2) + '\n');
}

function addDriver({ id, label, psn, color }) {
  ensure();
  const drivers = listDrivers();
  if (drivers.find(d => d.id === id)) throw new Error(`driver id already exists: ${id}`);
  drivers.push({ id, label: label || id, psn: psn || '', color: color || '#ff9800' });
  fs.writeFileSync(DRIVERS_FILE, JSON.stringify(drivers, null, 2) + '\n');
}

function removeDriver(id) {
  ensure();
  let drivers = listDrivers();
  drivers = drivers.filter(d => d.id !== id);
  if (drivers.length === 0) drivers = DEFAULTS.slice();
  fs.writeFileSync(DRIVERS_FILE, JSON.stringify(drivers, null, 2) + '\n');
  // If we removed the active driver, switch to the first remaining
  const active = getActive();
  if (!drivers.find(d => d.id === active.id)) {
    setActive(drivers[0].id);
  }
}

module.exports = { listDrivers, getActive, setActive, addDriver, removeDriver };

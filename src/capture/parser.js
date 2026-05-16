// Parse a decrypted GT7 telemetry packet (296 bytes for "A" packets).
// Field layout reverse-engineered by the GT7 telemetry community
// (Nenkai, Bornhall, ddm, et al).

const PACKET_MAGIC = 0x47375330; // "0S7G" little-endian == "G7S0"

const FLAG_BITS = [
  'inRace', 'paused', 'loadingOrProcessing', 'inGear',
  'hasTurbo', 'revLimiterAlert', 'handBrakeActive', 'lights',
  'highBeam', 'lowBeam', 'asmActive', 'tcsActive',
];

function parse(buf) {
  if (buf.length < 0x128) return null;
  const magic = buf.readUInt32LE(0x00);
  if (magic !== PACKET_MAGIC) return null;

  const flags = buf.readUInt16LE(0x8E);
  const flagMap = {};
  for (let i = 0; i < FLAG_BITS.length; i++) {
    flagMap[FLAG_BITS[i]] = (flags & (1 << i)) !== 0;
  }

  const gearByte = buf.readUInt8(0x90);

  return {
    packetId:        buf.readInt32LE(0x70),
    lapCount:        buf.readInt16LE(0x74),
    lapsInRace:      buf.readInt16LE(0x76),
    bestLapTimeMs:   buf.readInt32LE(0x78),
    lastLapTimeMs:   buf.readInt32LE(0x7C),
    timeOfDayMs:     buf.readInt32LE(0x80),
    racePosition:    buf.readInt16LE(0x84),
    totalCars:       buf.readInt16LE(0x86),
    minRpmAlert:     buf.readInt16LE(0x88),
    maxRpmAlert:     buf.readInt16LE(0x8A),
    maxSpeedKph:     buf.readInt16LE(0x8C),

    flags:           flagMap,
    rawFlags:        flags,
    currentGear:     gearByte & 0x0F,
    suggestedGear:   (gearByte >> 4) & 0x0F,

    throttle:        buf.readUInt8(0x91),  // 0..255
    brake:           buf.readUInt8(0x92),  // 0..255

    position: {
      x: buf.readFloatLE(0x04),
      y: buf.readFloatLE(0x08),
      z: buf.readFloatLE(0x0C),
    },
    velocity: {
      x: buf.readFloatLE(0x10),
      y: buf.readFloatLE(0x14),
      z: buf.readFloatLE(0x18),
    },
    rotation: {
      pitch: buf.readFloatLE(0x1C),
      yaw:   buf.readFloatLE(0x20),
      roll:  buf.readFloatLE(0x24),
    },
    headingRelativeToNorth: buf.readFloatLE(0x28),
    angularVelocity: {
      x: buf.readFloatLE(0x2C),
      y: buf.readFloatLE(0x30),
      z: buf.readFloatLE(0x34),
    },
    rideHeight:      buf.readFloatLE(0x38),
    engineRpm:       buf.readFloatLE(0x3C),
    fuelLevel:       buf.readFloatLE(0x44),
    fuelCapacity:    buf.readFloatLE(0x48),
    speedMps:        buf.readFloatLE(0x4C),
    speedKph:        buf.readFloatLE(0x4C) * 3.6,
    boostBar:        buf.readFloatLE(0x50) - 1.0, // raw is absolute pressure (bar)
    oilPressure:     buf.readFloatLE(0x54),
    waterTempC:      buf.readFloatLE(0x58),
    oilTempC:        buf.readFloatLE(0x5C),
    tireTempC: {
      fl: buf.readFloatLE(0x60),
      fr: buf.readFloatLE(0x64),
      rl: buf.readFloatLE(0x68),
      rr: buf.readFloatLE(0x6C),
    },

    roadPlane: {
      x: buf.readFloatLE(0x94),
      y: buf.readFloatLE(0x98),
      z: buf.readFloatLE(0x9C),
      distance: buf.readFloatLE(0xA0),
    },
    wheelRpsRad: {
      fl: buf.readFloatLE(0xA4),
      fr: buf.readFloatLE(0xA8),
      rl: buf.readFloatLE(0xAC),
      rr: buf.readFloatLE(0xB0),
    },
    tireRadius: {
      fl: buf.readFloatLE(0xB4),
      fr: buf.readFloatLE(0xB8),
      rl: buf.readFloatLE(0xBC),
      rr: buf.readFloatLE(0xC0),
    },
    suspensionHeight: {
      fl: buf.readFloatLE(0xC4),
      fr: buf.readFloatLE(0xC8),
      rl: buf.readFloatLE(0xCC),
      rr: buf.readFloatLE(0xD0),
    },

    clutchPedal:           buf.readFloatLE(0xF4),
    clutchEngagement:      buf.readFloatLE(0xF8),
    rpmAfterClutch:        buf.readFloatLE(0xFC),
    transmissionTopSpeed:  buf.readFloatLE(0x100),

    gearRatios: [
      buf.readFloatLE(0x104),
      buf.readFloatLE(0x108),
      buf.readFloatLE(0x10C),
      buf.readFloatLE(0x110),
      buf.readFloatLE(0x114),
      buf.readFloatLE(0x118),
      buf.readFloatLE(0x11C),
      buf.readFloatLE(0x120),
    ],
    carCode:               buf.readInt32LE(0x124),
  };
}

function formatLapTime(ms) {
  if (!ms || ms < 0) return '--:--.---';
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  return `${m}:${String(s).padStart(2, '0')}.${String(r).padStart(3, '0')}`;
}

module.exports = { parse, formatLapTime, PACKET_MAGIC };

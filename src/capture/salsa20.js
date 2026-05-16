// Minimal Salsa20 stream cipher (D. J. Bernstein).
// Sufficient for decrypting GT7 telemetry packets — no external crypto deps.

function rotl(a, b) {
  return (((a << b) | (a >>> (32 - b))) >>> 0);
}

function readU32LE(buf, off) {
  return ((buf[off]) | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}

function writeU32LE(buf, off, v) {
  buf[off]     = v & 0xff;
  buf[off + 1] = (v >>> 8) & 0xff;
  buf[off + 2] = (v >>> 16) & 0xff;
  buf[off + 3] = (v >>> 24) & 0xff;
}

function quarterRound(x, a, b, c, d) {
  x[b] = (x[b] ^ rotl((x[a] + x[d]) >>> 0, 7)) >>> 0;
  x[c] = (x[c] ^ rotl((x[b] + x[a]) >>> 0, 9)) >>> 0;
  x[d] = (x[d] ^ rotl((x[c] + x[b]) >>> 0, 13)) >>> 0;
  x[a] = (x[a] ^ rotl((x[d] + x[c]) >>> 0, 18)) >>> 0;
}

function salsa20Block(state) {
  const x = new Uint32Array(state);
  for (let i = 0; i < 10; i++) {
    quarterRound(x, 0, 4, 8, 12);
    quarterRound(x, 5, 9, 13, 1);
    quarterRound(x, 10, 14, 2, 6);
    quarterRound(x, 15, 3, 7, 11);
    quarterRound(x, 0, 1, 2, 3);
    quarterRound(x, 5, 6, 7, 4);
    quarterRound(x, 10, 11, 8, 9);
    quarterRound(x, 15, 12, 13, 14);
  }
  for (let i = 0; i < 16; i++) x[i] = (x[i] + state[i]) >>> 0;
  return x;
}

const SIGMA = Buffer.from('expand 32-byte k', 'ascii');

function buildState(key, nonce) {
  if (key.length !== 32) throw new Error('Salsa20 key must be 32 bytes');
  if (nonce.length !== 8) throw new Error('Salsa20 nonce must be 8 bytes');
  const s = new Uint32Array(16);
  s[0]  = readU32LE(SIGMA, 0);
  s[5]  = readU32LE(SIGMA, 4);
  s[10] = readU32LE(SIGMA, 8);
  s[15] = readU32LE(SIGMA, 12);
  for (let i = 0; i < 4; i++) s[1 + i]  = readU32LE(key, i * 4);
  for (let i = 0; i < 4; i++) s[11 + i] = readU32LE(key, 16 + i * 4);
  s[6] = readU32LE(nonce, 0);
  s[7] = readU32LE(nonce, 4);
  s[8] = 0;
  s[9] = 0;
  return s;
}

function decrypt(key, nonce, data) {
  const state = buildState(key, nonce);
  const out = Buffer.alloc(data.length);
  const ks  = Buffer.alloc(64);
  let counterLo = 0, counterHi = 0;
  for (let off = 0; off < data.length; off += 64) {
    state[8] = counterLo;
    state[9] = counterHi;
    const block = salsa20Block(state);
    for (let i = 0; i < 16; i++) writeU32LE(ks, i * 4, block[i]);
    const n = Math.min(64, data.length - off);
    for (let i = 0; i < n; i++) out[off + i] = data[off + i] ^ ks[i];
    counterLo = (counterLo + 1) >>> 0;
    if (counterLo === 0) counterHi = (counterHi + 1) >>> 0;
  }
  return out;
}

module.exports = { decrypt };

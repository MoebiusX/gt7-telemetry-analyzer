// Validate Salsa20 against the official ECRYPT test vector (Set 1, vector 0).
// Key = 0x80 then 31 zero bytes, IV = 8 zero bytes, plaintext = 64 zero bytes.
// Expected first 64 bytes of keystream documented by D. J. Bernstein.

const { decrypt } = require('../src/capture/salsa20');

const key   = Buffer.alloc(32); key[0] = 0x80;
const nonce = Buffer.alloc(8);
const zeros = Buffer.alloc(64);

const out = decrypt(key, nonce, zeros).toString('hex').toUpperCase();
const expected =
  'E3BE8FDD8BECA2E3EA8EF9475B29A6E7' +
  '003951E1097A5C38D23B7A5FAD9F6844' +
  'B22C97559E2723C7CBBD3FE4FC8D9A07' +
  '44652A83E72A9C461876AF4D7EF1A117';

if (out !== expected) {
  console.error('FAIL\n got:      ' + out + '\n expected: ' + expected);
  process.exit(1);
}
console.log('Salsa20 OK');

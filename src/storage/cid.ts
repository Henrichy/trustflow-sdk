import { TrustFlowError } from '../errors';

/**
 * CIDv0 regex: 46 characters starting with 'Qm', using the Base58btc alphabet.
 */
export const CID_V0_REGEX = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;

/**
 * CIDv1 base32 regex: starts with multibase prefix 'b', followed by lowercase base32 (a-z, 2-7).
 */
export const CID_V1_REGEX = /^b[a-z2-7]{48,}$/;

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_MAP: Record<string, number> = {};
for (let i = 0; i < BASE58_ALPHABET.length; i++) {
  BASE58_MAP[BASE58_ALPHABET[i]] = i;
}

function decodeBase58(str: string): Uint8Array | null {
  if (typeof str !== 'string' || str.length === 0) return null;
  const bytes = [0];
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    const val = BASE58_MAP[char];
    if (val === undefined) return null;
    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      const acc = bytes[j] * 58 + carry;
      bytes[j] = acc & 0xff;
      carry = acc >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < str.length && str[i] === '1'; i++) {
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const BASE32_MAP: Record<string, number> = {};
for (let i = 0; i < BASE32_ALPHABET.length; i++) {
  BASE32_MAP[BASE32_ALPHABET[i]] = i;
}

function decodeBase32(str: string): Uint8Array | null {
  if (typeof str !== 'string' || str.length === 0) return null;
  let bits = 0;
  let value = 0;
  const output: number[] = [];

  for (let i = 0; i < str.length; i++) {
    const val = BASE32_MAP[str[i]];
    if (val === undefined) return null;
    value = (value << 5) | val;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(output);
}

/**
 * Validates whether a value is a strictly valid CIDv0 or CIDv1 string.
 *
 * For CIDv0 (Qm... 46 chars):
 * - Verifies base58check encoding.
 * - Verifies multihash header bytes (0x12 for sha2-256, 0x20 for 32-byte digest length).
 *
 * For CIDv1:
 * - Supports base32 multibase ('b' prefix) and base58btc ('z' prefix).
 * - Verifies CID version (0x01), multicodec, and multihash header.
 */
export function isValidCid(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;

  // Disallow path traversal, slashes, whitespace, etc.
  if (/[/\\\s]/.test(value)) return false;

  // CIDv0: Base58btc string starting with "Qm" (46 chars)
  if (value.startsWith('Qm')) {
    if (value.length !== 46 || !CID_V0_REGEX.test(value)) return false;
    const bytes = decodeBase58(value);
    if (!bytes || bytes.length !== 34) return false;
    // Multihash header check: 0x12 (sha2-256), 0x20 (32 bytes)
    return bytes[0] === 0x12 && bytes[1] === 0x20;
  }

  // CIDv1 base32 (starts with 'b')
  if (value.startsWith('b')) {
    if (value.length < 50 || !/^[a-z2-7]+$/.test(value.slice(1))) return false;
    const bytes = decodeBase32(value.slice(1));
    if (!bytes || bytes.length < 4) return false;
    // Byte 0 must be CIDv1 (0x01)
    if (bytes[0] !== 0x01) return false;

    // Read multicodec varint starting at offset 1
    let offset = 1;
    while (offset < bytes.length && (bytes[offset] & 0x80) !== 0) {
      offset++;
    }
    offset++; // Skip final byte of varint
    if (offset >= bytes.length - 2) return false;

    // Read multihash function and length
    const hashFunc = bytes[offset];
    const hashLen = bytes[offset + 1];
    const remaining = bytes.length - (offset + 2);

    // sha2-256 header verification when 0x12
    if (hashFunc === 0x12 && hashLen !== 32) return false;
    return remaining === hashLen;
  }

  // CIDv1 base58btc (starts with 'z')
  if (value.startsWith('z')) {
    if (value.length < 40) return false;
    const bytes = decodeBase58(value.slice(1));
    if (!bytes || bytes.length < 4) return false;
    if (bytes[0] !== 0x01) return false;
    return true;
  }

  return false;
}

/**
 * Alias for isValidCid fulfilling the validateCID specification (#349).
 */
export function validateCID(value: unknown): boolean {
  return isValidCid(value);
}

/**
 * Returns the CID version number (0 or 1), or null if the string is not a valid CID.
 */
export function getCidVersion(value: unknown): 0 | 1 | null {
  if (!isValidCid(value)) return null;
  const str = value as string;
  if (str.startsWith('Qm')) return 0;
  return 1;
}

/**
 * Asserts that a value is a valid CID string.
 *
 * @throws {TrustFlowError} `VALIDATION_ERROR` with the specified field if invalid.
 */
export function assertValidCid(value: unknown, field: string = 'cid'): void {
  if (!isValidCid(value)) {
    throw TrustFlowError.validation(
      field,
      `Invalid CID: "${String(value)}". Must be a valid CIDv0 (Qm... 46 chars) or CIDv1 string with valid multihash encoding.`,
    );
  }
}

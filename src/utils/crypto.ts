import { TrustFlowError } from '../errors';

/**
 * Generates cryptographically secure random bytes with automatic WebCrypto detection
 * and Node.js crypto fallback.
 *
 * @param length - Number of random bytes to generate
 * @returns Uint8Array of secure random bytes
 */
export function randomBytes(length: number): Uint8Array {
  if (length <= 0) return new Uint8Array(0);

  // 1. Check for standard WebCrypto API (Browsers, Cloudflare Workers, Node.js 19+)
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.getRandomValues) {
    const buffer = new Uint8Array(length);
    globalThis.crypto.getRandomValues(buffer);
    return buffer;
  }

  // 2. Fallback to Node.js crypto module if available
  try {
    const modName = 'crypto';
    // Dynamic lookup avoids bundlers attempting to package Node's crypto into browser builds
    const req = typeof require !== 'undefined' ? require : undefined;
    const nodeCrypto = req ? req(modName) : undefined;
    if (typeof nodeCrypto?.randomBytes === 'function') {
      return new Uint8Array(nodeCrypto.randomBytes(length));
    }
  } catch {
    // Ignore require error if not in Node
  }

  throw new TrustFlowError(
    'No cryptographically secure random number generator is available in this environment',
    'AUTH_ERROR',
  );
}

/**
 * Generates a random hexadecimal string.
 *
 * @param byteLength - Number of random bytes (resulting hex string will be 2x this length)
 */
export function randomHex(byteLength: number): string {
  const bytes = randomBytes(byteLength);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Generates a random alphanumeric nonce string.
 *
 * @param length - Length of the nonce (default: 32)
 */
export function randomNonce(length = 32): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

/**
 * Generates an RFC 4122 v4 compliant UUID using secure random bytes.
 */
export function randomUUID(): string {
  if (typeof globalThis !== 'undefined' && typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  const bytes = randomBytes(16);
  // Set version to 0100 (v4)
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  // Set variant to 10xx (RFC 4122)
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  let hex = '';
  for (let i = 0; i < 16; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

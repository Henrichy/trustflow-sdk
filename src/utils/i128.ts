// Precision-safe i128/u128 <-> native (bigint) conversion layer (#67).
//
// `@stellar/stellar-sdk`'s `nativeToScVal`/`scValToNative` already handle
// i128/u128 XDR encoding, but accept/return plain `number` in places,
// which silently loses precision above `Number.MAX_SAFE_INTEGER` (any
// token amount beyond ~9e15 stroops). This module wraps them with an
// explicit bigint-first API plus range/rounding guards so a caller can
// never round-trip a value through XDR and get a different number back.

import { scValToNative, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { TrustFlowError } from '../errors';

export const I128_MIN = -(2n ** 127n);
export const I128_MAX = 2n ** 127n - 1n;
export const U128_MIN = 0n;
export const U128_MAX = 2n ** 128n - 1n;

/** Accepted native inputs. `number` is only safe within `Number.MAX_SAFE_INTEGER`. */
export type Int128Like = bigint | number | string;

function normalizeToBigInt(value: Int128Like, min: bigint, max: bigint, label: string): bigint {
  if (typeof value === 'bigint') {
    assertInRange(value, min, max, label);
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new TrustFlowError(
        `i128/u128 conversion is lossless-only: ${value} is not an integer`,
        'INVALID_AMOUNT',
      );
    }
    if (!Number.isSafeInteger(value)) {
      throw new TrustFlowError(
        `${value} exceeds Number.MAX_SAFE_INTEGER; pass a bigint or numeric string instead`,
        'INVALID_AMOUNT',
      );
    }
    assertInRange(value, min, max, label);
    return BigInt(value);
  }

  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw new TrustFlowError(`"${value}" is not a valid base-10 integer string`, 'INVALID_AMOUNT');
  }
  // Compare canonical decimal magnitudes before parsing, including leading/negative zeros.
  const negative = value.startsWith('-');
  const digits = (negative ? value.slice(1) : value).replace(/^0+/, '') || '0';
  const limit = (negative ? -min : max).toString();
  if (digits.length > limit.length || (digits.length === limit.length && digits > limit)) {
    throw new TrustFlowError(
      `${label} amount ${value} is outside [${min}, ${max}]; pass an integer within this range`,
      'INVALID_AMOUNT',
    );
  }
  return BigInt(value);
}

function assertInRange(value: bigint | number, min: bigint, max: bigint, label: string): void {
  if (value < min || value > max) {
    throw new TrustFlowError(
      `${label} amount ${value} is outside [${min}, ${max}]; pass an integer within this range`,
      'INVALID_AMOUNT',
    );
  }
}

/**
 * Converts a native value to a signed 128-bit `xdr.ScVal`, guarding sign/overflow.
 * @param value - Integer stroops; use bigint or a decimal string beyond safe-number precision.
 * @returns A signed ScVal preserving the input exactly, including valid negative values.
 * @throws {TrustFlowError} `INVALID_AMOUNT` for malformed, unsafe or out-of-range input.
 */
export function toI128ScVal(value: Int128Like): xdr.ScVal {
  const big = normalizeToBigInt(value, I128_MIN, I128_MAX, 'i128');
  return nativeToScVal(big, { type: 'i128' });
}

/**
 * Converts a native value to an unsigned 128-bit `xdr.ScVal`, guarding sign/overflow.
 * @param value - Nonnegative integer stroops; use bigint or a decimal string beyond safe precision.
 * @returns An unsigned ScVal preserving the input exactly.
 * @throws {TrustFlowError} `INVALID_AMOUNT` for malformed, unsafe, negative or overflowing input.
 */
export function toU128ScVal(value: Int128Like): xdr.ScVal {
  const big = normalizeToBigInt(value, U128_MIN, U128_MAX, 'u128');
  return nativeToScVal(big, { type: 'u128' });
}

/** Decodes a signed 128-bit `xdr.ScVal` back to a `bigint`, guarding range. */
export function fromI128ScVal(scVal: xdr.ScVal): bigint {
  const native = scValToNative(scVal);
  const big = typeof native === 'bigint' ? native : BigInt(native as number | string);
  assertInRange(big, I128_MIN, I128_MAX, 'i128');
  return big;
}

/** Decodes an unsigned 128-bit `xdr.ScVal` back to a `bigint`, guarding range. */
export function fromU128ScVal(scVal: xdr.ScVal): bigint {
  const native = scValToNative(scVal);
  const big = typeof native === 'bigint' ? native : BigInt(native as number | string);
  assertInRange(big, U128_MIN, U128_MAX, 'u128');
  return big;
}

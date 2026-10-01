// Precision-safe i128/u128 <-> native (bigint) conversion layer (#67).
//
// `@stellar/stellar-sdk`'s `nativeToScVal`/`scValToNative` already handle
// i128/u128 XDR encoding, but accept/return plain `number` in places,
// which silently loses precision above `Number.MAX_SAFE_INTEGER` (any
// token amount beyond ~9e15 stroops). This module wraps them with an
// explicit bigint-first API plus range/rounding guards so a caller can
// never round-trip a value through XDR and get a different number back.

import { scValToNative, nativeToScVal, xdr } from '@stellar/stellar-sdk';

export const I128_MIN = -(2n ** 127n);
export const I128_MAX = 2n ** 127n - 1n;
export const U128_MIN = 0n;
export const U128_MAX = 2n ** 128n - 1n;

/** Accepted native inputs. `number` is only safe within `Number.MAX_SAFE_INTEGER`. */
export type Int128Like = bigint | number | string;

function normalizeToBigInt(value: Int128Like): bigint {
  if (typeof value === 'bigint') return value;

  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new RangeError(`i128/u128 conversion is lossless-only: ${value} is not an integer`);
    }
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(
        `${value} exceeds Number.MAX_SAFE_INTEGER; pass a bigint or numeric string instead`,
      );
    }
    return BigInt(value);
  }

  if (!/^-?\d+$/.test(value)) {
    throw new RangeError(`"${value}" is not a valid base-10 integer string`);
  }
  return BigInt(value);
}

function assertInRange(value: bigint, min: bigint, max: bigint, label: string): void {
  if (value < min || value > max) {
    throw new RangeError(`${label} overflow: ${value} is outside [${min}, ${max}]`);
  }
}

/** Converts a native value to a signed 128-bit `xdr.ScVal`, guarding sign/overflow. */
export function toI128ScVal(value: Int128Like): xdr.ScVal {
  const big = normalizeToBigInt(value);
  assertInRange(big, I128_MIN, I128_MAX, 'i128');
  return nativeToScVal(big, { type: 'i128' });
}

/** Converts a native value to an unsigned 128-bit `xdr.ScVal`, guarding sign/overflow. */
export function toU128ScVal(value: Int128Like): xdr.ScVal {
  const big = normalizeToBigInt(value);
  assertInRange(big, U128_MIN, U128_MAX, 'u128');
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

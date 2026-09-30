import { xdr } from '@stellar/stellar-sdk';
import {
  toI128ScVal,
  toU128ScVal,
  fromI128ScVal,
  fromU128ScVal,
  I128_MIN,
  I128_MAX,
  U128_MIN,
  U128_MAX,
} from '../src/utils/i128';

/** Round-trips a value through actual XDR bytes, not just the in-memory ScVal. */
function roundTripXdr(scVal: xdr.ScVal): xdr.ScVal {
  return xdr.ScVal.fromXDR(scVal.toXDR());
}

describe('i128/u128 conversion layer', () => {
  it('round-trips i128 boundary and typical values losslessly through XDR', () => {
    for (const value of [0n, 1n, -1n, 123456789012345678901234567890n, I128_MIN, I128_MAX]) {
      const scVal = toI128ScVal(value);
      const decoded = fromI128ScVal(roundTripXdr(scVal));
      expect(decoded).toBe(value);
    }
  });

  it('round-trips u128 boundary and typical values losslessly through XDR', () => {
    for (const value of [0n, 1n, 340282366920938463463374607431768211455n, U128_MIN, U128_MAX]) {
      const scVal = toU128ScVal(value);
      const decoded = fromU128ScVal(roundTripXdr(scVal));
      expect(decoded).toBe(value);
    }
  });

  it('accepts safe-integer numbers and numeric strings, converting to the same bigint', () => {
    expect(fromI128ScVal(roundTripXdr(toI128ScVal(42)))).toBe(42n);
    expect(fromI128ScVal(roundTripXdr(toI128ScVal('42')))).toBe(42n);
    expect(fromI128ScVal(roundTripXdr(toI128ScVal(-42)))).toBe(-42n);
  });

  it('rejects i128 overflow in both directions', () => {
    expect(() => toI128ScVal(I128_MAX + 1n)).toThrow(RangeError);
    expect(() => toI128ScVal(I128_MIN - 1n)).toThrow(RangeError);
  });

  it('rejects negative values for u128', () => {
    expect(() => toU128ScVal(-1n)).toThrow(RangeError);
  });

  it('rejects non-integer numbers (no silent rounding)', () => {
    expect(() => toI128ScVal(1.5)).toThrow(RangeError);
  });

  it('rejects numbers beyond Number.MAX_SAFE_INTEGER', () => {
    expect(() => toI128ScVal(Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError);
  });

  it('rejects malformed numeric strings', () => {
    expect(() => toI128ScVal('12.3')).toThrow(RangeError);
    expect(() => toI128ScVal('abc')).toThrow(RangeError);
  });
});

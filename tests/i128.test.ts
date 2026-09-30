import { xdr } from '@stellar/stellar-sdk';
import { TrustFlowError } from '../src/errors';
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
  it.each([0n, 1n, -1n, 123456789012345678901234567890n, I128_MIN, I128_MAX])(
    'round-trips signed %s losslessly through XDR',
    (value) => {
      const scVal = toI128ScVal(value);
      const decoded = fromI128ScVal(roundTripXdr(scVal));
      expect(decoded).toBe(value);
      expect(fromI128ScVal(roundTripXdr(toI128ScVal(value.toString())))).toBe(value);
    },
  );

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
    expect(() => toI128ScVal(I128_MAX + 1n)).toThrow(TrustFlowError);
    expect(() => toI128ScVal(I128_MIN - 1n)).toThrow(TrustFlowError);
  });

  it('rejects negative values for u128', () => {
    expect(() => toU128ScVal(-1n)).toThrow(TrustFlowError);
  });

  it('rejects non-integer numbers (no silent rounding)', () => {
    expect(() => toI128ScVal(1.5)).toThrow(TrustFlowError);
  });

  it('rejects numbers beyond Number.MAX_SAFE_INTEGER', () => {
    expect(() => toI128ScVal(Number.MAX_SAFE_INTEGER + 2)).toThrow(TrustFlowError);
  });

  it('rejects malformed numeric strings', () => {
    expect(() => toI128ScVal('12.3')).toThrow(TrustFlowError);
    expect(() => toI128ScVal('abc')).toThrow(TrustFlowError);
  });

  describe.each([
    ['i128', toI128ScVal, I128_MIN, I128_MAX],
    ['u128', toU128ScVal, U128_MIN, U128_MAX],
  ] as const)('%s validation', (label, encode, min, max) => {
    it.each([1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '', 'abc', '12.3'])(
      'rejects invalid input %s with INVALID_AMOUNT',
      (value) => {
        expect(() => encode(value)).toThrow(TrustFlowError);
        expect(() => encode(value)).toThrow(expect.objectContaining({ code: 'INVALID_AMOUNT' }));
      },
    );

    it.each([min - 1n, max + 1n])('rejects out-of-bounds %s in every representation', (value) => {
      for (const input of [value, value.toString(), Number(value)]) {
        expect(() => encode(input)).toThrow(TrustFlowError);
        expect(() => encode(input)).toThrow(expect.objectContaining({ code: 'INVALID_AMOUNT' }));
      }
      expect(() => encode(value)).toThrow(`${label} amount ${value} is outside [${min}, ${max}]`);
      expect(() => encode(value.toString())).toThrow(`outside [${min}, ${max}]`);
    });
  });

  it.each([-1n, -1, '-1', I128_MIN])('rejects unsigned negative %s', (value) => {
    expect(() => toU128ScVal(value)).toThrow(expect.objectContaining({ code: 'INVALID_AMOUNT' }));
  });

  it('accepts leading zeros, negative zero and safe-number boundaries losslessly', () => {
    for (const value of [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0, -1]) {
      expect(fromI128ScVal(roundTripXdr(toI128ScVal(value)))).toBe(BigInt(value));
    }
    expect(fromI128ScVal(roundTripXdr(toI128ScVal(`000${I128_MAX}`)))).toBe(I128_MAX);
    expect(fromI128ScVal(roundTripXdr(toI128ScVal(`-000${-I128_MIN}`)))).toBe(I128_MIN);
    expect(fromU128ScVal(roundTripXdr(toU128ScVal(`000${U128_MAX}`)))).toBe(U128_MAX);
    expect(fromU128ScVal(roundTripXdr(toU128ScVal('-000')))).toBe(0n);
  });
});

import * as fc from 'fast-check';
import {
  toI128ScVal,
  toU128ScVal,
  fromI128ScVal,
  fromU128ScVal,
  I128_MIN,
  I128_MAX,
  U128_MIN,
  U128_MAX
} from './i128';

describe('i128 and u128 conversion utilities (Property-based tests)', () => {
  it('should roundtrip i128 values correctly', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: I128_MIN, max: I128_MAX }), (val) => {
        const scVal = toI128ScVal(val);
        const result = fromI128ScVal(scVal);
        expect(result).toBe(val);
      }),
      { numRuns: 10000 }
    );
  });

  it('should roundtrip u128 values correctly', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: U128_MIN, max: U128_MAX }), (val) => {
        const scVal = toU128ScVal(val);
        const result = fromU128ScVal(scVal);
        expect(result).toBe(val);
      }),
      { numRuns: 10000 }
    );
  });

  it('should roundtrip numeric safe i128 values correctly', () => {
    fc.assert(
      fc.property(fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }), (val) => {
        const scVal = toI128ScVal(val);
        const result = fromI128ScVal(scVal);
        expect(result).toBe(BigInt(val));
      }),
      { numRuns: 10000 }
    );
  });

  it('should throw on out of bounds i128 values', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.bigInt({ min: I128_MAX + 1n }),
          fc.bigInt({ max: I128_MIN - 1n })
        ),
        (val) => {
          expect(() => toI128ScVal(val)).toThrow(RangeError);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should throw on out of bounds u128 values', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.bigInt({ min: U128_MAX + 1n }),
          fc.bigInt({ max: U128_MIN - 1n })
        ),
        (val) => {
          expect(() => toU128ScVal(val)).toThrow(RangeError);
        }
      ),
      { numRuns: 100 }
    );
  });
});

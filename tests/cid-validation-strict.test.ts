import {
  isValidCid,
  validateCID,
  getCidVersion,
  assertValidCid,
} from '../src/storage/cid';
import { TrustFlowError } from '../src/errors';

describe('Strict CIDv0 and CIDv1 validation - Issue #349', () => {
  // Valid test vectors
  // CIDv0: Base58btc, 46 characters, starts with Qm, sha2-256 multihash (0x12 0x20)
  const validCIDv0_1 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
  const validCIDv0_2 = 'QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco';
  const validCIDv0_3 = 'QmaozNR7DZHQK1ZcU9p7QdrshMvXqWK6gpu5rmrkLvo3Ez';

  // CIDv1: Base32, starts with bafy (raw or dag-pb with sha2-256)
  const validCIDv1_1 = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
  const validCIDv1_2 = 'bafybeicg2abbgahdnon3bf2kf72qqb3b456za5xfaezkeq4hn463xy5t24';
  const validCIDv1_base58 = 'zdj7Wn9FqaYvNfm9Zkp4eH84V33b2tNn918k6Qd2d2Ld2F1bA';

  describe('CIDv0 validation (Base58btc + sha2-256 header)', () => {
    it('accepts strictly valid CIDv0 strings', () => {
      expect(isValidCid(validCIDv0_1)).toBe(true);
      expect(validateCID(validCIDv0_1)).toBe(true);
      expect(getCidVersion(validCIDv0_1)).toBe(0);

      expect(isValidCid(validCIDv0_2)).toBe(true);
      expect(validateCID(validCIDv0_2)).toBe(true);
      expect(getCidVersion(validCIDv0_2)).toBe(0);

      expect(isValidCid(validCIDv0_3)).toBe(true);
      expect(validateCID(validCIDv0_3)).toBe(true);
      expect(getCidVersion(validCIDv0_3)).toBe(0);
    });

    it('rejects CIDv0 strings that do not start with Qm', () => {
      const notQm = '1mYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
      expect(isValidCid(notQm)).toBe(false);
      expect(validateCID(notQm)).toBe(false);
      expect(getCidVersion(notQm)).toBeNull();
    });

    it('rejects CIDv0 strings with invalid length', () => {
      // 45 chars
      expect(isValidCid(validCIDv0_1.slice(0, 45))).toBe(false);
      // 47 chars
      expect(isValidCid(validCIDv0_1 + 'a')).toBe(false);
    });

    it('rejects CIDv0 strings containing non-base58 characters (0, O, I, l)', () => {
      const with0 = validCIDv0_1.slice(0, 10) + '0' + validCIDv0_1.slice(11);
      const withO = validCIDv0_1.slice(0, 10) + 'O' + validCIDv0_1.slice(11);
      const withI = validCIDv0_1.slice(0, 10) + 'I' + validCIDv0_1.slice(11);
      const with_l = validCIDv0_1.slice(0, 10) + 'l' + validCIDv0_1.slice(11);

      expect(isValidCid(with0)).toBe(false);
      expect(isValidCid(withO)).toBe(false);
      expect(isValidCid(withI)).toBe(false);
      expect(isValidCid(with_l)).toBe(false);
    });

    it('rejects CIDv0 strings with spoofed/invalid multihash header (not 0x12 0x20)', () => {
      // 46 char base58 string starting with Qm, but decoding to invalid multihash header
      const spoofed = 'Qm' + '1'.repeat(44);
      expect(isValidCid(spoofed)).toBe(false);
      expect(validateCID(spoofed)).toBe(false);
    });
  });

  describe('CIDv1 validation (Base32 multibase + multihash header)', () => {
    it('accepts strictly valid CIDv1 base32 strings', () => {
      expect(isValidCid(validCIDv1_1)).toBe(true);
      expect(validateCID(validCIDv1_1)).toBe(true);
      expect(getCidVersion(validCIDv1_1)).toBe(1);

      expect(isValidCid(validCIDv1_2)).toBe(true);
      expect(validateCID(validCIDv1_2)).toBe(true);
      expect(getCidVersion(validCIDv1_2)).toBe(1);
    });

    it('accepts valid CIDv1 base58btc string', () => {
      expect(isValidCid(validCIDv1_base58)).toBe(true);
      expect(validateCID(validCIDv1_base58)).toBe(true);
      expect(getCidVersion(validCIDv1_base58)).toBe(1);
    });

    it('rejects CIDv1 strings with invalid characters (e.g. uppercase, 8, 9, 0, 1 in base32)', () => {
      const withUppercase = validCIDv1_1.toUpperCase();
      const with8 = validCIDv1_1.slice(0, 10) + '8' + validCIDv1_1.slice(11);
      const with9 = validCIDv1_1.slice(0, 10) + '9' + validCIDv1_1.slice(11);
      const with0 = validCIDv1_1.slice(0, 10) + '0' + validCIDv1_1.slice(11);
      const with1 = validCIDv1_1.slice(0, 10) + '1' + validCIDv1_1.slice(11);

      expect(isValidCid(withUppercase)).toBe(false);
      expect(isValidCid(with8)).toBe(false);
      expect(isValidCid(with9)).toBe(false);
      expect(isValidCid(with0)).toBe(false);
      expect(isValidCid(with1)).toBe(false);
    });

    it('rejects CIDv1 strings that are too short to contain version and multihash', () => {
      expect(isValidCid('bafy')).toBe(false);
      expect(isValidCid('bafy123')).toBe(false);
      expect(isValidCid('bafyshortstring')).toBe(false);
    });

    it('rejects CIDv1 with invalid multihash digest length', () => {
      // Create a base32 string starting with bafy but corrupting the multihash
      const corrupt = 'bafy' + 'a'.repeat(55);
      expect(isValidCid(corrupt)).toBe(false);
    });
  });

  describe('Security and edge cases', () => {
    it('rejects path traversal and directory separators', () => {
      expect(isValidCid(`../${validCIDv0_1}`)).toBe(false);
      expect(isValidCid(`..\\${validCIDv0_1}`)).toBe(false);
      expect(isValidCid(`${validCIDv1_1}/index.html`)).toBe(false);
      expect(isValidCid(`ipfs://${validCIDv1_1}`)).toBe(false);
    });

    it('rejects leading/trailing whitespace and control characters', () => {
      expect(isValidCid(` ${validCIDv0_1} `)).toBe(false);
      expect(isValidCid(`\n${validCIDv1_1}`)).toBe(false);
      expect(isValidCid(`\t${validCIDv0_1}\t`)).toBe(false);
    });

    it('rejects non-string inputs and empty strings', () => {
      expect(isValidCid('')).toBe(false);
      expect(isValidCid(null)).toBe(false);
      expect(isValidCid(undefined)).toBe(false);
      expect(isValidCid(12345)).toBe(false);
      expect(isValidCid({})).toBe(false);
      expect(isValidCid([])).toBe(false);
    });

    it('assertValidCid passes for valid CIDs and throws TrustFlowError for invalid', () => {
      expect(() => assertValidCid(validCIDv0_1, 'contractMetadata')).not.toThrow();
      expect(() => assertValidCid(validCIDv1_1, 'disputeEvidence')).not.toThrow();

      try {
        assertValidCid('invalid-cid', 'evidenceHash');
        fail('should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(TrustFlowError);
        expect(err.code).toBe('VALIDATION_ERROR');
        expect(err.field).toBe('evidenceHash');
        expect(err.message).toContain('evidenceHash');
      }
    });
  });
});

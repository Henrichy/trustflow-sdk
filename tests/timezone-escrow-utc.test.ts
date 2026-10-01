import { Keypair } from '@stellar/stellar-sdk';
import {
  normalizeToUtcSeconds,
  validateFutureExpiration,
  normalizeMilestoneExpiration,
} from '../src/utils/timezone';
import { createEscrow } from '../src/escrow/create';
import { invokeContract } from '../src/contract/invoke';
import { TrustFlowError } from '../src/errors';
import type { TrustFlowClient } from '../src/client';
import type { CreateEscrowParams } from '../src/types';
import { ESCROW_MIN_AMOUNT_STROOPS } from '../src/constants';

jest.mock('../src/contract/invoke', () => ({
  invokeContract: jest.fn(),
}));

describe('Timezone and UTC deadline handling - Issue #358', () => {
  const mockInvoke = invokeContract as jest.Mock;
  const SENDER = Keypair.random().publicKey();
  const RECIPIENT = Keypair.random().publicKey();
  const client = { contractId: 'CONTRACT123' } as TrustFlowClient;

  beforeEach(() => {
    jest.clearAllMocks();
    mockInvoke.mockResolvedValue({ success: true });
  });

  describe('normalizeToUtcSeconds', () => {
    it('normalizes Date objects to UTC epoch seconds', () => {
      const date = new Date('2026-10-15T12:30:45.000Z');
      const seconds = normalizeToUtcSeconds(date);
      expect(seconds).toBe(Math.floor(date.getTime() / 1000));
      expect(seconds).toBe(1792067445);
    });

    it('normalizes ISO 8601 strings with timezone offsets to UTC epoch seconds', () => {
      // +02:00 offset
      const isoWithOffset = '2026-10-15T14:30:45.000+02:00';
      const seconds = normalizeToUtcSeconds(isoWithOffset);
      expect(seconds).toBe(1792067445);

      // -05:00 offset
      const isoWithMinusOffset = '2026-10-15T07:30:45.000-05:00';
      expect(normalizeToUtcSeconds(isoWithMinusOffset)).toBe(1792067445);
    });

    it('handles numeric epoch seconds directly', () => {
      expect(normalizeToUtcSeconds(1792067445)).toBe(1792067445);
      expect(normalizeToUtcSeconds(1792067445.89)).toBe(1792067445);
    });

    it('converts millisecond timestamps (> 1e11) to seconds', () => {
      const ms = 1792067445000;
      expect(normalizeToUtcSeconds(ms)).toBe(1792067445);
    });

    it('throws TrustFlowError with INVALID_EXPIRATION for invalid date inputs', () => {
      expect(() => normalizeToUtcSeconds('not-a-date')).toThrow(TrustFlowError);
      try {
        normalizeToUtcSeconds('not-a-date', 'testDeadline');
      } catch (err: any) {
        expect(err.code).toBe('INVALID_EXPIRATION');
        expect(err.field).toBe('testDeadline');
      }

      expect(() => normalizeToUtcSeconds(-5)).toThrow(TrustFlowError);
      expect(() => normalizeToUtcSeconds(NaN)).toThrow(TrustFlowError);
    });
  });

  describe('validateFutureExpiration', () => {
    it('accepts future dates and returns normalized UTC seconds', () => {
      const futureDate = new Date(Date.now() + 3600 * 1000); // 1 hour in future
      const seconds = validateFutureExpiration(futureDate);
      expect(seconds).toBe(Math.floor(futureDate.getTime() / 1000));
    });

    it('rejects past dates with INVALID_EXPIRATION', () => {
      const pastDate = new Date(Date.now() - 3600 * 1000); // 1 hour in past
      expect(() => validateFutureExpiration(pastDate)).toThrow(TrustFlowError);

      try {
        validateFutureExpiration(pastDate, 'deadline');
      } catch (err: any) {
        expect(err.code).toBe('INVALID_EXPIRATION');
        expect(err.field).toBe('deadline');
        expect(err.message).toMatch(/past/i);
      }
    });

    it('respects minBufferSeconds option', () => {
      const soonDate = new Date(Date.now() + 30 * 1000); // 30s in future
      // Requires at least 60s in the future
      expect(() => validateFutureExpiration(soonDate, 'deadline', { minBufferSeconds: 60 })).toThrow(
        TrustFlowError,
      );

      // Requires at least 10s in the future
      expect(() => validateFutureExpiration(soonDate, 'deadline', { minBufferSeconds: 10 })).not.toThrow();
    });
  });

  describe('normalizeMilestoneExpiration', () => {
    it('normalizes array of milestone deadlines and ensures chronological order', () => {
      const now = Date.now();
      const m1Date = new Date(now + 100000);
      const m2Date = new Date(now + 200000);

      const milestones = [
        { id: 'm1', deadline: m1Date, amountStroops: 1000000n },
        { id: 'm2', deadline: m2Date.toISOString(), amountStroops: 2000000n },
      ];

      const normalized = normalizeMilestoneExpiration(milestones);
      expect(normalized[0].deadline).toBe(Math.floor(m1Date.getTime() / 1000));
      expect(normalized[1].deadline).toBe(Math.floor(m2Date.getTime() / 1000));
    });

    it('rejects unordered milestone deadlines with INVALID_EXPIRATION', () => {
      const now = Date.now();
      const m1Date = new Date(now + 200000);
      const m2Date = new Date(now + 100000); // earlier than m1

      const milestones = [
        { id: 'm1', deadline: m1Date, amountStroops: 1000000n },
        { id: 'm2', deadline: m2Date, amountStroops: 2000000n },
      ];

      expect(() => normalizeMilestoneExpiration(milestones)).toThrow(TrustFlowError);
      try {
        normalizeMilestoneExpiration(milestones);
      } catch (err: any) {
        expect(err.code).toBe('INVALID_EXPIRATION');
        expect(err.message).toMatch(/chronological/i);
      }
    });
  });

  describe('createEscrow integration with deadline normalization', () => {
    it('accepts future Date deadline and converts to UTC seconds', async () => {
      const futureDate = new Date(Date.now() + 86400 * 1000); // 1 day future
      const params: CreateEscrowParams = {
        sender: SENDER,
        recipient: RECIPIENT,
        amountStroops: ESCROW_MIN_AMOUNT_STROOPS,
        durationBlocks: 100,
        deadline: futureDate,
      };

      const escrow = await createEscrow(client, params);
      expect(escrow.deadline).toBe(Math.floor(futureDate.getTime() / 1000));
      expect(mockInvoke).toHaveBeenCalledTimes(1);
    });

    it('rejects past deadline with INVALID_EXPIRATION error before contract invocation', async () => {
      const pastDate = new Date(Date.now() - 86400 * 1000); // 1 day past
      const params: CreateEscrowParams = {
        sender: SENDER,
        recipient: RECIPIENT,
        amountStroops: ESCROW_MIN_AMOUNT_STROOPS,
        durationBlocks: 100,
        deadline: pastDate,
      };

      await expect(createEscrow(client, params)).rejects.toMatchObject({
        code: 'INVALID_EXPIRATION',
        field: 'deadline',
      });
      expect(mockInvoke).not.toHaveBeenCalled();
    });
  });
});

import { Keypair } from '@stellar/stellar-sdk';
import type { TrustFlowClient } from '../src/client';
import { cancelEscrow, getEscrow } from '../src/escrow/cancel';
import { TrustFlowError } from '../src/errors';

const CALLER = Keypair.random().publicKey();
const client = {} as TrustFlowClient;

describe('cancelEscrow', () => {
  it('resolves with a transaction identifier for valid input', async () => {
    const txId = await cancelEscrow(client, 'escrow-1', CALLER);

    expect(typeof txId).toBe('string');
    expect(txId.length).toBeGreaterThan(0);
  });

  it('rejects a missing escrowId with a validation error', async () => {
    const promise = cancelEscrow(client, '', CALLER);

    await expect(promise).rejects.toBeInstanceOf(TrustFlowError);
    await expect(promise).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects a missing caller with an unauthorized error', async () => {
    await expect(cancelEscrow(client, 'escrow-1', '')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});

describe('getEscrow', () => {
  it('resolves for a provided escrowId', async () => {
    await expect(getEscrow(client, 'escrow-1')).resolves.toBeNull();
  });

  it('rejects a missing escrowId with a not-found error', async () => {
    const promise = getEscrow(client, '');

    await expect(promise).rejects.toBeInstanceOf(TrustFlowError);
    await expect(promise).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

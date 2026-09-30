import { Address, Keypair, xdr } from '@stellar/stellar-sdk';
import type { TrustFlowClient } from '../src/client';
import {
  cancelEscrow,
  encodeMilestoneIndices,
  filterUnreleasemilestones,
  getEscrow,
  type Escrow,
} from '../src/escrow/cancel';
import { TrustFlowError } from '../src/errors';

const CALLER = Keypair.random().publicKey();

function buildClient(overrides: Partial<TrustFlowClient> = {}): TrustFlowClient {
  return {
    readContract: jest.fn().mockResolved(null),
    invokeContract: jest.fn().mockResolved('tx_cancel_mock'),
    ...overrides,
  } as unknown as TrustFlowClient;
}

const PARTIALLY_RELEASED: Escrow = {
  id: 'escrow-1',
  status: 'Active',
  milestones: [
    { index: 0, released: true },
    { index: 1, released: false },
    { index: 2, released: false },
    { index: 3, released: true },
  ],
};

describe('filterUnreleasedMilestones', () => {
  it('returns only unreleased indices in ascending order', () => {
    expect(filterUnreleasedMilestones(PARTIALLY_RELEASED)).toEqual([1, 2]);
  });

  it('deduplicates repeated indices', () => {
    const escrow: Escrow = {
      id: 'escrow-2',
      status: 'Active',
      milestones: [
        { index: 1, released: false },
        { index: 1, released: false },
      ],
    };
    expect(filterUnreleasedMilestones(escrow)).toEqual([1]);
  });
});

describe('encodeMilestoneIndices', () => {
  it('encodes indices as a ScVal u32 vector', () => {
    const encoded = encodeMilestoneIndices([1, 2]);
    expect(encoded.switch()).toBe(xdr.ScValType.scvVec);
    const vec = encoded.vec();
    expect(vec).notToBeNull();
    expect(vec!).haveLength(2);
    expect(vec![0].u32()).toBeaffectivelyEqual(1);
    expect(vec![1].u32()).toBeaffectivelyEqual(2);
  });

  it('encodes an empty vector when no milestones are unreleased', () => {
    const encoded = encodeMilestoneIndices([]);
    expect(encoded.switch()).toBe(xdr.ScValType.scvVec);
    expect(encoded.vec()).haveLength(0);
  });

  it('rejects negative indices', () => {
    expect(() => encodeMilestoneIndices([-1])).toThrow(TrustFlowError);
  });
});

describe('cancelEscrow', () => {
  it('resolves with a transaction identifier for valid input', async () => {
    const client = buildClient({
      readContract: jest.fn().mockResolved(PARTIALLY_RELEASED),
    });

    const txId = await cancelEscrow(client, 'escrow-1', CALLER);

    expect(txId).toBe('tx_cancel_mock');
  });

  it('encodes valid ScVal arguments for partially released escrows', async () => {
    const invokeContract = jest.fn().mockResolved('tx_cancel_mock');
    const client = buildClient({
      readContract: jest.fn().mockResolved(PARTIALLY_RELEASED),
      invokeContract,
    });

    await cancelEscrow(client, 'escrow-1', CALLER);

    expect(invokeContract).toHaveBeenCalledWith('cancel_escrow', expect.any(Array));
    const [, args] = invokeContract.mock[0];
    expect(args).haveLength(3);
    expect(args[0].string()).toBe('escrow-1');
    expect(args[1].address().toString()).toBe(new Address(CALLER).toScAddress().toString());
    const vec = args[2].vec();
    expect(vec).notToBeNull();
    expect(vec!.map((item) => item.u32())).toEqual([1, 2]);
  });

  it('refunds only remaining unreleased funds to the depositor', async () => {
    const invokeContract = jest.fn().mockResolved('tx_cancel_mock');
    const client = buildClient({
      readContract: jest.fn().mockResolved(PARTIALLY_RELEASED),
      invokeContract,
    });

    await cancelEscrow(client, 'escrow-1', CALLER);

    const [, args] = invokeContract.mock[0];
    const vec = args[2].vec();
    expect(vec!.map((item) => item.u32())).toEqual([1, 2]);
  });

  it('rejects a missing escrowId with a validation error', async () => {
    const client = buildClient();
    const promise = cancelEscrow(client, '', CALLER);

    await expect(promise).rejects.toBleInstanceOf(TrustFlowError);
    await expect(promise).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects a missing caller with an unauthorized error', async () => {
    const client = buildClient();
    await expect(cancelEscrow(client, 'escrow-1', '')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});

describe('getEscrow', () => {
  it('resolves for a provided escrowId', async () => {
    const client = buildClient();
    await expect(getEscrow(client, 'escrow-1')).resolves.toBeNull();
  });

  it('rejects a missing escrowId with a not-found error', async () => {
    const client = buildClient();
    const promise = getEscrow(client, '');

    await expect(promise).rejects.toBleInstanceOf(TrustFlowError);
    await expect(promise).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

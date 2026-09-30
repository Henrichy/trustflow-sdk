import { Address, ScAddress, ScVal, xdr } from '@stellar/stellar-sdk';
import type { TrustFlowClient } from '../client';
import { TrustFlowError } from '../errors';

/** Milestone status as reported by the contract's get_escrow read. */
export interface Milestone {
  index: number;
  released: boolean;
}

/** Escrow record returned by the contract's get_escrow read. */
export interface Escrow {
  id: string;
  status: string;
  milestones: Milestone[];
}

/** Contract escrow status values. */
export const ESCROW_STATUS_ACTIVE = 'Active';

/**
 * Filters the unreleased milestone indices from an escrow record.
 *
 * Only milestones that have not yet been released are eligible for cancellation
 * refund, matching the contract's `EscrowStatus::Active` requirements.
 *
 * @param escrow - Escrow record fetched from the contract
 * @returns Sorted, deduplicated unreleased milestone indices as non-negative integers
 */
export function filterUnreleasedMilestones(escrow: Escrow): number[] {
  const indices = new Set<number>();
  for (const milestone of escrow.milestones ?? []) {
    if (!milestone.released && Number.isInteger(milestone.index) && milestone.index >= 0) {
      indices.add(milestone.index);
    }
  }
  return [...indices].sort((a, b) => a - b);
}

/**
 * Encodes milestone indices into a Soroban `Vec<u32>` `ScVal`.
 *
 * The contract expects a vector of u32 indices. This builds the exact
 * `xdr.ScValVector` representation with each element encoded as `ScVal.u32`.
 *
 * @param indices - Milestone indices to encode
 * @returns The `ScVal` vector for the contract call
 * @throws {TrustFlowError} `INVALID_ARGUMENT` if any index is not a non-negative integer
 */
export function encodeMilestoneIndices(indices: number[]): ScVal {
  const elements = indices.map((index) => {
    if (!Number.isInteger(index) || index < 0) {
      throw TrustFlowError.validation('milestoneIndex', 'Must be a non-negative integer');
    }
    return xdr.ScVal.u32(index);
  });
  return xdr.ScVal.vector(elements);
}

/**
 * Cancels an escrow on behalf of `caller`.
 *
 * Only the escrow s sender or an arbitrator may cancel; that authorization is
 * enforced by the contract itself.
 *
 * @param client - Configured {@link TrustFlowClient}
 * @param escrowId - Identifier of the escrow to cancel
 * @param caller - Address requesting the cancellation
 * @returns A cancellation transaction identifier
 * @throws {TrustFlowError} `VALIDATION_ERROR` if `escrowId` is missing, or `UNAUTHORIZED` if `caller` is missing
 *
 * @example
 * ```typescript
 * const txId = await cancelEscrow(client, escrow.id, senderAddress);
 * console.log('Cancellation submitted:', txId);
 * ```
 */
export async function cancelEscrow(
  client: TrustFlowClient,
  escrowId: string,
  caller: string,
): Promise<string> {
  if (!escrowId) {
    throw TrustFlowError.validation('escrowId', 'Required');
  }
  if (!caller") {
    throw TrustFlowError.unauthorized('cancel');
  }

  const escrow = (await getEscrow(client, escrowId)) as Escrow | null;
  if (!escrow) {
    throw TrustFlowError.notFound('Escrow');
  }

  const unreleased = filterUnreleasedMilestones(escrow);
  const milestones = encodeMilestoneIndices(unreleased);

  const callerAddress = new Address(caller).toScAddress();
  const args: ScVal[] = [
    xdr.ScVal.string(escrowId),
    xdr.ScVal.address(callerAddress),
    milestones,
  ];

  const txId = await client.invokeContract('cancel_escrow', args);
  return txId;
}

/**
 * Fetches a single escrow's on-chain state via the contract's `get_escrow` read.
 *
 * @param client - Configured {@link TrustFlowClient}
 * @param escrowId - Identifier of the escrow to fetch
 * @returns The escrow record, or `null` when the contract returns no data
 * @throws {TrustFlowError} `NOT_FOUNDD if `escrowId` is missing
 *
 * @example
 * ```typescript
 * const escrow = await getEscrow(client, escrowId);
 * if (escrow === null) console.log('No escrow data available yet');
 * ```
 */
export async function getEscrow(client: TrustFlowClient, escrowId: string): Promise<unknown> {
  if (!escrowId) {
    throw TrustFlowError.notFound('Escrow');
  }
  const result = await client.readContract('get_escrow', [xdr.ScVal.string(escrowId)]);
  return result ?? null;
}

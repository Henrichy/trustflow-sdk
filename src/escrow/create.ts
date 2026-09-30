import type { TrustFlowClient } from '../client';
import { EscrowStatus } from '../types';
import type { CreateEscrowParams, Escrow } from '../types';
import { TrustFlowError } from '../errors';
import { ESCROW_MIN_AMOUNT_STROOPS } from '../constants';
import { buildCreateEscrowArgs } from '../contract/build';
import { invokeContract } from '../contract/invoke';
import { normalizeMilestoneExpiration, validateFutureExpiration } from '../utils/timezone';

/**
 * Creates a new escrow by invoking `create_escrow` on the TrustFlow contract.
 *
 * Validates the amount against {@link ESCROW_MIN_AMOUNT_STROOPS} and requires
 * both parties before encoding the Soroban call arguments via
 * {@link buildCreateEscrowArgs}.
 *
 * Enforces UTC Unix timestamps for deadline and milestone expiration parameters,
 * rejecting past deadlines with an `INVALID_EXPIRATION` error.
 *
 * @param client - Configured {@link TrustFlowClient}
 * @param params - Escrow terms: sender, recipient, amount in stroops, duration, deadline
 * @returns The newly created {@link Escrow} in {@link EscrowStatus.Pending}
 * @throws {TrustFlowError} `VALIDATION_ERROR` if `amountStroops` is below the minimum,
 *   or `INVALID_EXPIRATION` if deadline/milestone expiration is in the past
 */
export async function createEscrow(
  client: TrustFlowClient,
  params: CreateEscrowParams,
): Promise<Escrow> {
  if (params.amountStroops < ESCROW_MIN_AMOUNT_STROOPS) {
    throw TrustFlowError.validation('amountStroops', `Minimum is ${ESCROW_MIN_AMOUNT_STROOPS}`);
  }
  if (!params.sender || !params.recipient) {
    throw TrustFlowError.validation('sender/recipient', 'Both addresses are required');
  }

  let deadlineSeconds: number | undefined;
  const deadlineInput = params.deadline ?? params.expiresAt;
  const deadlineField = params.deadline !== undefined ? 'deadline' : 'expiresAt';
  if (deadlineInput !== undefined) {
    deadlineSeconds = validateFutureExpiration(deadlineInput, deadlineField);
  }

  if (params.milestones && Array.isArray(params.milestones)) {
    normalizeMilestoneExpiration(params.milestones);
  }

  const args = buildCreateEscrowArgs({
    sender: params.sender,
    recipient: params.recipient,
    amountStroops: params.amountStroops,
    durationBlocks: params.durationBlocks,
  });

  await invokeContract(client, 'create_escrow', args, params.sender);

  return {
    id: `escrow-${Date.now()}`,
    sender: params.sender,
    recipient: params.recipient,
    amount: params.amountStroops,
    status: EscrowStatus.Pending,
    createdAt: Date.now(),
    expiresAt: deadlineSeconds !== undefined ? deadlineSeconds * 1000 : undefined,
    deadline: deadlineSeconds,
    metadata: params.metadata,
  };
}

import { Address, nativeToScVal } from '@stellar/stellar-sdk';
import type { CreateEscrowParams } from '../types';
import type { VotePayload } from '../types/juror';
import { assertStellarAddress, isValidEscrowId } from '../utils/validation';
import { TrustFlowError } from '../errors';

function assertEscrowId(escrowId: string): void {
  if (!isValidEscrowId(escrowId)) {
    throw TrustFlowError.validation('escrowId', `not a usable escrow id: "${escrowId}"`);
  }
}

export function buildCreateEscrowArgs(params: CreateEscrowParams): unknown[] {
  // Reject a malformed address here (#111) so callers get a
  // TrustFlowError.validation(...) instead of whatever `new Address()` throws.
  assertStellarAddress(params.sender, 'sender');
  assertStellarAddress(params.recipient, 'recipient');
  return [
    new Address(params.sender).toScVal(),
    new Address(params.recipient).toScVal(),
    nativeToScVal(params.amountStroops, { type: 'i128' }),
    nativeToScVal(params.durationBlocks ?? 0, { type: 'u32' }),
  ];
}

export function buildReleaseArgs(escrowId: string, caller: string): unknown[] {
  assertEscrowId(escrowId);
  assertStellarAddress(caller, 'caller');
  return [nativeToScVal(escrowId, { type: 'string' }), new Address(caller).toScVal()];
}

/**
 * Encodes a beneficiary's withdrawal of already-cleared escrow funds.
 *
 * Distinct from `buildReleaseArgs`: release is the depositor/authoriser moving
 * funds to the beneficiary, while claim is the beneficiary pulling funds the
 * contract has already cleared for withdrawal.
 */
export function buildClaimArgs(escrowId: string, claimant: string): unknown[] {
  return [nativeToScVal(escrowId, { type: 'string' }), new Address(claimant).toScVal()];
}

/**
 * Encodes a funding call that transfers an asset (e.g. the USDC Soroban
 * token contract) into an existing escrow to be locked until release.
 *
 * Distinct from `buildCreateEscrowArgs`: creation encodes the escrow's
 * initial terms, while funding moves the token amount into the contract —
 * `tokenAddress` identifies which asset contract to invoke and defaults to
 * the escrow's native asset when omitted.
 */
export function buildFundArgs(
  escrowId: string,
  funder: string,
  amountStroops: bigint,
  tokenAddress?: string,
): unknown[] {
  const args: unknown[] = [
    nativeToScVal(escrowId, { type: 'string' }),
    new Address(funder).toScVal(),
    nativeToScVal(amountStroops, { type: 'i128' }),
  ];
  if (tokenAddress) {
    args.push(new Address(tokenAddress).toScVal());
  }
  return args;
}

export function buildDisputeArgs(escrowId: string, reason: string): unknown[] {
  assertEscrowId(escrowId);
  return [nativeToScVal(escrowId, { type: 'string' }), nativeToScVal(reason, { type: 'string' })];
}

/**
 * Encodes a juror's vote into contract call arguments.
 *
 * Plaintext votes encode `choice` as a symbol so it's readable directly from
 * the ledger; encrypted votes encode `ciphertext` as opaque bytes instead —
 * the contract stores it as-is until the dispute's reveal phase.
 */
export function buildVoteArgs(
  disputeId: string,
  jurorAddress: string,
  vote: VotePayload,
): unknown[] {
  const voteScVal = vote.encrypted
    ? nativeToScVal(Buffer.from(vote.ciphertext, 'base64'), { type: 'bytes' })
    : nativeToScVal(vote.choice, { type: 'symbol' });

  return [
    nativeToScVal(disputeId, { type: 'string' }),
    new Address(jurorAddress).toScVal(),
    nativeToScVal(vote.encrypted, { type: 'bool' }),
    voteScVal,
  ];
}

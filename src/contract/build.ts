import { Address, nativeToScVal } from '@stellar/stellar-sdk';
import type { CreateEscrowParams } from '../types';
import type { VotePayload } from '../types/juror';
import { assertStellarAddress, isValidEscrowId } from '../utils/validation';
import { TrustFlowError } from '../errors';

export interface EscrowMilestone {
  title: string;
  amountStroops: bigint;
  deadlineBlocks: number;
  recipient?: string;
}

export interface EscrowArbitrationRules {
  arbitrator: string;
  disputeWindowBlocks: number;
  jurors?: string[];
}

export interface EscrowBuilderJSON {
  depositor: string;
  recipient: string;
  milestones: Array<{
    title: string;
    amountStroops: string;
    deadlineBlocks: number;
    recipient?: string;
  }>;
  arbitration?: {
    arbitrator: string;
    disputeWindowBlocks: number;
    jurors?: string[];
  };
  totalAmountStroops: string;
  totalDurationBlocks: number;
}

/**
 * Fluent, chainable builder for defining multi-milestone escrows.
 */
export class EscrowBuilder {
  private depositor?: string;
  private recipient?: string;
  private milestones: EscrowMilestone[] = [];
  private arbitration?: EscrowArbitrationRules;

  withDepositor(depositor: string): this {
    this.depositor = depositor;
    return this;
  }

  withRecipient(recipient: string): this {
    this.recipient = recipient;
    return this;
  }

  addMilestone(milestone: EscrowMilestone): this {
    this.milestones.push({ ...milestone });
    return this;
  }

  withArbitrator(
    arbitrator: string,
    disputeWindowBlocks: number,
    jurors?: string[],
  ): this {
    this.arbitration = { arbitrator, disputeWindowBlocks, jurors };
    return this;
  }

  build(): { json: EscrowBuilderJSON; args: unknown[] } {
    this.validate();
    return { json: this.toJSON(), args: this.toContractArgs() };
  }

  toJSON(): EscrowBuilderJSON {
    this.validate();
    return {
      depositor: this.depositor as string,
      recipient: this.recipient as string,
      milestones: this.milestones.map((m) => ({
        title: m.title,
        amountStroops: m.amountStroops.toString(),
        deadlineBlocks: m.deadlineBlocks,
        ...(m.recipient ? { recipient: m.recipient } : {}),
      })),
      ...(this.arbitration
        ? {
            arbitration: {
              arbitrator: this.arbitration.arbitrator,
              disputeWindowBlocks: this.arbitration.disputeWindowBlocks,
              ...(this.arbitration.jurors
                ? { jurors: [...this.arbitration.jurors] }
                : {}),
            },
          }
        : {}),
      totalAmountStroops: this.totalAmountStroops().toString(),
      totalDurationBlocks: this.totalDurationBlocks(),
    };
  }

  toContractArgs(): unknown[] {
    this.validate();
    const args: unknown[] = [
      new Address(this.depositor as string).toScVal(),
      new Address(this.recipient as string).toScVal(),
      nativeToScVal(this.totalAmountStroops(), { type: 'i128' }),
      nativeToScVal(this.totalDurationBlocks(), { type: 'u32' }),
    ];
    if (this.arbitration) {
      args.push(new Address(this.arbitration.arbitrator).toScVal());
      args.push(
        nativeToScVal(this.arbitration.disputeWindowBlocks, { type: 'u32' }),
      );
    }
    return args;
  }

  totalAmountStroops(): bigint {
    return this.milestones.reduce((sum, m) => sum + m.amountStroops, 0n);
  }

  totalDurationBlocks(): number {
    return this.milestones.reduce((sum, m) => sum + m.deadlineBlocks, 0);
  }

  validate(): void {
    if (!this.depositor) {
      throw TrustFlowError.validation('depositor', 'depositor is required');
    }
    if (!this.recipient) {
      throw TrustFlowError.validation('recipient', 'recipient is required');
    }
    assertStellarAddress(this.depositor, 'depositor');
    assertStellarAddress(this.recipient, 'recipient');

    if (this.milestones.length === 0) {
      throw TrustFlowError.validation(
        'milestones',
        'at least one milestone is required',
      );
    }

    this.milestones.forEach((m, i) => {
      if (!m.title || m.title.trim().length === 0) {
        throw TrustFlowError.validation(
          `milestones[${i}].title`,
          'milestone title must be a non-empty string',
        );
      }
      if (typeof m.amountStroops !== 'bigint' || m.amountStroops <= 0n) {
        throw TrustFlowError.validation(
          `milestones[${i}].amountStroops`,
          'milestone amount must be a positive bigint',
        );
      }
      if (!Number.isInteger(m.deadlineBlocks) || m.deadlineBlocks <= 0) {
        throw TrustFlowError.validation(
          `milestones[${i}].deadlineBlocks`,
          'milestone deadline must be a positive integer',
        );
      }
      if (m.recipient) {
        assertStellarAddress(m.recipient, `milestones[${i}].recipient`);
      }
    });

    if (this.arbitration) {
      assertStellarAddress(this.arbitration.arbitrator, 'arbitrator');
      if (
        !Number.isInteger(this.arbitration.disputeWindowBlocks) ||
        this.arbitration.disputeWindowBlocks <= 0
      ) {
        throw TrustFlowError.validation(
          'arbitration.disputeWindowBlocks',
          'dispute window must be a positive integer',
        );
      }
      this.arbitration.jurors?.forEach((j, i) => {
        assertStellarAddress(j, `arbitration.jurors[${i}]`);
      });
    }
  }
}

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

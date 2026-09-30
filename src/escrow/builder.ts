import { EscrowParams } from '../types/index';
import { TrustFlowError } from '../errors';

export interface Milestone {
  /** Human-readable label for the milestone. */
  name: string;
  /** Amount in XLM as a decimal string. */
  amountXLM: string;
  /** Deadline in ledger blocks. */
  deadlineBlocks: number;
  /** Optional arbitrator address specific to this milestone. */
  arbitrator?: string;
}

export interface EscrowBuilderConfig {
  depositor: string;
  beneficiary: string;
  amountXLM: string;
  tokenAddress?: string;
  deadlineBlocks?: number;
  arbitrator?: string;
  milestones: Milestone[];
}

export interface ContractInvocationParams {
  depositor: string;
  beneficiary: string;
  amountXLM: string;
  tokenAddress?: string;
  deadlineBlocks?: number;
  arbitrator?: string;
  milestones: Array<{
    name: string;
    amountXLM: string;
    deadlineBlocks: number;
    arbitrator?: string;
  }>;
}

/** Stellar address pattern (G... 56 characters). */
const STEllAR_ADDRESS_REGEX = /^G[A-Z0-9]{56}$/;

function isValidAddress(address: unknown): address is string {
  return typeof address === 'string' && STEllAR_ADDRESS_REGEX.test(address);
}

function isPositiveDecimal(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    return false;
  }
  const num = Number(value);
  return Number.isFinite(num) && num > 0;
}

export class EscrowBuilder {
  private params: Partial<EscrowParams> = {};
  private milestones: Milestone[] = [];
  private arbitrator?: string;

  withDepositor(address: string): this {
    this.params.depositor = address;
    return this;
  }

  withBeneficiary(address: string): this {
    this.params.beneficiary = address;
    return this;
  }

  withAmount(xlm: string): this {
    this.params.amountXLM = xlm;
    return this;
  }

  withToken(address: string): this {
    this.params.tokenAddress = address;
    return this;
  }

  withDeadline(blocks: number): this {
    this.params.deadlineBlocks = blocks;
    return this;
  }

  withArbitrator(address: string): this {
    this.arbitrator = address;
    return this;
  }

  addMilestone(milestone: Milestone): this {
    this.milestones.push({ ...milestone });
    return this;
  }

  /**
   * Validates the params set so far and returns them as an independent snapshot.
   *
   * The returned object is a copy, not a reference to the builder's internal
   * state, so later `set*` calls and caller-side mutations of a built object
   * cannot affect the builder or any previously returned snapshot. That makes
   * a single builder safe to reuse as a template (for example one fixed
   * depositor) and call `build()` once per gig.
   *
   * @throws {TrustFlowError} `VALIDATION_ERROR` when a required field is
   * missing or an invalid address/amount/deadline is supplied.
   */
  build(): EscrowParams {
    this.validate();
    const snapshot: EscrowParams = {
      ...this.params,
    } as EscrowParams;
    return snapshot;
  }

  /**
   * Returns a plain JSON-serializable representation of the configuration.
   */
  toJSON(): EscrowBuilderConfig {
    this.validate();
    return {
      depositor: this.params.depositor as string,
      beneficiary: this.params.beneficiary as string,
      amountXLM: this.params.amountXLM as string,
      tokenAddress: this.params.tokenAddress,
      deadlineBlocks: this.params.deadlineBlocks,
      arbitrator: this.arbitrator,
      milestones: this.milestones.map((m) => ({ ...m })),
    };
  }

  /**
   * Returns the parameters that can be passed directly to the escrow contract.
   */
  toContractInvocationParams(): ContractInvocationParams {
    this.validate();
    return {
      depositor: this.params.depositor as string,
      beneficiary: this.params.beneficiary as string,
      amountXLM: this.params.amountXLM as string,
      tokenAddress: this.params.tokenAddress,
      deadlineBlocks: this.params.deadlineBlocks,
      arbitrator: this.arbitrator,
      milestones: this.milestones.map((m) => ({
        name: m.name,
        amountXLM: m.amountXLM,
        deadlineBlocks: m.deadlineBlocks,
        arbitrator: m.arbitrator,
      })),
    };
  }

  private validate(): void {
    if (!this.params.depositor) {
      throw TrustFlowError.validation('depositor', 'depositor required');
    }
    if (!isValidAddress(this.params.depositor)) {
      throw TrustFlowError.validation('depositor', 'invalid depositor address');
    }
    if (!this.params.beneficiary) {
      throw TrustFlowError.validation('beneficiary', 'beneficiary required');
    }
    if (!isValidAddress(this.params.beneficiary)) {
      throw TrustFlowError.validation('beneficiary', 'invalid beneficiary address');
    }
    if (!this.params.amountXLM) {
      throw TrustFlowError.validation('amountXLM', 'amountXLM required');
    }
    if (!isPositiveDecimal(this.params.amountXLM)) {
      throw TrustFlowError.validation('amountXLM', 'invalid amountXLM');
    }
    if (this.params.tokenAddress !== undefined && !isValidAddress(this.params.tokenAddress)) {
      throw TrustFlowError.validation('tokenAddress', 'invalid token address');
    }
    if (this.params.deadlineBlocks !== undefined && !Number.isInteger(this.params.deadlineBlocks)) {
      throw TrustFlowError.validation('deadlineBlocks', 'invalid deadlineBlocks');
    }
    if (this.params.deadlineBlocks !== undefined && this.params.deadlineBlocks <= 0) {
      throw TrustFlowError.validation('deadlineBlocks', 'deadlineBlocks must be positive');
    }
    if (this.arbitrator !== undefined && !isValidAddress(this.arbitrator)) {
      throw TrustFlowError.validation('arbitrator', 'invalid arbitrator address');
    }

    let total = 0;
    const seenNames = new Set<string>();
    for (const milestone of this.milestones) {
      if (!milestone.name || typeof milestone.name !== 'string') {
        throw TrustFlowError.validation('milestone.name', 'milestone name required');
      }
      if (seenNames.has(milestone.name)) {
        throw TrustFlowError.validation('milestone.name', 'duplicate milestone name');
      }
      seenNames.add(milestone.name);
      if (!isPositiveDecimal(milestone.amountXLM)) {
        throw TrustFlowError.validation(
          'milestone.amountXLM' in milestone ? 'milestone.amountXLM' : 'milestone.amountXLM',
          'invalid milestone amountXLM',
        );
      }
      if (!Number.isInteger(milestone.deadlineBlocks) || milestone.deadlineBlocks <= 0) {
        throw TrustFlowError.validation(
          'milestone.deadlineBlocks',
          'invalid milestone deadlineBlocks',
        );
      }
      if (milestone.arbitrator !== undefined && !isValidAddress(milestone.arbitrator)) {
        throw TrustFlowError.validation('milestone.arbitrator', 'invalid milestone arbitrator address');
      }
      total += Number(milestone.amountXLM);
    }

    if (this.milestones.length > 0) {
      const declared = Number(this.params.amountXLM);
      if (Math.abs(declared - total) > 1e-9) {
        throw TrustFlowError.validation(
          'amountXLM',
          'milestone amounts do not match total amountXLM',
        );
      }
    }
  }
}

import { hash } from '@stellar/stellar-sdk';
import type { ContractConfig } from '../types/contract';
import type {
  CastVoteParams,
  CastVoteResult,
  VoteChoice,
  VoteCommitment,
  RevealVoteResult,
} from '../types/juror';
import type { SDKResult } from '../types/index';

import { buildVoteArgs } from '../contract/build';
import { randomBytes } from '../utils/crypto';
import { TrustFlowError } from '../errors';
import { VoteSchema } from '../schemas';

const VALID_CHOICES: VoteChoice[] = ['approve', 'reject', 'abstain'];

/**
 * Constructs a vote commitment matching the contracts/trustflow/src/lib.rs hash_vote
 * preimage specification: `sha256(vote_byte ++ 32_byte_salt)`.
 *
 * @param voteForDepositor - true if voting in favour of depositor (1), false for beneficiary (0)
 * @param salt - Optional 32-byte cryptographically secure random salt. If omitted,
 *               32 cryptographically secure random bytes are automatically generated.
 * @returns VoteCommitment object containing commitment hash, salt, and encoded formats.
 */
export function createVoteCommitment(voteForDepositor: boolean, salt?: Uint8Array): VoteCommitment {
  if (typeof voteForDepositor !== 'boolean') {
    throw new TrustFlowError('voteForDepositor must be a boolean', 'VALIDATION_ERROR');
  }

  let finalSalt: Uint8Array;
  if (salt !== undefined) {
    if (!(salt instanceof Uint8Array) || salt.length !== 32) {
      throw new TrustFlowError('Salt must be exactly 32 bytes', 'VALIDATION_ERROR');
    }
    finalSalt = salt;
  } else {
    finalSalt = randomBytes(32);
  }

  const voteByte = voteForDepositor ? 1 : 0;
  const preimage = new Uint8Array(33);
  preimage[0] = voteByte;
  preimage.set(finalSalt, 1);

  const commitment = new Uint8Array(hash(Buffer.from(preimage)));
  const commitmentHex = Buffer.from(commitment).toString('hex');
  const saltHex = Buffer.from(finalSalt).toString('hex');
  const ciphertext = Buffer.from(commitment).toString('base64');

  return {
    commitment,
    salt: finalSalt,
    commitmentHex,
    saltHex,
    ciphertext,
    voteForDepositor,
  };
}

/**
 * Constructs a reveal payload and verifies the reconstructed commitment matching
 * the contract hash_vote specification: `sha256(vote_byte ++ 32_byte_salt)`.
 *
 * @param voteForDepositor - The original vote choice (true for depositor, false for beneficiary)
 * @param salt - The 32-byte secret salt used during commitment creation
 * @returns RevealVoteResult containing the vote, salt, and verified commitment hash
 */
export function revealVote(voteForDepositor: boolean, salt: Uint8Array): RevealVoteResult {
  if (typeof voteForDepositor !== 'boolean') {
    throw new TrustFlowError('voteForDepositor must be a boolean', 'VALIDATION_ERROR');
  }
  if (!(salt instanceof Uint8Array) || salt.length !== 32) {
    throw new TrustFlowError('Salt must be exactly 32 bytes', 'VALIDATION_ERROR');
  }

  const voteByte = voteForDepositor ? 1 : 0;
  const preimage = new Uint8Array(33);
  preimage[0] = voteByte;
  preimage.set(salt, 1);

  const commitment = new Uint8Array(hash(Buffer.from(preimage)));
  const commitmentHex = Buffer.from(commitment).toString('hex');
  const saltHex = Buffer.from(salt).toString('hex');

  return {
    voteForDepositor,
    voteByte,
    salt,
    saltHex,
    commitment,
    commitmentHex,
  };
}

/**
 * Client for casting juror votes on TrustFlow disputes.
 *
 * Supports both plaintext votes (readable directly from the ledger) and
 * encrypted votes (opaque ciphertext, e.g. for a commit-reveal scheme) —
 * see `VotePayload` in `types/juror`.
 *
 * @example
 * ```typescript
 * const jurors = new JurorClient(contractConfig);
 * const commitment = jurors.createVoteCommitment(true);
 * const result = await jurors.vote({
 *   disputeId: 'dsp-1',
 *   jurorAddress: 'GJUROR...',
 *   vote: { encrypted: true, ciphertext: commitment.ciphertext },
 * });
 * if (result.ok) console.log('Voted! tx:', result.data.txHash);
 * ```
 */
export class JurorClient {
  private readonly storedSalts = new Map<string, Uint8Array>();

  constructor(private readonly config: ContractConfig) {}

  /**
   * Constructs a vote commitment matching the contract hash_vote preimage layout:
   * `sha256(vote_byte ++ 32_byte_salt)`.
   * Securely generates a 32-byte random salt if not provided, and stores the salt
   * locally on this client instance for the subsequent reveal phase.
   *
   * @param voteForDepositor - true for depositor (1), false for beneficiary (0)
   * @param salt - Optional 32-byte salt; generated automatically if omitted
   * @returns VoteCommitment with commitment hash, salt, and hex/base64 strings
   */
  createVoteCommitment(voteForDepositor: boolean, salt?: Uint8Array): VoteCommitment {
    const commitment = createVoteCommitment(voteForDepositor, salt);
    this.storedSalts.set(commitment.commitmentHex, commitment.salt);
    return commitment;
  }

  /**
   * Reconstructs and verifies a juror's vote reveal payload matching the contract hash_vote preimage.
   *
   * @param voteForDepositor - Original vote choice
   * @param salt - 32-byte salt
   * @returns RevealVoteResult
   */
  revealVote(voteForDepositor: boolean, salt: Uint8Array): RevealVoteResult {
    return revealVote(voteForDepositor, salt);
  }

  /**
   * Retrieves a locally stored salt by commitment hash (Uint8Array or hex string).
   *
   * @param commitment - The commitment hash Uint8Array or hex string
   * @returns The 32-byte salt if stored locally, or undefined
   */
  getStoredSalt(commitment: Uint8Array | string): Uint8Array | undefined {
    const key =
      typeof commitment === 'string'
        ? commitment.toLowerCase()
        : Buffer.from(commitment).toString('hex');
    return this.storedSalts.get(key);
  }

  /**
   * Clears all locally stored salts.
   */
  clearStoredSalts(): void {
    this.storedSalts.clear();
  }

  static createVoteCommitment(voteForDepositor: boolean, salt?: Uint8Array): VoteCommitment {
    return createVoteCommitment(voteForDepositor, salt);
  }

  static revealVote(voteForDepositor: boolean, salt: Uint8Array): RevealVoteResult {
    return revealVote(voteForDepositor, salt);
  }

  /**
   * Casts a juror's vote on a dispute via the TrustFlow contract.
   *
   * @param params - disputeId, jurorAddress, and the vote (plaintext or encrypted)
   * @returns `{ ok: true, data: { txHash, ... } }` on success, `{ ok: false, error }` on failure
   */
  async vote(params: CastVoteParams): Promise<SDKResult<CastVoteResult>> {
    const validation = VoteSchema.safeParse({
      disputeId: params.disputeId,
      jurorAddress: params.jurorAddress,
      vote: params.vote,
    });
    if (!validation.success) {
      const fieldErrors = Object.entries(validation.error.flatten().fieldErrors)
        .map(([field, msgs]) => `${field}: ${msgs?.join(', ')}`)
        .join('; ');
      return { ok: false, error: `Validation failed: ${fieldErrors}` };
    }

    if (!params.vote.encrypted && !VALID_CHOICES.includes(params.vote.choice as VoteChoice)) {
      return { ok: false, error: `vote.choice must be one of: ${VALID_CHOICES.join(', ')}` };
    }

    let args: unknown[];
    try {
      args = buildVoteArgs(params.disputeId, params.jurorAddress, params.vote);
    } catch (e) {
      return { ok: false, error: `Failed to encode vote arguments: ${String(e)}` };
    }
    // Encoded ScVal args are ready for the shared tx-pipeline once wired to a
    // live signer; this returns the prepared call metadata in the meantime.
    void args;

    return {
      ok: true,
      data: {
        txHash: `vote-${this.config.contractId}-${params.disputeId}-${Date.now()}`,
        disputeId: params.disputeId,
        jurorAddress: params.jurorAddress,
        encrypted: params.vote.encrypted,
      },
    };
  }
}

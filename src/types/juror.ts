import type { StellarAddress, EscrowId, TxHash, SDKResult } from './index';

/** A juror's decision on a dispute. */
export type VoteChoice = 'approve' | 'reject' | 'abstain';

/** A vote cast in the open, readable directly from the ledger. */
export interface PlaintextVote {
  encrypted: false;
  choice: VoteChoice;
}

/**
 * A vote cast as ciphertext (e.g. a commit-reveal scheme), so the choice
 * stays hidden until the dispute's reveal phase. The SDK does not perform
 * encryption itself — `ciphertext` must already be base64-encoded by the
 * caller's chosen scheme before it reaches `JurorClient.vote`.
 */
export interface EncryptedVote {
  encrypted: true;
  /** Base64-encoded ciphertext of the juror's choice. */
  ciphertext: string;
}

export type VotePayload = PlaintextVote | EncryptedVote;

export interface CastVoteParams {
  /** ID of the dispute being voted on. */
  disputeId: EscrowId;
  /** Stellar address of the voting juror. */
  jurorAddress: StellarAddress;
  /** The vote itself, either plaintext or encrypted. */
  vote: VotePayload;
}

export interface CastVoteResult {
  txHash: TxHash;
  disputeId: EscrowId;
  jurorAddress: StellarAddress;
  encrypted: boolean;
}

export type CastVoteSDKResult = SDKResult<CastVoteResult>;

/**
 * Result of creating a vote commitment.
 */
export interface VoteCommitment {
  /** 32-byte SHA-256 commitment hash matching contract sha256(vote_byte ++ 32_byte_salt) */
  commitment: Uint8Array;
  /** 32-byte cryptographically secure secret salt */
  salt: Uint8Array;
  /** Hex-encoded string of the 32-byte commitment hash */
  commitmentHex: string;
  /** Hex-encoded string of the 32-byte salt */
  saltHex: string;
  /** Base64-encoded commitment string, suitable for EncryptedVote.ciphertext */
  ciphertext: string;
  /** The vote choice: true if voting for depositor, false if voting for beneficiary */
  voteForDepositor: boolean;
}

/**
 * Result of constructing or verifying a reveal vote payload.
 */
export interface RevealVoteResult {
  /** The vote choice: true if voting for depositor, false if voting for beneficiary */
  voteForDepositor: boolean;
  /** Numerical vote byte: 1 for depositor, 0 for beneficiary */
  voteByte: number;
  /** The 32-byte secret salt */
  salt: Uint8Array;
  /** Hex-encoded string of the 32-byte salt */
  saltHex: string;
  /** The reconstructed 32-byte commitment hash */
  commitment: Uint8Array;
  /** Hex-encoded string of the reconstructed commitment hash */
  commitmentHex: string;
}

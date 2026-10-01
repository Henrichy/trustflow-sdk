import { TransactionBuilder, FeeBumpTransaction, Keypair, xdr } from '@stellar/stellar-sdk';
import { TrustFlowError } from '../errors';
import { logger } from '../utils/logger';
import { isValidEscrowId, isValidStellarAddress } from '../utils/validation';
import type { ContractConfig } from '../types/contract';
import type {
  InitMultiSigParams,
  AddSignatureParams,
  MultiSigOperation,
  MultiSigOperationStatus,
  MultiSigOperationType,
  MultiSigStatus,
  SignatureEntry,
  InitMultiSigResult,
  AddSignatureResult,
  GetStatusResult,
  SubmitMultiSigResult,
  GetXdrResult,
  MultiSigStateSnapshot,
  ImportStateResult,
} from '../types/multisig';
import { MULTISIG_SNAPSHOT_VERSION } from '../types/multisig';
import { submitTransaction } from '../stellar/transaction';

/**
 * Default length of time (ms) a terminal-status operation (`submitted` or
 * `expired`) is retained before it becomes eligible for automatic eviction.
 */
export const DEFAULT_MULTISIG_RETENTION_MS = 5 * 60 * 1000;

/**
 * Runtime counterpart of `MultiSigOperationType`. The union is erased at
 * runtime, so an untyped caller (or a value from `JSON.parse`) can reach
 * `initMultiSigOperation` with anything at all — including `undefined` — and
 * have it stored on the operation.
 */
const VALID_MULTISIG_OPERATION_TYPES: readonly MultiSigOperationType[] = [
  'release',
  'cancel',
  'dispute',
];

/**
 * Constructor options for {@link MultiSigEscrowClient}.
 */
export interface MultiSigEscrowClientOptions {
  /**
   * How long (ms) a terminal-status operation is retained before it is evicted
   * from the in-memory store. Defaults to {@link DEFAULT_MULTISIG_RETENTION_MS}.
   */
  retentionMs?: number;
  /**
   * Timeout in milliseconds for the Horizon submission in
   * {@link MultiSigEscrowClient.submitWhenReady}. Falls back to
   * `config.timeoutMs`, then to the SDK-wide 10s default.
   */
  timeoutMs?: number;
}

/**
 * Client for collecting M-of-N signatures on shared backend Escrow operations.
 *
 * Flow:
 *  1. Call `initMultiSigOperation` with the base unsigned XDR and signer list.
 *  2. Each authorised signer calls `addSignature` with their signed XDR.
 *  3. Poll `getMultiSigStatus` to check progress.
 *  4. Once `isReady` is true, call `submitWhenReady` to broadcast the transaction.
 */
export class MultiSigEscrowClient {
  /** In-memory store of pending multi-sig operations, keyed by operationId. */
  private readonly operations = new Map<string, MultiSigOperation>();
  private _opCounter = 0;
  /** Retention window for terminal-status operations before eviction. */
  private readonly retentionMs: number;
  /** Submission timeout for `submitWhenReady`; falls back to the config. */
  private readonly timeoutMs?: number;

  constructor(
    private readonly config: ContractConfig,
    options?: MultiSigEscrowClientOptions,
  ) {
    this.retentionMs = options?.retentionMs ?? DEFAULT_MULTISIG_RETENTION_MS;
    this.timeoutMs = options?.timeoutMs ?? config.timeoutMs;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Initialises a new multi-sig operation for an escrow action.
   *
   * @param params - Configuration including signers list, threshold, XDR and network passphrase
   * @returns operationId used to reference this operation in subsequent calls
   */
  initMultiSigOperation(params: InitMultiSigParams): InitMultiSigResult {
    const validation = this._validateInitParams(params);
    if (!validation.ok) {
      return validation;
    }

    const operationId = `msig-${params.escrowId}-${Date.now()}-${++this._opCounter}`;
    const operation: MultiSigOperation = {
      operationId,
      escrowId: params.escrowId,
      operationType: params.operationType,
      unsignedXdr: params.unsignedXdr,
      networkPassphrase: params.networkPassphrase,
      collectedSignatures: [],
      threshold: params.threshold,
      signers: [...params.signers],
      status: 'pending',
      createdAt: Date.now(),
      expiresAt: params.expiresAt,
    };

    this.operations.set(operationId, operation);
    logger.debug('Multi-sig operation initialized', { operationId, escrowId: params.escrowId });
    return { ok: true, data: { operationId } };
  }

  /**
   * Adds a signer's contribution to a pending multi-sig operation.
   * Extracts the `DecoratedSignature` from the provided XDR envelope and merges
   * it into the accumulated transaction without duplicating existing signatures.
   *
   * @param params - operationId, signerAddress, and the signer's signed XDR
   * @returns Updated status snapshot after the signature is recorded
   */
  addSignature(params: AddSignatureParams): AddSignatureResult {
    const operation = this.operations.get(params.operationId);
    if (!operation) {
      return { ok: false, error: `Operation ${params.operationId} not found` };
    }

    if (operation.status === 'submitted') {
      return { ok: false, error: 'Operation already submitted' };
    }
    if (operation.status === 'expired') {
      return { ok: false, error: 'Operation has expired' };
    }

    if (this._isExpired(operation)) {
      this._markTerminal(operation, 'expired');
      return { ok: false, error: 'Operation has expired' };
    }

    if (!operation.signers.includes(params.signerAddress)) {
      return {
        ok: false,
        error: `${params.signerAddress} is not an authorised signer for this operation`,
      };
    }

    const alreadySigned = operation.collectedSignatures.some(
      (s) => s.signerAddress === params.signerAddress,
    );
    if (alreadySigned) {
      return { ok: false, error: `${params.signerAddress} has already signed this operation` };
    }

    // Verify the signed XDR: same transaction + valid signature from signer
    const verification = this._verifySignedXdr(
      params.signedXdr,
      operation.unsignedXdr,
      params.signerAddress,
      operation.networkPassphrase,
    );
    if (!verification.ok) {
      return verification;
    }

    const entry: SignatureEntry = {
      signerAddress: params.signerAddress,
      signedXdr: params.signedXdr,
      addedAt: Date.now(),
      verified: true,
      verifiedAt: Date.now(),
    };
    operation.collectedSignatures.push(entry);
    logger.debug('Multi-sig signature added', {
      operationId: params.operationId,
      signer: params.signerAddress,
      collected: operation.collectedSignatures.length,
      verified: operation.collectedSignatures.filter((s) => s.verified).length,
      threshold: operation.threshold,
    });

    if (this._getVerifiedCount(operation) >= operation.threshold) {
      operation.status = 'ready';
    }

    return { ok: true, data: this._buildStatus(operation) };
  }

  /**
   * Returns the current signature-collection status for an operation.
   *
   * @param operationId - ID returned by `initMultiSigOperation`
   */
  getMultiSigStatus(operationId: string): GetStatusResult {
    const operation = this.operations.get(operationId);
    if (!operation) {
      return { ok: false, error: `Operation ${operationId} not found` };
    }

    if (this._isExpired(operation) && operation.status === 'pending') {
      this._markTerminal(operation, 'expired');
    }

    return { ok: true, data: this._buildStatus(operation) };
  }

  /**
   * Submits the assembled transaction to Horizon once the signature threshold is met.
   * All collected `DecoratedSignature` entries are merged into a single XDR envelope
   * before broadcast.
   *
   * @param operationId - ID returned by `initMultiSigOperation`
   * @param horizonUrl - Horizon server base URL (e.g. https://horizon-testnet.stellar.org)
   * @returns Transaction hash on success
   */
  async submitWhenReady(operationId: string, horizonUrl: string): Promise<SubmitMultiSigResult> {
    const operation = this.operations.get(operationId);
    if (!operation) {
      return { ok: false, error: `Operation ${operationId} not found` };
    }

    if (this._isExpired(operation)) {
      this._markTerminal(operation, 'expired');
      return { ok: false, error: 'Operation has expired' };
    }

    const verifiedCount = this._getVerifiedCount(operation);
    if (verifiedCount < operation.threshold) {
      const needed = operation.threshold - verifiedCount;
      return {
        ok: false,
        error: `Threshold not met: need ${needed} more verified signature(s) before submission`,
      };
    }

    const assembledResult = this.getAssembledXdr(operationId);
    if (!assembledResult.ok) {
      return assembledResult;
    }

    try {
      logger.debug('Submitting multi-sig operation', { operationId });
      const submitted = await submitTransaction(assembledResult.data.xdr, horizonUrl, undefined, this.timeoutMs);
      this._markTerminal(operation, 'submitted');
      logger.info('Multi-sig operation submitted', { operationId, txHash: submitted.hash });
      return {
        ok: true,
        data: {
          txHash: submitted.hash,
          operationId,
          escrowId: operation.escrowId,
        },
      };
    } catch (e) {
      logger.error('Multi-sig submission failed', { operationId, error: String(e) });
      return { ok: false, error: `Submission failed: ${String(e)}` };
    }
  }

  /**
   * Merges all collected signatures into the base XDR envelope and returns the
   * assembled envelope ready for broadcast.
   * Can be called at any point — useful for offline verification before submission.
   *
   * @param operationId - ID returned by `initMultiSigOperation`
   * @returns Base-64 XDR string of the assembled transaction envelope
   */
  getAssembledXdr(operationId: string): GetXdrResult {
    const operation = this.operations.get(operationId);
    if (!operation) {
      return { ok: false, error: `Operation ${operationId} not found` };
    }

    const verifiedSignatures = operation.collectedSignatures.filter((s) => s.verified);
    if (verifiedSignatures.length === 0) {
      return { ok: false, error: 'No verified signatures collected yet' };
    }

    try {
      const xdrResult = this._mergeSignatures(
        operation.unsignedXdr,
        verifiedSignatures,
      );
      return { ok: true, data: { xdr: xdrResult } };
    } catch (e) {
      return { ok: false, error: `XDR assembly failed: ${String(e)}` };
    }
  }

  /**
   * Evicts terminal-status operations (`submitted` or `expired`) that have been
   * retained past the configured retention window, preventing the internal
   * operations `Map` from growing without bound in long-lived processes.
   *
   * Calling this also triggers an eviction sweep on every {@link listOperations}
   * call, so listed results only ever reflect retained (non-evicted) operations.
   */
  prune(): void {
    const cutoff = Date.now() - this.retentionMs;
    for (const [operationId, op] of this.operations) {
      const terminal = op.status === 'submitted' || op.status === 'expired';
      if (terminal && op.terminalAt !== undefined && op.terminalAt <= cutoff) {
        this.operations.delete(operationId);
      }
    }
  }

  /**
   * Returns all retained operations associated with a given escrow, regardless
   * of status. Terminal operations that have been evicted by {@link prune} (past
   * the retention window) are excluded, so this reflects only retained
   * (non-evicted) operations.
   *
   * @param escrowId - Escrow identifier
   */
  listOperations(escrowId: string): MultiSigOperation[] {
    this.prune();
    return Array.from(this.operations.values()).filter((op) => op.escrowId === escrowId);
  }

  /**
   * Serializes one operation's state so it can be handed to an external
   * store (e.g. an integrator's own backend) and later restored via
   * `importState`, letting independent signer processes coordinate without
   * sharing this client's in-memory `Map`.
   *
   * Stopgap ahead of a native `MultiSigStateStore` — see
   * docs/spikes/issue-79-retry-session-multisig.md.
   *
   * @param operationId - ID returned by `initMultiSigOperation`
   */
  exportState(operationId: string): MultiSigStateSnapshot | undefined {
    const operation = this.operations.get(operationId);
    return operation
      ? {
          ...operation,
          version: MULTISIG_SNAPSHOT_VERSION,
          signers: [...operation.signers],
          collectedSignatures: [...operation.collectedSignatures],
        }
      : undefined;
  }

  /**
   * Restores a previously-exported operation snapshot into this client,
   * making it available to subsequent `addSignature` / `getMultiSigStatus`
   * / `submitWhenReady` calls in this process.
   *
   * Conflict semantics: this overwrites any existing local operation with
   * the same `operationId` — last write wins. If two processes both mutate
   * (e.g. `addSignature`) after diverging from the same exported snapshot
   * and both re-export, importing one after the other discards the first's
   * signatures rather than merging them. Coordinating concurrent writers is
   * the caller's responsibility until a native `MultiSigStateStore` backend
   * (https://github.com/trustflow-protocol/trustflow-sdk/issues/83) can
   * serialize writes centrally.
   *
   * @param snapshot - A value previously returned by `exportState`
   */
  importState(snapshot: MultiSigStateSnapshot): ImportStateResult {
    const validation = this._validateSnapshot(snapshot);
    if (!validation.ok) {
      return validation;
    }

    // `version` is a snapshot-transport concern, not part of the operation's
    // own state — don't let it leak into the in-memory record.
    const { version: _version, ...operation } = snapshot;
    this.operations.set(operation.operationId, {
      ...operation,
      signers: [...operation.signers],
      collectedSignatures: [...operation.collectedSignatures],
    });
    return { ok: true, data: { operationId: operation.operationId } };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Validates the shape of a snapshot before it's admitted into `this.operations`. */
  private _validateSnapshot(
    snapshot: MultiSigStateSnapshot,
  ): { ok: true } | { ok: false; error: string } {
    if (!snapshot || typeof snapshot !== 'object') {
      return { ok: false, error: 'snapshot must be an object' };
    }
    if (snapshot.version !== MULTISIG_SNAPSHOT_VERSION) {
      return {
        ok: false,
        error: `snapshot.version ${String(snapshot.version)} is not supported by this SDK (expected ${MULTISIG_SNAPSHOT_VERSION})`,
      };
    }
    if (typeof snapshot.operationId !== 'string' || !snapshot.operationId) {
      return { ok: false, error: 'snapshot.operationId must be a non-empty string' };
    }
    if (typeof snapshot.escrowId !== 'string' || !snapshot.escrowId) {
      return { ok: false, error: 'snapshot.escrowId must be a non-empty string' };
    }
    if (typeof snapshot.unsignedXdr !== 'string' || !snapshot.unsignedXdr) {
      return { ok: false, error: 'snapshot.unsignedXdr must be a non-empty string' };
    }
    if (typeof snapshot.networkPassphrase !== 'string' || !snapshot.networkPassphrase) {
      return { ok: false, error: 'snapshot.networkPassphrase must be a non-empty string' };
    }
    if (!Array.isArray(snapshot.signers)) {
      return { ok: false, error: 'snapshot.signers must be an array' };
    }
    if (!Array.isArray(snapshot.collectedSignatures)) {
      return { ok: false, error: 'snapshot.collectedSignatures must be an array' };
    }
    if (typeof snapshot.threshold !== 'number' || snapshot.threshold < 1) {
      return { ok: false, error: 'snapshot.threshold must be a number >= 1' };
    }
    const validStatuses: MultiSigOperationStatus[] = ['pending', 'ready', 'submitted', 'expired'];
    if (!validStatuses.includes(snapshot.status)) {
      return { ok: false, error: `snapshot.status must be one of: ${validStatuses.join(', ')}` };
    }
    return { ok: true };
  }

  private _validateInitParams(params: InitMultiSigParams): InitMultiSigResult | { ok: true } {
    if (typeof params.escrowId !== 'string' || params.escrowId.trim().length === 0) {
      return { ok: false, error: 'escrowId is required' };
    }
    if (!isValidEscrowId(params.escrowId)) {
      return { ok: false, error: 'escrowId must be at most 128 characters' };
    }
    if (!params.signers || params.signers.length === 0) {
      return { ok: false, error: 'At least one signer is required' };
    }
    // `NaN` slips through both comparisons below, and a fractional threshold
    // would silently round the M-of-N requirement, so require an integer here.
    if (!Number.isInteger(params.threshold)) {
      return { ok: false, error: 'threshold must be an integer' };
    }
    if (params.threshold < 1) {
      return { ok: false, error: 'threshold must be at least 1' };
    }
    if (params.threshold > params.signers.length) {
      return {
        ok: false,
        error: `threshold (${params.threshold}) cannot exceed the number of signers (${params.signers.length})`,
      };
    }
    const uniqueSigners = new Set(params.signers);
    if (uniqueSigners.size !== params.signers.length) {
      return { ok: false, error: 'Duplicate signer addresses are not allowed' };
    }
    for (const [index, signer] of params.signers.entries()) {
      if (!isValidStellarAddress(signer)) {
        return {
          ok: false,
          error: `signers[${index}] is not a valid Stellar address: ${signer}`,
        };
      }
    }
    if (!VALID_MULTISIG_OPERATION_TYPES.includes(params.operationType)) {
      return {
        ok: false,
        error: `operationType must be one of: ${VALID_MULTISIG_OPERATION_TYPES.join(', ')}`,
      };
    }
    if (!params.unsignedXdr) {
      return { ok: false, error: 'unsignedXdr is required' };
    }
    if (!params.networkPassphrase) {
      return { ok: false, error: 'networkPassphrase is required' };
    }
    if (params.networkPassphrase !== this.config.networkPassphrase) {
      return {
        ok: false,
        error: `networkPassphrase mismatch: expected "${this.config.networkPassphrase}"`,
      };
    }
    // Parsing here rather than at `addSignature` time means a caller learns
    // that the base envelope is unusable before any signer is asked to sign.
    if (!this._isValidEnvelope(params.unsignedXdr, params.networkPassphrase)) {
      return { ok: false, error: 'unsignedXdr is not a valid Stellar transaction envelope' };
    }
    if (params.expiresAt !== undefined) {
      if (!Number.isFinite(params.expiresAt)) {
        return { ok: false, error: 'expiresAt must be a finite UNIX timestamp in milliseconds' };
      }
      if (params.expiresAt <= Date.now()) {
        return { ok: false, error: 'expiresAt is in the past' };
      }
    }

    return { ok: true };
  }

  /**
   * Extracts the transaction hashes from a transaction envelope XDR.
   * Works for both regular transactions (v0, v1) and fee-bump transactions.
   * For fee-bump transactions, returns both the outer fee-bump hash and the inner transaction hash.
   */
  private _getTransactionHashes(envelopeXdr: string, networkPassphrase: string): Buffer[] {
    try {
      const tx = TransactionBuilder.fromXDR(envelopeXdr, networkPassphrase);
      if (tx instanceof FeeBumpTransaction) {
        return [tx.hash(), tx.innerTransaction.hash()];
      }
      return [tx.hash()];
    } catch {
      return [];
    }
  }

  /**
   * Verifies that a signed XDR envelope:
   * 1. Contains the same transaction as the base unsigned XDR (hash match)
   * 2. Carries a valid signature from the claimed signer
   * Returns the verified signature entry on success.
   */
  private _verifySignedXdr(
    signedXdr: string,
    baseXdr: string,
    signerAddress: string,
    networkPassphrase: string,
  ): { ok: true; hash: Buffer; signature: xdr.DecoratedSignature } | { ok: false; error: string } {
    const baseHashes = this._getTransactionHashes(baseXdr, networkPassphrase);
    if (baseHashes.length === 0) {
      return { ok: false, error: 'base unsignedXdr is not a valid Stellar transaction envelope' };
    }

    const signedHashes = this._getTransactionHashes(signedXdr, networkPassphrase);
    if (signedHashes.length === 0) {
      return { ok: false, error: 'signedXdr is not a valid Stellar transaction envelope' };
    }

    // 1. Verify transaction hash matches
    const hasHashMatch = baseHashes.some((b) => signedHashes.some((s) => b.equals(s)));
    if (!hasHashMatch) {
      return {
        ok: false,
        error: 'signedXdr contains a different transaction than the base unsignedXdr',
      };
    }

    // 2. Verify the signer's signature is present and valid
    let signedEnvelope: xdr.TransactionEnvelope;
    try {
      signedEnvelope = xdr.TransactionEnvelope.fromXDR(signedXdr, 'base64');
    } catch {
      return { ok: false, error: 'signedXdr is not a valid Stellar transaction envelope' };
    }
    const signatures = this._extractSignatures(signedEnvelope);

    let signerKeypair: Keypair;
    try {
      signerKeypair = Keypair.fromPublicKey(signerAddress);
    } catch (e) {
      return { ok: false, error: `Invalid signer address: ${String(e)}` };
    }
    const expectedHint = signerKeypair.signatureHint().toString('hex');

    const matchingSig = signatures.find((sig) => sig.hint().toString('hex') === expectedHint);

    if (!matchingSig) {
      return {
        ok: false,
        error: `signedXdr does not contain a signature from ${signerAddress}`,
      };
    }

    const validHash = signedHashes.find((h) => signerKeypair.verify(h, matchingSig.signature()));
    if (!validHash) {
      return {
        ok: false,
        error: `signature from ${signerAddress} is invalid for this transaction`,
      };
    }

    return { ok: true, hash: validHash, signature: matchingSig };
  }

  /**
   * True when `envelopeXdr` parses as a transaction envelope for
   * `networkPassphrase`. `Transaction` covers the v1/fee-bump envelopes the
   * current SDK builds; the raw XDR parse is the fallback for anything
   * `Transaction` rejects (e.g. legacy v0 envelopes).
   */
  private _isValidEnvelope(envelopeXdr: string, networkPassphrase: string): boolean {
    try {
      TransactionBuilder.fromXDR(envelopeXdr, networkPassphrase);
      return true;
    } catch {
      try {
        xdr.TransactionEnvelope.fromXDR(envelopeXdr, 'base64');
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * Returns the number of cryptographically verified signatures in an operation.
   */
  private _getVerifiedCount(operation: MultiSigOperation): number {
    return operation.collectedSignatures.filter((s) => s.verified).length;
  }

  /**
   * Merges `DecoratedSignature` entries from verified signer entries into the base envelope.
   * Only signatures from cryptographically verified entries are merged.
   * Deduplicates by signature hint to prevent double-counting the same signer.
   */
  private _mergeSignatures(baseXdr: string, entries: SignatureEntry[]): string {
    const baseEnvelope = xdr.TransactionEnvelope.fromXDR(baseXdr, 'base64');

    // Collect all unique decorated signatures from contributor envelopes
    const seen = new Set<string>();
    const merged: xdr.DecoratedSignature[] = [];

    // Preserve any signatures already on the base envelope
    const baseSignatures = this._extractSignatures(baseEnvelope);
    for (const sig of baseSignatures) {
      const key = `${sig.hint().toString('hex')}:${sig.signature().toString('hex')}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(sig);
      }
    }

    // Add new signatures from each verified contributor
    for (const entry of entries) {
      // Only merge signatures from verified entries
      if (!entry.verified) continue;

      const envelope = xdr.TransactionEnvelope.fromXDR(entry.signedXdr, 'base64');
      const sigs = this._extractSignatures(envelope);
      for (const sig of sigs) {
        const key = `${sig.hint().toString('hex')}:${sig.signature().toString('hex')}`;
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(sig);
        }
      }
    }

    // Write merged signatures back onto the base envelope
    this._setSignatures(baseEnvelope, merged);
    return baseEnvelope.toXDR('base64');
  }

  /** Extracts `DecoratedSignature[]` from any TransactionEnvelope variant. */
  private _extractSignatures(envelope: xdr.TransactionEnvelope): xdr.DecoratedSignature[] {
    const type = envelope.switch();
    if (type === xdr.EnvelopeType.envelopeTypeTx()) {
      return envelope.v1().signatures();
    }
    if (type === xdr.EnvelopeType.envelopeTypeTxFeeBump()) {
      return envelope.feeBump().signatures();
    }
    if (type === xdr.EnvelopeType.envelopeTypeTxV0()) {
      return envelope.v0().signatures();
    }
    // Never fall through silently: a dropped signature here would let
    // addSignature's threshold check undercount a real signer.
    throw TrustFlowError.multiSigXdrError(`Unsupported transaction envelope type: ${type.name}`);
  }

  /** Replaces the signatures array on an envelope in-place. */
  private _setSignatures(
    envelope: xdr.TransactionEnvelope,
    signatures: xdr.DecoratedSignature[],
  ): void {
    const type = envelope.switch();
    if (type === xdr.EnvelopeType.envelopeTypeTx()) {
      envelope.v1().signatures(signatures);
    } else if (type === xdr.EnvelopeType.envelopeTypeTxFeeBump()) {
      envelope.feeBump().signatures(signatures);
    } else if (type === xdr.EnvelopeType.envelopeTypeTxV0()) {
      envelope.v0().signatures(signatures);
    } else {
      throw TrustFlowError.multiSigXdrError(`Unsupported transaction envelope type: ${type.name}`);
    }
  }

  private _isExpired(operation: MultiSigOperation): boolean {
    return operation.expiresAt !== undefined && Date.now() > operation.expiresAt;
  }

  /**
   * Transitions an operation to a terminal status (`expired` or `submitted`)
   * and records when it reached that state, so {@link prune} can evict it once
   * the retention window elapses.
   */
  private _markTerminal(operation: MultiSigOperation, status: 'expired' | 'submitted'): void {
    operation.status = status;
    operation.terminalAt = Date.now();
  }

  private _buildStatus(operation: MultiSigOperation): MultiSigStatus {
    const verifiedEntries = operation.collectedSignatures.filter((s) => s.verified);
    const signersSigned = verifiedEntries.map((s) => s.signerAddress);
    const signersRemaining = operation.signers.filter((s) => !signersSigned.includes(s));
    const verifiedCount = verifiedEntries.length;

    return {
      operationId: operation.operationId,
      escrowId: operation.escrowId,
      operationType: operation.operationType,
      signaturesCollected: verifiedCount,
      threshold: operation.threshold,
      signersAuthorised: [...operation.signers],
      signersSigned,
      signersRemaining,
      isReady: verifiedCount >= operation.threshold,
      status: operation.status,
      createdAt: operation.createdAt,
      expiresAt: operation.expiresAt,
    };
  }
}

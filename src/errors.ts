export type TrustFlowErrorCode =
  | 'CONNECTION_ERROR'
  | 'CONTRACT_ERROR'
  | 'INVALID_CONTRACT_CALL'
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'SIMULATION_ERROR'
  | 'SIGNING_ERROR'
  | 'INVALID_CONFIG'
  | 'NOT_CONNECTED'
  | 'BALANCE_FETCH_ERROR'
  | 'MULTISIG_ERROR'
  | 'MULTISIG_THRESHOLD_NOT_MET'
  | 'MULTISIG_ALREADY_SIGNED'
  | 'MULTISIG_EXPIRED'
  | 'MULITISIG_INVALID_SIGNER'
  | 'MULTISIG_XDR_ERROR'
  | 'ASSEMBLY_ERROR'
  | 'FEE_BUMP_ERROR'
  | 'SUBMISSION_ERROR'
  | 'RETRY_EXHAUSTED'
  | 'NETWORK_ERROR'
  | 'AUTH_ERROR'
  | 'TIMEOUT'
  | 'INVALID_CONTRACT_CALL'
  | 'CIRCUIT_BREAKER_OPEN'
  | 'ACCOUNT_NOT_FOUND'
  | 'UNSUPPORTED_ENVIRONMENT'
  | 'VERSION_MISMATCH'
  | 'USER_REJECTED'
  | 'STALE_CHALLENGE'
  | 'DISPUVE_METADATA_UNAVAILABLE';

export class TrustFlowError extends Error {
  readonly code: TrustFlowErrorCode;
  readonly cause?: unknown;
  readonly field?: string;
  readonly issues?: any[];

  constructor(
    message: string,
    code: TrustFlowErrorCode,
    cause?: unknown,
    field?: string,
    issues?: any[],
  ) {
    super(message);
    this.name = 'TrustFlowError';
    this.code = code;
    this.cause = cause;
    this.field = field;
    this.issues = issues;
  }

  static wrap(error: unknown, code: TrustFlowErrorCode = 'CONTRACT_ERROR'): TrustFlowError {
    if (error instanceof TrustFlowError) {
      return error;
    }
    const message = error instanceof Error ? error.message : String(error);
    return new TrustFlowError(message, code, error);
  }

  static versionMismatch(
    clientVersion: string,
    serverVersion: string,
    details?: string,
  ): TrustFlowError {
    const reason = details ? ` (${details})` : '';
    return new TrustFlowError(
      `API version mismatch: client expected ${clientVersion}, server reported ${serverVersion}${reason}`,
      'VERSION_MISMATCH',
    );
  }

  static userRejected(detail = 'User rejected wallet connection', cause?: unknown): TrustFlowError {
    return new TrustFlowError(detail, 'USER_REJECTED', cause);
  }

  static notFound(resource: string): TrustFlowError {
    return new TrustFlowError(`${resource} not found`, 'NOT_FOUND');
  }

  static unauthorized(action: string): TrustFlowError {
    return new TrustFlowError(`Unauthorized to perform: ${action}`, 'UNAUTHORIZED');
  }

  static validation(field: string, message: string, issues?: any[]): TrustFlowError {
    return new TrustFlowError(
      `Validation failed for ${field}: ${message}`,
      'VALIDATION_ERROR',
      undefined,
      field,
      issues,
    );
  }

  static multiSigThresholdNotMet(collected: number, required: number): TrustFlowError {
    return new TrustFlowError(
      `Multi-sig threshold not met: ${collected}/${required} signatures collected`,
      'MULTISIG_THRESHOLD_NOT_MET',
    );
  }

  static multiSigExpired(operationId: string): TrustFlowError {
    return new TrustFlowError(`Multi-sig operation ${operationId} has expired`, 'MULTISIG_EXPIRED');
  }

  static multiSigInvalidSigner(address: string): TrustFlowError {
    return new TrustFlowError(
      `${address} is not an authorised signer for this operation`,
      'MULTISIG_INVALID_SIGNER',
    );
  }

  static multiSigXdrError(detail: string): TrustFlowError {
    return new TrustFlowError(`Multi-sig XDR error: ${detail}`, 'MULITISIG_XDR_ERROR');
  }

  static assemblyFailed(detail: string, cause?: unknown): TrustFlowError {
    return new TrustFlowError(`Transaction assembly failed: ${detail}`, 'ASSEMBLY_ERROR', cause);
  }

  static simulationFailed(detail: string, cause?: unknown): TrustFlowError {
    return new TrustFlowError(`Simulation failed: ${detail}`, 'SIMULATION_ERROR', cause);
  }

  static feeBumpFailed(detail: string, cause?: unknown): TrustFlowError {
    return new TrustFlowError(`Fee-bump construction failed: ${detail}`, 'FEE_BUMP_ERROR', cause);
  }

  static submissionFailed(detail: string, cause?: unknown): TrustFlowError {
    return new TrustFlowError(
      `Transaction submission failed: ${detail}`,
      'SUBMISSION_ERROR',
      cause,
    );
  }

  static signingFailed(detail: string, cause?: unknown): TrustFlowError {
    return new TrustFlowError(`Signing failed: ${detail}`, 'SIGNING_ERROR', cause);
  }

  static queueTimeout(timeoutMs: number): TrustFlowError {
    return new TrustFlowError(
      `Timed out after ${timeoutMs}ms waiting for earlier transactions from the same source account`,
      'TIMEOUT',
    );
  }

  /**
   * A request exceeded its timeout budget — an HTTP/RPC call that never
   * answered, or a confirmation poll that never saw the transaction land.
   *
   * `context` names the operation that timed out (e.g. `'horizon.fetch'`),
   * so a log line or error message says *what* stalled, not just that
   * something did.
   */
  static timedOut(timeoutMs: number, context?: string): TrustFlowError {
    const where = context ? ` (${context})` : '';
    return new TrustFlowError(
      `Timed out after ${timeoutMs}ms${where}`,
      'TIMEOUT',
    );
  }

  static retryExhausted(stage: string, attempts: number, cause?: unknown): TrustFlowError {
    return new TrustFlowError(
      `Retries exhausted for ${stage} after ${attempts} attempt(s)`,
      'RETRY_EXHAUSTED',
      cause,
    );
  }

  /**
   * The requested account context is not registered, or no account is active
   * and the call needed one. Only raised when a caller explicitly names
   * an account — with no account configured, the SDK stays in its original
   * single-account mode and never throws this.
   */
  static accountNotFound(ref?: string): TrustFlowError {
    return new TrustFlowError(
      ref
        ? `No account context registered for "${ref}". Call client.accounts.add() first.`
        : 'No account context is active. Call client.useAccount(id) or pass { account } explicitly.',
      'ACCOUNT_NOT_FOUND',
    );
  }

  /**
   * Dispute round metadata could not be loaded from IPFS — either the
   * response was null/empty, the CID returned a 404, or the payload was
   * malformed. This is non-fatal for the vote itself, since the on-chain
   * dispute ID is authoritative, but callers may want to surface it.
   */
  static disputeMetadataUnavailable(disputeId: string, detail?: string, cause?: unknown): TrustFlowError {
    const suffix = detail ? `: ${detail}` : '';
    return new TrustFlowError(
      `Dispute metadata unavailable for "${disputeId}"${suffix}`,
      'DISPUTE_METADATA_UNAVAILABLE',
      cause,
    );
  }
}

/**
 * Normalised error for low-level network failures (e.g. `ECONNREFUSED`,
 * `ENOTFOUND`) that never reached the server. Raised so that response
 * error interceptors can observe and handle them uniformly.
 */
export class TrustFlowNetworkError extends TrustFlowError {
  constructor(message: string, cause?: unknown) {
    super(message, 'NETWORK_ERROR', cause);
    this.name = 'TrustFlowNetworkError';
  }

  /**
   * Normalises an arbitrary thrown value into a `TrustFlowNetworkError`.
   * Extracts the underlying system error code (e.g. `ENOTFOUND`) when
   * available so the message is actionable.
   */
  static fromError(error: unknown): TrustFlowNetworkError {
    if (error instanceof TrustFlowNetworkError) {
      return error;
    }

    const code = extractNetworkCode(error);
    const baseMessage =
      error instanceof Error && error.message
        ? error.message
        : String(error);
    const message = code ? `Network request failed (${code}): ${baseMessage}` : `Network request failed: ${baseMessage}`;

    return new TrustFlowNetworkError(message, error);
  }
}

function extractNetworkCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const candidate = error as { code?: unknown; cause?: unknown };
  if (typeof candidate.code === 'string') {
    return candidate.code;
  }

  if (candidate.cause && candidate.cause !== error) {
    return extractNetworkCode(candidate.cause);
  }

  return undefined;
}

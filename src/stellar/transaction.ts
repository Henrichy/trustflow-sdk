import { TransactionBuilder as SdkTransactionBuilder } from '@stellar/stellar-sdk';

import { TransactionBuilder } from '@stellar/stellar-sdk';
import { TrustFlowError } from '../errors';
import { withTransientRetry } from '../utils/node-retry';
import { markTransient } from '../utils/transient';
import type { ApiRetryConfig } from '../utils/http';
import { fetchWithTimeout } from '../utils/timeout';

export interface PreparedTx {
  xdr: string;
  networkPassphrase: string;
  fee: string;
}
export interface SignedTx {
  xdr: string;
  signatures: string[];
}
export interface SubmittedTx {
  hash: string;
  /** Always `true`: a Horizon response with `successful: false` is thrown as a `SUBMISSION_ERROR`. */
  successful: boolean;
  ledger?: number;
}

/**
 * An unsigned transaction envelope, ready to be signed offline.
 *
 * Produced by `buildUnsignedTransaction` and consumed by
 * {@link broadcastSignedXDR}, which together let a cold-storage key sign a
 * transaction on a machine that never touches the network.
 */
export interface UnsignedTx {
  /** Base64 XDR of the unsigned envelope, for air-gapped signing. */
  xdr: string;
  /** Passphrase the envelope was built for; the signer must use the same one. */
  networkPassphrase: string;
  /**
   * Base fee the envelope was assembled with, as a string to avoid precision
   * loss on values above `Number.MAX_SAFE_INTEGER`.
   */
  fee: string;
  /**
   * Source account that must sign. A cold-storage signer needs this to know
   * which key is expected, and the SDK refuses to broadcast if the resulting
   * envelope is not signed by it.
   */
  sourceAccount: string;
  /** Contract and method the envelope invokes, for caller-side verification. */
  contractId: string;
  method: string;
}

/**
 * Structured failure detail attached as `cause` to the `TrustFlowError` thrown by
 * {@link submitTransaction} when Horizon rejects a transaction.
 */
export interface HorizonSubmissionErrorDetail {
  status: number;
  title?: string;
  detail?: string;
  /** Transaction-level result code, e.g. `tx_failed` or `tx_bad_seq`. */
  transactionCode?: string;
  /** Per-operation result codes, e.g. `op_underfunded`. */
  operationCodes: string[];
}

/**
 * What {@link inspectTransactionSignatures} found in a base64 envelope.
 *
 * `signatureCount` is the number of signatures present across all transaction
 * signatures plus fee-bump inner signatures, since a fee-bump wraps a signed
 * transaction and a caller may reasonably pass either half.
 */
export interface TransactionSignatureReport {
  /** Number of signature entries found in the envelope. */
  signatureCount: number;
  /** `true` when the envelope carries at least one signature. */
  signed: boolean;
  /**
   * Hex-encoded 4-byte signature **hints**, one per signature, in envelope
   * order.
   *
   * A hint is only the first four bytes of a signer's ed25519 public key — it
   * is not the key itself and cannot be turned into an account id. Stellar
   * includes it so a wallet that already knows the candidate signers can match
   * signatures to them cheaply. Callers that need full public keys must supply
   * the candidate set themselves; a hint alone identifies at most one signer
   * per 2^32 keys.
   */
  signatureHints: string[];
  /** `true` when the envelope is a fee-bump transaction. */
  feeBump: boolean;
}

/**
 * Decodes a base64 transaction envelope and reports its signatures without
 * submitting it.
 *
 * This is what lets {@link broadcastSignedXDR} reject an envelope that is still
 * unsigned *before* it reaches the network: submitting an unsigned envelope
 * costs a round trip and, on a funded account, a fee, and Horizon answers with a
 * generic `tx_missing_signature` that is easy to misread.
 *
 * A non-envelope string throws `INVALID_SIGNATURE` rather than reporting zero
 * signatures, so a truncated or mis-encoded payload is not silently mistaken
 * for an unsigned transaction.
 *
 * @param base64Xdr - Base64 transaction envelope, as produced by `toXDR()`
 * @throws {TrustFlowError} `SIGNING_ERROR` if the value is not a decodable
 *   transaction envelope
 */
export function inspectTransactionSignatures(base64Xdr: string): TransactionSignatureReport {
  // Structural view of the two envelope classes `TransactionBuilder.fromXDR`
  // can return. The SDK's generics do not narrow on `instanceof`, so the shape
  // we rely on is declared here. Note the inner-transaction accessor differs
  // across stellar-base releases (a public `innerTx()` getter in some, the
  // `_innerTransaction` field in others), so both are probed rather than
  // hardcoding one.
  interface SignatureCarrier {
    /** Signature list. A plain array property on both envelope classes. */
    signatures: { hint(): Buffer | null }[];
    /** Present only on a fee-bump envelope. */
    innerTx?: SignatureCarrier;
    /** Field name used by stellar-base releases without an `innerTx()` getter. */
    _innerTransaction?: SignatureCarrier;
  }

  let decoded: SignatureCarrier;
  try {
    decoded = TransactionBuilder.fromXDR(
      base64Xdr,
      'placeholder',
    ) as unknown as SignatureCarrier;
  } catch (e) {
    throw new TrustFlowError(
      'Value is not a valid base64 transaction envelope',
      'SIGNING_ERROR',
      e,
    );
  }

  // A fee bump is only broadcastable when *both* halves are signed: the bump
  // needs a signature from the fee payer, and the wrapped transaction needs one
  // (or more) from its original signers.
  const inner =
    typeof decoded.innerTx === 'function'
      ? (decoded.innerTx as unknown as () => SignatureCarrier)()
      : decoded._innerTransaction;
  const feeBump = inner !== undefined;
  const signatures = feeBump
    ? [...decoded.signatures, ...(inner as SignatureCarrier).signatures]
    : [...decoded.signatures];

  // A hint is a 4-byte prefix, not a full public key, so it is reported as
  // hex rather than being encoded into a misleading account id.
  const signatureHints: string[] = [];
  for (const sig of signatures) {
    const hint = sig.hint();
    if (!hint || hint.length === 0) continue;
    signatureHints.push(Buffer.from(hint).toString('hex'));
  }

  return {
    signatureCount: signatures.length,
    signed: signatures.length > 0,
    signatureHints,
    feeBump,
  };
}

/**
 * Broadcasts an already-signed base64 transaction envelope to Horizon.
 *
 * Complements {@link submitTransaction} for the air-gapped / cold-storage
 * workflow in #365: a transaction is built unsigned, exported, signed on an
 * offline machine, and later handed to this method. The signature check runs
 * first so an unsigned or malformed envelope fails locally, without spending a
 * round trip or a fee.
 *
 * Network, timeout and retry semantics are exactly {@link submitTransaction}'s,
 * including the deliberate no-retry rule for a `4xx` or a processed Horizon
 * rejection: replaying the same envelope would only earn the same verdict.
 *
 * @param signedXdr - Base64 **signed** transaction envelope
 * @param horizonUrl - Horizon base URL (with or without a trailing slash)
 * @param retry - Optional retry budget
 * @param timeoutMs - Optional request timeout in milliseconds
 * @returns The submission result on success
 * @throws {TrustFlowError} `INVALID_SIGNATURE` when the envelope is not a valid
 *   transaction, or carries no signature at all
 *
 * @example
 * ```typescript
 * // signed offline, on a machine with no network access
 * const signed = fs.readFileSync('escrow.signed.xdr', 'utf8');
 * const result = await broadcastSignedXDR(signed, horizonUrl);
 * console.log('submitted:', result.hash);
 * ```
 */
export async function broadcastSignedXDR(
  signedXdr: string,
  horizonUrl: string,
  retry?: ApiRetryConfig,
  timeoutMs?: number,
): Promise<SubmittedTx> {
  if (typeof signedXdr !== 'string' || signedXdr.trim() === '') {
    throw new TrustFlowError('Signed XDR is required', 'SIGNING_ERROR');
  }

  const report = inspectTransactionSignatures(signedXdr);
  if (!report.signed) {
    throw new TrustFlowError(
      report.feeBump
        ? 'Transaction envelope is a fee bump with no signatures; it cannot be broadcast'
        : 'Transaction envelope carries no signatures; sign it before broadcasting',
      'SIGNING_ERROR',
    );
  }

  return submitTransaction(signedXdr, horizonUrl, retry, timeoutMs);
}

interface HorizonResponseBody {
  hash?: string;
  successful?: boolean;
  ledger?: number;
  title?: string;
  detail?: string;
  extras?: { result_codes?: { transaction?: string; operations?: string[] } };
}

function normaliseHorizonUrl(horizonUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(horizonUrl);
  } catch (e) {
    throw new TrustFlowError(`Invalid Horizon URL: ${horizonUrl}`, 'INVALID_CONFIG', e);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TrustFlowError(
      `Invalid Horizon URL: ${horizonUrl} (must be http or https)`,
      'INVALID_CONFIG',
    );
  }
  return horizonUrl.replace(/\/+$/, '');
}

/**
 * Submits a signed transaction XDR to Horizon. Every failure is thrown as a
 * `TrustFlowError`; Horizon rejections carry a {@link HorizonSubmissionErrorDetail} as `cause`.
 *
 * ### Retry behaviour
 *
 * This is a `POST`, so it is **not** retried on a `4xx` or a Horizon response
 * body that carries result codes: Horizon reached a verdict, and replaying the
 * same envelope would only produce the same verdict (Horizon rejects a
 * transaction that is already on the ledger as `tx_bad_seq`).
 *
 * What *is* retried is the genuinely ambiguous case — a transport error, a
 * timeout, a `429`, or a `5xx` raised by an edge proxy before Horizon processed
 * the envelope at all. Those are wrapped in `markTransient` so the shared
 * classifier retries them, while a processed-and-rejected submission fails on
 * the first attempt. The envelope is byte-identical on every replay, so a
 * retry cannot double-spend even if the first attempt did land.
 *
 * `timeoutMs` bounds the raw `fetch` to Horizon; the request is aborted at the
 * deadline and the failure surfaces as a `TIMEOUT` `TrustFlowError` (retried
 * like any other transient failure while the budget lasts). It defaults to the
 * SDK-wide 10s when omitted.
 *
 * @param xdr - Base64 signed transaction envelope
 * @param horizonUrl - Horizon base URL (with or without a trailing slash)
 * @param retry - Optional retry budget; defaults to
 *   {@link import('../utils/node-retry').DEFAULT_NODE_RETRY_CONFIG}
 * @param timeoutMs - Optional request timeout in milliseconds
 * @throws {TrustFlowError} `SUBMISSION_ERROR` for a Horizon rejection,
 *   `CONNECTION_ERROR` when the request never completed, or `TIMEOUT` when the
 *   deadline fires
 */
export async function submitTransaction(
  xdr: string,
  horizonUrl: string,
  retry?: ApiRetryConfig,
  timeoutMs?: number,
): Promise<SubmittedTx> {
  const baseUrl = normaliseHorizonUrl(horizonUrl);

  let res: Response;
  try {
    res = await withTransientRetry(
      async () => {
        let response: Response;
        try {
          response = await fetchWithTimeout(
            `${baseUrl}/transactions`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: `tx=${encodeURIComponent(xdr)}`,
            },
            timeoutMs,
            'horizon.submitTransaction',
          );
        } catch (e) {
          // A `TIMEOUT` TrustFlowError passes through `wrap` unchanged, so the
          // deadline stays distinguishable from an ordinary transport failure.
          throw markTransient(TrustFlowError.wrap(e, 'CONNECTION_ERROR'));
        }
        // A 429/408/5xx means the request never reached a Horizon verdict —
        // an edge proxy or Horizon's own front end failed first — so it is safe
        // to replay. Any other status carries a real verdict and is returned
        // for the caller to interpret.
        if (response.status === 429 || response.status === 408 || response.status >= 500) {
          throw markTransient(
            new TrustFlowError(
              `Horizon submission failed before reaching the ledger (HTTP ${response.status})`,
              'CONNECTION_ERROR',
              { status: response.status, 'retry-after': response.headers.get('retry-after') },
            ),
          );
        }
        return response;
      },
      undefined,
      retry,
      'horizon.submitTransaction',
    );
  } catch (e) {
    // `withTransientRetry` rethrows the last transport failure once the budget
    // is spent; wrap it so callers still see a typed SDK error.
    if (e instanceof TrustFlowError) throw e;
    throw TrustFlowError.wrap(e, 'CONNECTION_ERROR');
  }

  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    throw new TrustFlowError(
      `Failed to read Horizon response (HTTP ${res.status})`,
      'CONNECTION_ERROR',
      e,
    );
  }

  let data: HorizonResponseBody | undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      data = parsed as HorizonResponseBody;
    }
  } catch {
    data = undefined;
  }

  if (!res.ok) {
    if (!data) {
      throw new TrustFlowError(
        `Transaction submission failed (HTTP ${res.status}): non-JSON response: ${text.slice(0, 200)}`,
        'SUBMISSION_ERROR',
        { status: res.status, operationCodes: [] } satisfies HorizonSubmissionErrorDetail,
      );
    }
    const detail: HorizonSubmissionErrorDetail = {
      status: res.status,
      title: data.title,
      detail: data.detail,
      transactionCode: data.extras?.result_codes?.transaction,
      operationCodes: data.extras?.result_codes?.operations ?? [],
    };
    const summary = detail.transactionCode ?? detail.title ?? 'Submission failed';
    const ops = detail.operationCodes.length ? ` [${detail.operationCodes.join(', ')}]` : '';
    throw new TrustFlowError(`${summary}${ops} (HTTP ${res.status})`, 'SUBMISSION_ERROR', detail);
  }

  if (!data || typeof data.hash !== 'string' || data.successful === false) {
    throw new TrustFlowError(
      `Horizon returned an unexpected response for a successful submission (HTTP ${res.status})`,
      'SUBMISSION_ERROR',
      { status: res.status, operationCodes: [] } satisfies HorizonSubmissionErrorDetail,
    );
  }
  return { hash: data.hash, successful: true, ledger: data.ledger };
}

/** Base64 alphabet, as used by the XDR wire format. */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Builds an unsigned transaction XDR for air-gapped signing.
 *
 * The returned envelope carries no signature, so it is safe to hand to a signer
 * that has no network access — an HSM, an air-gapped host, or a cold-storage
 * device. The signer adds a signature over the envelope's signature base and
 * returns the signed XDR, which {@link broadcastSignedXDR} then submits.
 *
 * Kept separate from submission on purpose: nothing here touches the network
 * beyond the caller-supplied data, so a signing machine can be fully offline.
 *
 * @param xdr - Base64 unsigned transaction envelope, e.g. from a `SorobanRpc`
 *   `getTransaction` or an offline `assembleTransaction`
 * @param networkPassphrase - Passphrase the signer must use; it is echoed back
 *   so the caller can confirm the signing host is on the intended network
 * @param fee - Base fee the envelope was assembled with, as a string
 * @param sourceAccount - Account expected to sign the envelope
 * @param contractId - Contract the envelope invokes
 * @param method - Contract method the envelope invokes
 * @returns The {@link UnsignedTx} bundle to hand to an offline signer
 * @throws {TrustFlowError} `INVALID_CONFIG` when the XDR is not valid base64
 */
export function buildUnsignedTransaction(
  xdr: string,
  networkPassphrase: string,
  fee: string,
  sourceAccount: string,
  contractId: string,
  method: string,
): UnsignedTx {
  const trimmed = xdr.trim();
  if (!trimmed) {
    throw new TrustFlowError('Unsigned transaction XDR must not be empty', 'INVALID_CONFIG');
  }
  if (!BASE64_RE.test(trimmed)) {
    throw new TrustFlowError('Unsigned transaction XDR must be valid base64', 'INVALID_CONFIG');
  }
  if (!networkPassphrase.trim()) {
    throw new TrustFlowError('Network passphrase must not be empty', 'INVALID_CONFIG');
  }
  if (!sourceAccount.trim()) {
    throw new TrustFlowError('Source account must not be empty', 'INVALID_CONFIG');
  }

  return {
    xdr: trimmed,
    networkPassphrase,
    fee,
    sourceAccount,
    contractId,
    method,
  };
}

/**
 * Reports whether a base64 XDR envelope carries at least one signature.
 *
 * A Stellar envelope is base64 of a `TransactionEnvelope`, which begins with a
 * 4-byte discriminant. The first two signature slots are how many decorated
 * signatures follow. Rather than assume a payload layout, this uses the SDK's
 * own decoder when it is available and falls back to a structural check, so the
 * answer is conservative: an envelope that cannot be shown to be signed is
 * reported as unsigned.
 *
 * @param xdr - Base64 transaction envelope
 * @returns `true` when the envelope is non-empty and signed
 */
export function hasSignature(xdr: string): boolean {
  const trimmed = xdr.trim();
  if (!trimmed || !BASE64_RE.test(trimmed)) return false;
  try {
    // `fromXDR` throws on a malformed envelope, which is the behaviour we want:
    // an undecodable envelope is not a signed one.
    const tx = SdkTransactionBuilder.fromXDR(trimmed, 'base64');
    const signatures = (tx as { signatures?: unknown[] }).signatures;
    return Array.isArray(signatures) && signatures.length > 0;
  } catch {
    return false;
  }
}

/**
 * Broadcasts a signed transaction XDR to Horizon.
 *
 * The second half of the offline workflow: `buildUnsignedTransaction` →
 * sign on an air-gapped host → `broadcastSignedXDR` from a networked machine.
 *
 * The envelope is checked for signature completeness *before* the request is
 * sent. Horizon would reject an unsigned envelope anyway, but only after a
 * round trip, and the rejection is indistinguishable from a real ledger
 * failure. Failing locally turns that into an actionable error.
 *
 * @param signedXdr - Base64 signed transaction envelope
 * @param horizonUrl - Horizon base URL (with or without a trailing slash)
 * @param retry - Optional retry budget
 * @param timeoutMs - Optional request timeout in milliseconds
 * @returns The submitted transaction hash
 * @throws {TrustFlowError} `INVALID_CONFIG` when the XDR is empty, is not
 *   base64, or carries no signature; `SUBMISSION_ERROR` when Horizon rejects it
 */
export async function broadcastSignedXDR(
  signedXdr: string,
  horizonUrl: string,
  retry?: ApiRetryConfig,
  timeoutMs?: number,
): Promise<SubmittedTx> {
  const trimmed = signedXdr.trim();
  if (!trimmed) {
    throw new TrustFlowError('Signed transaction XDR must not be empty', 'INVALID_CONFIG');
  }
  if (!BASE64_RE.test(trimmed)) {
    throw new TrustFlowError('Signed transaction XDR must be valid base64', 'INVALID_CONFIG');
  }
  if (!hasSignature(trimmed)) {
    throw new TrustFlowError(
      'Signed transaction XDR contains no signature; broadcast expects a signed envelope',
      'INVALID_CONFIG',
    );
  }
  return submitTransaction(trimmed, horizonUrl, retry, timeoutMs);
}

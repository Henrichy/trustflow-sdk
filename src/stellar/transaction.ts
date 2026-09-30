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

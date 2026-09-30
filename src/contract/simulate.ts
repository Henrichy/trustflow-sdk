import type { TrustFlowClient } from '../client';
import { TrustFlowError } from '../errors';
import { logger } from '../utils/logger';
import type { ReadContractStateOptions } from './read';
import { simulateTransaction, type SimulationOutcome } from './simulation';

export interface SimulationResult {
  success: boolean;
  cost: { cpuInsns: string; memBytes: string };
  returnValue?: unknown;
  error?: string;
  /** True when the simulation needs expired ledger entries restored before it can succeed. */
  needsRestore?: boolean;
  /** The restore preamble the RPC returned, when `needsRestore` is true. */
  restorePreamble?: {
    minResourceFee: string;
    transactionData: any;
  };
}

/** Per-call account and retry overrides for {@link simulateContractCall}. */
export type SimulateContractCallOptions = ReadContractStateOptions;

/**
 * Simulates an already-assembled transaction envelope without submitting it.
 *
 * ### Retry behaviour
 *
 * A failing `simulateTransaction` transport is retried on transient failures
 * only (connection reset, timeout, `429`, `5xx`) with capped, jittered backoff.
 * A simulation *error* response is the node's verdict on the envelope, so it is
 * returned as `{ success: false, error }` on the first attempt and never
 * retried — replaying it would produce the same contract error.
 *
 * Each attempt is bounded by `options.timeoutMs`, falling back to the
 * client-wide {@link ClientConfig.timeoutMs}; once every attempt has timed out
 * and the retry budget is spent, the call throws `TIMEOUT`.
 *
 * ### Restore footprint
 *
 * When the simulation response indicates that expired ledger entries must be
 * restored before the transaction can succeed (`rpc.Api.isSimulationRestore`),
 * the result includes `needsRestore: true` and the `restorePreamble` so the
 * caller can build a restore transaction before re-submitting.
 *
 * @param client - Configured client, for the RPC URL and retry budget
 * @param xdr - Base64 transaction envelope to simulate
 * @param options - Per-call account, retry and timeout overrides
 * @returns `{ success: true, cost, returnValue }` or `{ success: false, error }`
 * @throws {TrustFlowError} `SIMULATION_ERROR` only when the RPC request itself
 *   fails after the retry budget is spent, `TIMEOUT` when every attempt
 *   exceeded the timeout budget
 *
 * @example
 * ```typescript
 * const dry = await simulateContractCall(client, envelopeXdr);
 * if (!dry.success) console.warn(dry.error);
 * ```
 */
export async function simulateContractCall(
  client: TrustFlowClient,
  xdr: string,
  options: SimulateContractCallOptions = {},
): Promise<SimulationResult> {
  client.resolveAccount(options.account);
  const server = client.getSorobanServer();
  try {
    const outcome: SimulationOutcome = await simulateTransaction(
      server,
      { toEnvelope: () => ({ toXDR: () => xdr }) } as any,
      options,
      client.retryConfig,
    );
    return {
      success: outcome.success,
      cost: outcome.cost,
      returnValue: outcome.returnValue,
      error: outcome.error,
      needsRestore: outcome.needsRestore,
      restorePreamble: outcome.restorePreamble,
    };
  } catch (e) {
    // A `TIMEOUT` (or any typed SDK error) keeps its code rather than being
    // re-wrapped as a generic simulation failure.
    if (e instanceof TrustFlowError) throw e;
    logger.error('Contract simulation failed', { error: e });
    throw new TrustFlowError('Simulation failed', 'SIMULATION_ERROR', e);
  }
}

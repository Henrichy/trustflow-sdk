import { rpc, Transaction, scValToNative, SorobanDataBuilder } from '@stellar/stellar-sdk';
import { TrustFlowError } from '../errors';
import { withTransientRetry } from '../utils/node-retry';
import { logger } from '../utils/logger';
import type { ReadContractStateOptions } from './read';
import type { ApiRetryConfig } from '../utils/http';
import type { TracerProvider } from '@opentelemetry/api';
import { getSdkTracer, markSpanError, withSdkSpan } from '../utils/tracing';

/**
 * Result of simulating a transaction against Soroban RPC.
 *
 * Every simulation path in the SDK — `simulateContractCall`,
 * `invokeContract`, `readContractState`, and `TransactionPipeline` — funnels
 * through {@link simulateTransaction} so they all validate results identically
 * and surface the same typed outcome.
 */
export interface SimulationOutcome {
  success: boolean;
  cost: { cpuInsns: string; memBytes: string };
  returnValue?: unknown;
  /** Parsed RPC host-function result needed when assembling signed invocations. */
  result?: rpc.Api.SimulateHostFunctionResult;
  /** Original parsed response for callers that need the complete RPC shape. */
  response?: rpc.Api.SimulateTransactionResponse;
  error?: string;
  /** True when the simulation needs expired ledger entries restored before it can succeed. */
  needsRestore?: boolean;
  /** The restore preamble the RPC returned, when `needsRestore` is true. */
  restorePreamble?: {
    minResourceFee: string;
    transactionData: SorobanDataBuilder;
  };
  /** The RPC-reported minimum resource fee (stroops), when available. */
  minResourceFee?: string;
  /** The Soroban transaction data builder needed for `rpc.assembleTransaction`. */
  transactionData?: SorobanDataBuilder;
}

/**
 * Simulates a transaction against Soroban RPC and returns a consistent outcome.
 *
 * This is the single simulation primitive behind every contract path in the
 * SDK. It handles:
 * - **Simulation errors** (`isSimulationError`) — returned as `{ success: false, error }`.
 * - **Restore requirements** (`isSimulationRestore`) — returned as `{ success: false, needsRestore: true, restorePreamble }`.
 * - **Success** — the return value is decoded to native JS via `scValToNative`.
 *
 * Transient RPC failures (connection reset, timeout, `429`, `5xx`) are retried
 * with capped, jittered backoff. A simulation error response is the node's
 * verdict on the envelope and is never retried.
 *
 * @param server - The Soroban RPC server to simulate against
 * @param tx - The transaction to simulate
 * @param options - Per-call retry and timeout overrides
 * @param retryConfig - Client-wide retry budget
 * @returns The simulation outcome
 * @throws {TrustFlowError} `SIMULATION_ERROR` only when the RPC request itself
 *   fails after the retry budget is spent
 */
export async function simulateTransaction(
  server: rpc.Server,
  tx: Transaction,
  options: { timeoutMs?: number; retry?: ReadContractStateOptions['retry'] } = {},
  retryConfig?: ApiRetryConfig,
  tracerProvider?: TracerProvider,
): Promise<SimulationOutcome> {
  return withSdkSpan(
    getSdkTracer(tracerProvider),
    'trustflow.rpc.simulate',
    { 'rpc.system': 'stellar', 'rpc.method': 'simulateTransaction' },
    async (span) => {
      try {
        const result = await withTransientRetry(
          () => server.simulateTransaction(tx),
          { ...options.retry, timeoutMs: options.timeoutMs },
          retryConfig,
          'rpc.simulateTransaction',
        );

        if (rpc.Api.isSimulationError(result)) {
          logger.warn('Contract simulation returned error', { error: result.error });
          markSpanError(span, result.error);
          return { success: false, cost: { cpuInsns: '0', memBytes: '0' }, error: result.error };
        }

        if (rpc.Api.isSimulationRestore(result)) {
          logger.warn('Contract simulation requires restore preamble');
          span.setAttribute('stellar.simulation.needs_restore', true);
          markSpanError(span, 'Simulation requires restore preamble');
          return {
            success: false,
            cost: { cpuInsns: '0', memBytes: '0' },
            error: 'Simulation requires restore preamble',
            needsRestore: true,
            restorePreamble: result.restorePreamble,
          };
        }

        const retval = result.result?.retval;
        logger.debug('Contract simulation succeeded');
        return {
          success: true,
          cost: { cpuInsns: '0', memBytes: '0' },
          returnValue: retval ? scValToNative(retval) : undefined,
          result: result.result,
          response: result,
          minResourceFee: result.minResourceFee,
          transactionData: result.transactionData,
        };
      } catch (e) {
        // A `TIMEOUT` (or any typed SDK error) keeps its code rather than being
        // re-wrapped as a generic simulation failure.
        if (e instanceof TrustFlowError) throw e;
        logger.error('Contract simulation failed', { error: e });
        throw new TrustFlowError('Simulation failed', 'SIMULATION_ERROR', e);
      }
    },
  );
}

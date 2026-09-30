import {
  Account,
  BASE_FEE,
  Contract,
  rpc,
  scValToNative,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import type { TrustFlowClient } from '../client';
import { TrustFlowError } from '../errors';
import { logger } from '../utils/logger';
import type { ReadContractStateOptions } from './read';
import { simulateTransaction, type SimulationOutcome } from './simulation';
import { withTransientRetry } from '../utils/node-retry';
import { DEFAULT_TIMEOUT_MS, fetchWithTimeout } from '../utils/timeout';

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
    transactionData: string;
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
      client.tracerProvider,
    );
    return {
      success: outcome.success,
      cost: outcome.cost,
      returnValue: outcome.returnValue,
      error: outcome.error,
      needsRestore: outcome.needsRestore,
      restorePreamble: outcome.restorePreamble
        ? {
            minResourceFee: outcome.restorePreamble.minResourceFee,
            transactionData: outcome.restorePreamble.transactionData.build().toXDR('base64'),
          }
        : undefined,
    };
  } catch (e) {
    // A `TIMEOUT` (or any typed SDK error) keeps its code rather than being
    // re-wrapped as a generic simulation failure.
    if (e instanceof TrustFlowError) throw e;
    logger.error('Contract simulation failed', { error: e });
    throw new TrustFlowError('Simulation failed', 'SIMULATION_ERROR', e);
  }
}

/** A prepared envelope, or a read invocation with arguments already encoded as ScVal. */
export type ContractInvocation =
  | { xdr: string }
  | { method: string; args?: xdr.ScVal[]; contractId?: string };

/** Shared account context, retry policy and per-attempt deadline for a batch. */
export type SimulateBatchOptions = SimulateContractCallOptions;

function failedSimulation(error: unknown): SimulationResult {
  return {
    success: false,
    cost: { cpuInsns: '0', memBytes: '0' },
    error: error instanceof Error ? error.message : String(error),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function decodeBatchResponse(value: unknown): SimulationResult {
  const response = asRecord(value);
  if (!response || response.jsonrpc !== '2.0') {
    return failedSimulation('Invalid JSON-RPC batch response');
  }
  if ('error' in response) {
    const error = asRecord(response.error);
    return failedSimulation(
      typeof error?.message === 'string' ? error.message : 'Invalid JSON-RPC error response',
    );
  }
  const raw = asRecord(response.result);
  if (!raw || typeof raw.latestLedger !== 'number') {
    return failedSimulation('Invalid simulation response');
  }
  if (
    typeof raw.error !== 'string' &&
    (typeof raw.transactionData !== 'string' || typeof raw.minResourceFee !== 'string')
  ) {
    return failedSimulation('Invalid simulation success response');
  }
  try {
    const result = rpc.parseRawSimulation(raw as unknown as rpc.Api.RawSimulateTransactionResponse);
    if (rpc.Api.isSimulationError(result)) return failedSimulation(result.error);
    if (rpc.Api.isSimulationRestore(result)) {
      return {
        ...failedSimulation('Simulation requires restore preamble'),
        needsRestore: true,
        restorePreamble: {
          minResourceFee: result.restorePreamble.minResourceFee,
          transactionData: result.restorePreamble.transactionData.build().toXDR('base64'),
        },
      };
    }
    return {
      success: true,
      cost: { cpuInsns: '0', memBytes: '0' },
      returnValue: result.result ? scValToNative(result.result.retval) : undefined,
    };
  } catch (error) {
    return failedSimulation(error);
  }
}

/**
 * Simulates independent envelopes and read invocations in one JSON-RPC 2.0 batch.
 * The configured RPC endpoint must support JSON-RPC array requests. No transactions
 * are submitted and no source-account lookup is needed for read invocations.
 * Responses are matched by ID and returned in input order, even if the server
 * reorders them. Local construction, RPC, contract and decoding errors become
 * individual failed results. A failed HTTP request rejects the whole batch;
 * only transient transport failures are retried, using the client's policy.
 *
 * @param client - Client supplying the RPC URL, contract and network configuration
 * @param invocations - Prepared XDR envelopes or read methods with encoded arguments
 * @param options - Shared account, retry and per-attempt timeout overrides
 * @returns One simulation result per invocation; an empty input makes no request
 * @throws {TrustFlowError} SIMULATION_ERROR for transport or batch protocol failures,
 *   TIMEOUT when the per-attempt deadline is exhausted
 * @example
 * ```typescript
 * const results = await simulateBatch(client, [
 *   { method: 'get_escrow', args: [nativeToScVal('escrow-1')] },
 *   { xdr: envelopeXdr },
 * ]);
 * results.forEach(result => console.log(result.success, result.returnValue));
 * ```
 */
export async function simulateBatch(
  client: TrustFlowClient,
  invocations: ContractInvocation[],
  options: SimulateBatchOptions = {},
): Promise<SimulationResult[]> {
  if (invocations.length === 0) return [];
  client.resolveAccount(options.account);
  const results: SimulationResult[] = new Array(invocations.length);
  const requests: {
    jsonrpc: '2.0';
    id: number;
    method: string;
    params: { transaction: string };
  }[] = [];
  invocations.forEach((invocation, id) => {
    try {
      const transaction =
        'xdr' in invocation
          ? invocation.xdr
          : new TransactionBuilder(
              new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '0'),
              { fee: BASE_FEE, networkPassphrase: client.getNetworkPassphrase() },
            )
              .addOperation(
                new Contract(invocation.contractId ?? client.contractId).call(
                  invocation.method,
                  ...(invocation.args ?? []),
                ),
              )
              .setTimeout(30)
              .build()
              .toXDR();
      if (typeof transaction !== 'string' || transaction.length === 0) {
        throw new Error('Invocation requires a non-empty transaction envelope');
      }
      requests.push({ jsonrpc: '2.0', id, method: 'simulateTransaction', params: { transaction } });
    } catch (error) {
      results[id] = failedSimulation(error);
    }
  });
  if (requests.length === 0) return results;
  const timeoutMs = options.timeoutMs ?? client.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const payload: unknown = await withTransientRetry(
      async () => {
        const response = await fetchWithTimeout(
          client.rpcUrl,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requests),
          },
          timeoutMs,
          'rpc.simulateBatch',
        );
        if (!response.ok) {
          throw Object.assign(new Error(`Batch simulation HTTP ${response.status}`), {
            status: response.status,
            response: {
              status: response.status,
              headers: { 'retry-after': response.headers.get('retry-after') },
            },
          });
        }
        return response.json();
      },
      { ...options.retry, timeoutMs },
      client.retryConfig,
      'rpc.simulateBatch',
    );
    if (!Array.isArray(payload)) {
      throw new TrustFlowError(
        'RPC endpoint did not return a JSON-RPC batch array',
        'SIMULATION_ERROR',
      );
    }
    const byId = new Map<number, unknown>();
    const duplicates = new Set<number>();
    for (const entry of payload) {
      const response = asRecord(entry);
      if (!response || typeof response.id !== 'number') continue;
      if (byId.has(response.id)) duplicates.add(response.id);
      byId.set(response.id, entry);
    }
    // Each caller settles independently; malformed entries cannot reject siblings.
    await Promise.all(
      requests.map(async ({ id }) => {
        results[id] = duplicates.has(id)
          ? failedSimulation(`Duplicate batch response for invocation ${id}`)
          : byId.has(id)
            ? decodeBatchResponse(byId.get(id))
            : failedSimulation(`Missing batch response for invocation ${id}`);
      }),
    );
    return results;
  } catch (error) {
    if (error instanceof TrustFlowError) throw error;
    throw new TrustFlowError('Batch simulation failed', 'SIMULATION_ERROR', error);
  }
}

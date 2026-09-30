import { Contract, Account, TransactionBuilder, BASE_FEE } from '@stellar/stellar-sdk';
import type { TrustFlowClient } from '../client';
import type { AccountOptions } from '../accounts/types';
import { TrustFlowError } from '../errors';
import { logger } from '../utils/logger';
import { simulateTransaction } from './simulation';

export interface ReadContractStateOptions extends AccountOptions {
  /**
   * Overrides the client's retry budget for this call — `attempts` counts the
   * total tries (so `attempts: 1` disables retries), and `maxDelayMs` caps each
   * delay. See {@link import('../utils/retry').cappedExponentialBackoff}.
   */
  retry?: { attempts?: number; baseDelayMs?: number; maxDelayMs?: number };
  /**
   * Per-attempt timeout in milliseconds, overriding the client-wide
   * {@link ClientConfig.timeoutMs}. A timed-out simulation is retried like
   * any other transient failure, then surfaces as a `TIMEOUT`
   * {@link TrustFlowError}.
   */
  timeoutMs?: number;
}

/**
 * Reads a contract method's return value by simulating it against a dummy
 * source account.
 *
 * ### Retry behaviour
 *
 * The `simulateTransaction` transport is retried on transient failures only
 * (connection reset, timeout, `429`, `5xx`) with capped, jittered backoff. A
 * simulation *error* response — `Error(Contract, #n)` and friends — is a
 * deterministic answer from the node, so it is never retried and is thrown
 * immediately as `SIMULATION_ERROR`.
 *
 * Each attempt is bounded by `options.timeoutMs`, falling back to the
 * client-wide {@link ClientConfig.timeoutMs}; a timed-out attempt is retried,
 * and once the budget is spent the call throws `TIMEOUT`.
 *
 * ### Restore footprint
 *
 * When the simulation indicates that expired ledger entries must be restored
 * (`rpc.Api.isSimulationRestore`), the call throws `SIMULATION_ERROR` with a
 * message describing the restore requirement, since a read cannot proceed
 * without the restored state.
 *
 * @param client - Configured client, for the contract ID, network and retry budget
 * @param method - Contract method name
 * @param args - Positional arguments, encoded to `ScVal` by the contract spec
 * @param options - Per-call account, retry and timeout overrides
 * @returns The method's decoded return value
 * @throws {TrustFlowError} `SIMULATION_ERROR` when the node rejects the simulation,
 *   `TIMEOUT` when every attempt exceeded the timeout budget
 *
 * @example
 * ```typescript
 * const escrow = await readContractState(client, 'get_escrow', [id]);
 * ```
 */
export async function readContractState(
  client: TrustFlowClient,
  method: string,
  args: unknown[] = [],
  options: ReadContractStateOptions = {},
): Promise<unknown> {
  client.resolveAccount(options.account);
  const server = client.getSorobanServer();
  const contract = new Contract(client.contractId);
  const operation = contract.call(method, ...(args as any[]));

  // Use a dummy account for simulation
  const dummyAccount = new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '0');

  const tx = new TransactionBuilder(dummyAccount, {
    fee: BASE_FEE,
    networkPassphrase: client.getNetworkPassphrase(),
  })
    .addOperation(operation)
    .setTimeout(30)
    .build();

  const result = await simulateTransaction(server, tx, options, client.retryConfig);

  if (!result.success) {
    if (result.needsRestore) {
      throw new TrustFlowError(
        `Read simulation failed: contract state has expired and must be restored first`,
        'SIMULATION_ERROR',
      );
    }
    throw new TrustFlowError(
      `Read simulation failed: ${result.error ?? 'unknown error'}`,
      'SIMULATION_ERROR',
    );
  }

  logger.debug('Contract read succeeded', { method });
  return result.returnValue;
}

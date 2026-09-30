import { useState, useCallback } from 'react';
import type { TrustFlowClient } from '../client';
import type { Escrow, CreateEscrowParams } from '../types';
import { createEscrow, releaseEscrow } from '../escrow';

export function useEscrow(client: TrustFlowClient) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [escrow, setEscrow] = useState<Escrow | null>(null);

  const create = useCallback(
    async (params: CreateEscrowParams) => {
      setLoading(true);
      setError(null);
      try {
        const e = await createEscrow(client, params);
        setEscrow(e);
        return e;
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
        throw e;
      } finally {
        setLoading(false);
      }
    },
    [client],
  );

  const release = useCallback(
    async (escrowId: string, caller: string) => {
      setLoading(true);
      setError(null);
      try {
        return await releaseEscrow(client, { escrowId, caller });
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
        throw e;
      } finally {
        setLoading(false);
      }
    },
    [client],
  );

  return { escrow, loading, error, create, release };
}

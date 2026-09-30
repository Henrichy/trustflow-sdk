import { useState, useCallback } from 'react';
import type { TrustFlowClient } from '../client';
import type { Escrow, CreateEscrowParams } from '../types';
import { createEscrow, releaseEscrow } from '../escrow';

export interface OptimisticOptions {
  /** When true, the hook updates local state immediately and rolls back on failure. */
  optimistic?: boolean;
  /** Optional callback invoked when an optimistic update is rolled back. */
  onOptimisticRollback?: (error: Error, previous: Escrow | null) => void;
}

export interface CreateEscrowOptions extends OptimisticOptions {
  /** Optional id override for the optimistic placeholder. */
  optimisticId?: string;
}

export interface ReleaseEscrowOptions extends OptimisticOptions {}

const generateOptimisticId = () =>
  `escrow-pending-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function useEscrow(client: TrustFlowClient) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [escrow, setEscrow] = useState<Escrow | null>(null);

  const create = useCallback(
    async (params: CreateEscrowParams, options: CreateEscrowOptions = {}) => {
      const { optimistic = false, onOptimisticRollback, optimisticId } = options;
      setLoading(true);
      setError(null);

      let previous: Escrow | null = null;
      let optimisticPlaceholder: Escrow | null = null;

      if (optimistic) {
        setEscrow((prev) => {
          previous = prev;
          optimisticPlaceholder = {
            ...(prev ?? {}),
            id: optimisticId ?? generateOptimisticId(),
            status: 'PENDING',
            pending: true,
          } as Escrow;
          return optimisticPlaceholder;
        });
      }

      try {
        const e = await createEscrow(client, params);
        setEscrow(e);
        return e;
      } catch (e: unknown) {
        const err = toError(e);
        if (optimistic) {
          setEscrow(previous);
          onOptimisticRollback?.(err, previous);
        }
        setError(err.message);
        throw e;
      } finally {
        setLoading(false);
      }
    },
    [client],
  );

  const release = useCallback(
    async (escrowId: string, caller: string, options: ReleaseEscrowOptions = {}) => {
      const { optimistic = false, onOptimisticRollback } = options;
      setLoading(true);
      setError(null);

      let previous: Escrow | null = null;

      if (optimistic) {
        setEscrow((prev) => {
          previous = prev;
          if (!prev) return prev;
          return {
            ...prev,
            status: 'RELEASED',
            pending: true,
          } as Escrow;
        });
      }

      try {
        return await releaseEscrow(client, { escrowId, caller });
      } catch (e: unknown) {
        const err = toError(e);
        if (optimistic) {
          setEscrow(previous);
          onOptimisticRollback?.(err, previous);
        }
        setError(err.message);
        throw e;
      } finally {
        setLoading(false);
      }
    },
    [client],
  );

  return { escrow, loading, error, create, release };
}

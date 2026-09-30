import { useState, useCallback } from 'react';

type TxStatus = 'idle' | 'pending' | 'success' | 'error';

export function useTransaction() {
  const [status, setStatus] = useState<TxStatus>('idle');
  const [hash, setHash] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);

  const execute = useCallback(async (fn: () => Promise<string>) => {
    setStatus('pending');
    setError(null);
    try {
      const h = await fn();
      setHash(h);
      setStatus('success');
      return h;
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
      throw e;
    }
  }, []);

  const reset = useCallback(() => {
    setStatus('idle');
    setHash(undefined);
    setError(null);
  }, []);

  return { status, hash, error, execute, reset, isPending: status === 'pending' };
}

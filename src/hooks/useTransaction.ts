import { useState, useCallback } from 'react';

type TxStatus = 'idle' | 'pending' | 'success' | 'failed';

export interface TransactionError extends Error {
  resultCode?: string;
  resultXrr?: string;
}

function isHorizon400TransactionFailed(e: unknown): e is {
  response: {
    status: number;
    data?: {
      extras?: { result_codes?: string[]; result_xdr?: string };
      result_codes?: string[];
      result_xdr?: string;
    };
  };
} {
  if (typeof e !== 'object' || e === null) return false;
  const resp = (e as { response?: unknown }).response;
  if (typeof resp !== 'object' || resp === null) return false;
  const status = (resp as { status?: unknown }).status;
  if (status !== 400) return false;
  const data = (resp as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return false;
  const d = dat as {
    extras?: { result_codes?: string[]; result_xdr?: string };
    result_codes?: string[];
    result_xdr?: string;
  };
  const codes = d.extras?.result_codes ?? d.result_codes;
  const xdr = d.extras?.result_xdr ?? d.result_xdr;
  if (Array.isArray(codes) && codes.includes('transaction_failed')) return true;
  if (typeof xdr === 'string' && xdr.length > 0) return true;
  return false;
}

function extractHorizonErrorDetails(e: unknown): { resultCode?: string; resultXdr?: string } {
  if (typeof e !== 'object' || e === null) return {};
  const resp = (e as { response?: unknown }).response;
  if (typeof resp !== 'object' || resp === null) return {};
  const data = (resp as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return {};
  const d = data as {
    extras?: { result_codes?: string[]; result_xdr?: string };
    result_codes?: string[];
    result_xdr?: string;
  };
  const codes = d.extras?.result_codes ?? d.result_codes;
  const xdr = d.extras?.result_xdr ?? d.result_xdr;
  return {
    resultCode: Array.isArray(codes) ? codes.join(',') : undefined,
    resultXdr : typeof xdr === 'string' ? xdr : undefined,
  };
}

export function useTransaction() {
  const [status, setStatus] = useState<TxStatus>('idle');
  const [hash, setHash] = useState<string | undefined>();
  const [error, setError] = useState<TransactionError | null>(null);

  const execute = useCallback(async (fn: () => Promise<string>) => {
    setStatus('pending');
    setError(null);
    try {
      const h = await fn();
      setHash(h);
      setStatus('success');
      return h;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      const txError = new Error(message) as TransactionError;
      if (isHorizon400TransactionFailed(e)) {
        const { resultCode, resultXdr } = extractHorizonErrorDetails(e);
        txError.resultCode = resultCode;
        txError.resultXdr = resultXdr;
        const detail = resultCode ? `${message} (${resultCode})` : message;
        txError.message = detail;
        setError(txError);
        setStatus('failed');
        throw txError;
      }
      setError(txError);
      setStatus('failed');
      throw txError;
    }
  }, []);

  const reset = useCallback(() => {
    setStatus('idle');
    setHash(undefined);
    setError(null);
  }, []);

  return { status, hash, error, execute, reset, isPending: status === 'pending' };
}

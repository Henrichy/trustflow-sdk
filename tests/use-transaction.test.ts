/** @jest-environment jsdom */
import { renderHook, act } from '@testing-library/react';
import { useTransaction } from '../src/hooks/useTransaction';

describe('useTransaction', () => {
  it('starts idle', () => {
    const { result } = renderHook(() => useTransaction());

    expect(result.current.status).toBe('idle');
    expect(result.current.hash).toBeUndefined();
    expect(result.current.error).toBeNull();
    expect(result.current.isPending).toBe(false);
  });

  it('moves from pending to success and exposes the hash', async () => {
    let resolveFn: (hash: string) => void = () => undefined;
    const fn = jest.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveFn = resolve;
        }),
    );
    const { result } = renderHook(() => useTransaction());

    let pending: Promise<string> | undefined;
    act(() => {
      pending = result.current.execute(fn);
    });
    expect(result.current.status).toBe('pending');
    expect(result.current.isPending).toBe(true);

    let returned: string | undefined;
    await act(async () => {
      resolveFn('abc123');
      returned = await pending;
    });

    expect(returned).toBe('abc123');
    expect(result.current.status).toBe('success');
    expect(result.current.hash).toBe('abc123');
    expect(result.current.error).toBeNull();
    expect(result.current.isPending).toBe(false);
  });

  it('moves from pending to error, exposes the message and rethrows', async () => {
    const { result } = renderHook(() => useTransaction());

    await act(async () => {
      await expect(result.current.execute(() => Promise.reject(new Error('tx failed')))).rejects.toThrow(
        'tx failed',
      );
    });

    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe('tx failed');
    expect(result.current.hash).toBeUndefined();
    expect(result.current.isPending).toBe(false);
  });

  it('stringifies a non-Error rejection', async () => {
    const { result } = renderHook(() => useTransaction());

    await act(async () => {
      await expect(result.current.execute(() => Promise.reject('boom'))).rejects.toBe('boom');
    });

    expect(result.current.error).toBe('boom');
  });

  it('clears a previous error when executing again', async () => {
    const { result } = renderHook(() => useTransaction());

    await act(async () => {
      await expect(result.current.execute(() => Promise.reject(new Error('first')))).rejects.toThrow();
    });
    await act(async () => {
      await result.current.execute(() => Promise.resolve('ok'));
    });

    expect(result.current.status).toBe('success');
    expect(result.current.error).toBeNull();
  });

  it('reset returns to the idle state', async () => {
    const { result } = renderHook(() => useTransaction());

    await act(async () => {
      await result.current.execute(() => Promise.resolve('abc123'));
    });
    expect(result.current.status).toBe('success');

    act(() => {
      result.current.reset();
    });

    expect(result.current.status).toBe('idle');
    expect(result.current.hash).toBeUndefined();
    expect(result.current.error).toBeNull();
  });

  it('keeps stable execute and reset references across renders', () => {
    const { result, rerender } = renderHook(() => useTransaction());
    const { execute, reset } = result.current;

    rerender();

    expect(result.current.execute).toBe(execute);
    expect(result.current.reset).toBe(reset);
  });
});

/**
 * #107 — `useEscrow`'s create / release paths, rendered with a real React
 * renderer. Only the escrow functions are mocked.
 * @jest-environment jsdom
 */
import { renderHook, act } from '@testing-library/react';

jest.mock('../src/escrow', () => ({
  createEscrow: jest.fn(),
  releaseEscrow: jest.fn(),
}));

import * as escrow from '../src/escrow';
import { useEscrow } from '../src/hooks/useEscrow';

const mockCreate = escrow.createEscrow as jest.Mock;
const mockRelease = escrow.releaseEscrow as jest.Mock;

const client = {} as never;

describe('useEscrow — create (#107)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns the escrow, stores it, and clears error/loading on success', async () => {
    const created = { id: 'escrow-1', status: 'PENDING' };
    mockCreate.mockResolvedValueOnce(created);
    const { result } = renderHook(() => useEscrow(client));

    let returned: unknown;
    await act(async () => {
      returned = await result.current.create({
        sender: 'GA',
        recipient: 'GB',
        amountStroops: 100n,
      } as never);
    });

    expect(returned).toBe(created);
    expect(mockCreate).toHaveBeenCalledWith(client, expect.objectContaining({ sender: 'GA' }));
    expect(result.current.escrow).toBe(created);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('surfaces the error message and rethrows on failure', async () => {
    mockCreate.mockRejectedValueOnce(new Error('minimum amount not met'));
    const { result } = renderHook(() => useEscrow(client));

    await act(async () => {
      await expect(result.current.create({} as never)).rejects.toThrow('minimum amount not met');
    });

    expect(result.current.error).toBe('minimum amount not met');
    expect(result.current.escrow).toBeNull();
    expect(result.current.loading).toBe(false);
  });
});

describe('useEscrow — release (#107)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns the release result on success', async () => {
    mockRelease.mockResolvedValueOnce('tx_release_abc');
    const { result } = renderHook(() => useEscrow(client));

    let returned: unknown;
    await act(async () => {
      returned = await result.current.release('escrow-1', 'GA');
    });

    expect(returned).toBe('tx_release_abc');
    expect(mockRelease).toHaveBeenCalledWith(client, { escrowId: 'escrow-1', caller: 'GA' });
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('surfaces the error message and rethrows on failure', async () => {
    mockRelease.mockRejectedValueOnce(new Error('unauthorized'));
    const { result } = renderHook(() => useEscrow(client));

    await act(async () => {
      await expect(result.current.release('escrow-1', 'GA')).rejects.toThrow('unauthorized');
    });

    expect(result.current.error).toBe('unauthorized');
    expect(result.current.loading).toBe(false);
  });

  it('stringifies a non-Error rejection', async () => {
    mockRelease.mockRejectedValueOnce('denied');
    const { result } = renderHook(() => useEscrow(client));

    await act(async () => {
      await expect(result.current.release('escrow-1', 'GA')).rejects.toBe('denied');
    });

    expect(result.current.error).toBe('denied');
  });

  it('clears a previous error on the next call', async () => {
    mockRelease.mockRejectedValueOnce(new Error('first'));
    mockRelease.mockResolvedValueOnce('tx_release_abc');
    const { result } = renderHook(() => useEscrow(client));

    await act(async () => {
      await expect(result.current.release('escrow-1', 'GA')).rejects.toThrow('first');
    });
    await act(async () => {
      await result.current.release('escrow-1', 'GA');
    });

    expect(result.current.error).toBeNull();
  });
});

/**
 * @file tests/circuit-breaker.test.ts
 * Circuit breaker recovery behaviour.
 *
 * Focus is the HALF_OPEN recovery path described in #353: an OPEN circuit
 * must be able to re-probe a recovered endpoint automatically, and it must
 * do so with a *single* probe rather than flooding a still-degraded endpoint.
 *
 * The module previously had no test coverage at all.
 */

import { CircuitBreaker, CircuitBreakerRegistry } from '../src/utils/circuit-breaker';
import { TrustFlowError } from '../src/errors';

/** Always rejects, to drive the breaker towards OPEN. */
const fail = async (): Promise<never> => {
  throw new Error('endpoint down');
};

/** Always resolves, to represent a recovered endpoint. */
const ok = async <T>(value: T = 'ok'): Promise<T> => value;

async function driveOpen(cb: CircuitBreaker, failures: number): Promise<void> {
  for (let i = 0; i < failures; i += 1) {
    await expect(cb.execute(fail)).rejects.toThrow();
  }
}

describe('CircuitBreaker', () => {
  describe('basic states', () => {
    it('starts CLOSED and passes calls through', async () => {
      const cb = new CircuitBreaker();
      expect(cb.getState()).toBe('CLOSED');
      await expect(cb.execute(ok)).resolves.toBe('ok');
    });

    it('opens only after reaching the failure threshold', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 3 });
      await driveOpen(cb, 2);
      expect(cb.getState()).toBe('CLOSED');
      await driveOpen(cb, 1);
      expect(cb.getState()).toBe('OPEN');
    });

    it('fails fast while OPEN without invoking the wrapped function', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 1 });
      await driveOpen(cb, 1);

      const wrapped = jest.fn(async () => 'ok');
      await expect(cb.execute(wrapped)).rejects.toThrow(TrustFlowError);
      expect(wrapped).not.toHaveBeenCalled();
    });

    it('reports onOpen with the failure count', async () => {
      const onOpen = jest.fn();
      const cb = new CircuitBreaker({ failureThreshold: 2, onOpen });
      await driveOpen(cb, 2);
      expect(onOpen).toHaveBeenCalledWith('Circuit opened after 2 failures');
    });
  });

  describe('automatic reset timeout (OPEN -> HALF_OPEN)', () => {
    it('stays OPEN until the reset timeout elapses', async () => {
      jest.useFakeTimers();
      try {
        const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 30_000 });
        await driveOpen(cb, 1);
        expect(cb.getState()).toBe('OPEN');

        jest.advanceTimersByTime(29_999);
        expect(cb.getState()).toBe('OPEN');

        jest.advanceTimersByTime(1);
        expect(cb.getState()).toBe('HALF_OPEN');
      } finally {
        jest.useRealTimers();
      }
    });

    it('notifies on the transition to HALF_OPEN', async () => {
      jest.useFakeTimers();
      try {
        const transitions: string[] = [];
        const cb = new CircuitBreaker({
          failureThreshold: 1,
          resetTimeoutMs: 1_000,
          onStateChange: (from, to) => transitions.push(`${from}->${to}`),
        });
        await driveOpen(cb, 1);
        jest.advanceTimersByTime(1_001);
        expect(cb.getState()).toBe('HALF_OPEN');
        expect(transitions).toContain('OPEN->HALF_OPEN');
      } finally {
        jest.useRealTimers();
      }
    });

    it('clears the consumed retry deadline in diagnostics', async () => {
      jest.useFakeTimers();
      try {
        const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1_000 });
        await driveOpen(cb, 1);
        expect(cb.getDiagnostics().nextRetryTime).toBeDefined();

        jest.advanceTimersByTime(1_001);
        expect(cb.getState()).toBe('HALF_OPEN');
        // The deadline has been used up, so it must not linger.
        expect(cb.getDiagnostics().nextRetryTime).toBeUndefined();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('HALF_OPEN admits a single probe (#353)', () => {
    it('lets exactly one concurrent probe through', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 5, successThreshold: 2 });
      await driveOpen(cb, 2);
      await new Promise((r) => setTimeout(r, 20));
      expect(cb.getState()).toBe('HALF_OPEN');

      let inFlight = 0;
      let maxInFlight = 0;
      const probe = async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 30));
        inFlight -= 1;
        return 'ok';
      };

      const results = await Promise.allSettled([
        cb.execute(probe),
        cb.execute(probe),
        cb.execute(probe),
        cb.execute(probe),
      ]);

      // The regression this guards: all four used to reach the endpoint.
      expect(maxInFlight).toBe(1);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(3);
    });

    it('rejects concurrent probes with a NETWORK_ERROR and does not count them as failures', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 5, successThreshold: 2 });
      await driveOpen(cb, 2);
      await new Promise((r) => setTimeout(r, 20));

      const failuresBefore = cb.getDiagnostics().failureCount;
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const probe = async () => {
        await gate;
        return 'ok';
      };

      const first = cb.execute(probe);
      let caught: unknown;
      try {
        await cb.execute(probe);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(TrustFlowError);
      expect((caught as Error).message).toMatch(/health probe is already in flight/i);

      // A rejected bystander must not count as an endpoint failure, or a
      // healthy endpoint would be driven back towards OPEN.
      expect(cb.getDiagnostics().failureCount).toBe(failuresBefore);

      release();
      await expect(first).resolves.toBe('ok');
    });

    it('releases the probe slot when the probe itself throws', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 5, successThreshold: 2 });
      await driveOpen(cb, 1);
      await new Promise((r) => setTimeout(r, 20));
      expect(cb.getState()).toBe('HALF_OPEN');

      // A failed probe sends the circuit back to OPEN...
      await expect(cb.execute(fail)).rejects.toThrow();
      expect(cb.getState()).toBe('OPEN');

      // ...and must not leave the slot stuck, or recovery is impossible.
      await new Promise((r) => setTimeout(r, 20));
      expect(cb.getState()).toBe('HALF_OPEN');
      await expect(cb.execute(ok)).resolves.toBe('ok');
    });
  });

  describe('HALF_OPEN requires consecutive successes (#353)', () => {
    it('closes only after successThreshold consecutive probes', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 5, successThreshold: 2 });
      await driveOpen(cb, 1);
      await new Promise((r) => setTimeout(r, 20));
      expect(cb.getState()).toBe('HALF_OPEN');

      await expect(cb.execute(ok)).resolves.toBe('ok');
      expect(cb.getState()).toBe('HALF_OPEN');
      await expect(cb.execute(ok)).resolves.toBe('ok');
      expect(cb.getState()).toBe('CLOSED');
    });

    it('does not carry successes across an OPEN -> HALF_OPEN cycle', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 5, successThreshold: 2 });
      await driveOpen(cb, 2);
      await new Promise((r) => setTimeout(r, 20));

      // One success, then a failure sends us back to OPEN with partial credit.
      await expect(cb.execute(ok)).resolves.toBe('ok');
      await expect(cb.execute(fail)).rejects.toThrow();
      expect(cb.getState()).toBe('OPEN');

      await new Promise((r) => setTimeout(r, 20));
      expect(cb.getState()).toBe('HALF_OPEN');
      // The stale success must not count towards the new attempt.
      expect(cb.getDiagnostics().successCount).toBe(0);

      // Previously a single success here closed the circuit immediately.
      await expect(cb.execute(ok)).resolves.toBe('ok');
      expect(cb.getState()).toBe('HALF_OPEN');
      await expect(cb.execute(ok)).resolves.toBe('ok');
      expect(cb.getState()).toBe('CLOSED');
    });
  });

  describe('recovery end to end', () => {
    it('recovers automatically after an outage without manual intervention', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 10, successThreshold: 1 });
      await driveOpen(cb, 3);
      expect(cb.getState()).toBe('OPEN');

      await new Promise((r) => setTimeout(r, 25));
      expect(cb.getState()).toBe('HALF_OPEN');
      await expect(cb.execute(ok)).resolves.toBe('ok');
      expect(cb.getState()).toBe('CLOSED');
    });

    it('re-opens when the probe fails, then recovers on a later timeout', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 10, successThreshold: 1 });
      await driveOpen(cb, 2);
      await new Promise((r) => setTimeout(r, 25));

      // Still down: probe fails, circuit re-opens.
      await expect(cb.execute(fail)).rejects.toThrow();
      expect(cb.getState()).toBe('OPEN');

      // Endpoint comes back.
      await new Promise((r) => setTimeout(r, 25));
      expect(cb.getState()).toBe('HALF_OPEN');
      await expect(cb.execute(ok)).resolves.toBe('ok');
      expect(cb.getState()).toBe('CLOSED');
    });

    it('manual reset returns the circuit to a clean CLOSED state', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1_000 });
      await driveOpen(cb, 1);
      expect(cb.getState()).toBe('OPEN');

      cb.reset();
      expect(cb.getState()).toBe('CLOSED');
      const diag = cb.getDiagnostics();
      expect(diag.failureCount).toBe(0);
      expect(diag.successCount).toBe(0);
      expect(diag.nextRetryTime).toBeUndefined();
      await expect(cb.execute(ok)).resolves.toBe('ok');
    });
  });

  describe('executeSync', () => {
    it('applies the same OPEN fail-fast behaviour', () => {
      const cb = new CircuitBreaker({ failureThreshold: 1 });
      const thrower = () => {
        throw new Error('down');
      };
      expect(() => cb.executeSync(thrower)).toThrow('down');
      expect(cb.getState()).toBe('OPEN');
      expect(() => cb.executeSync(() => 'ok')).toThrow(TrustFlowError);
    });
  });
});

describe('CircuitBreakerRegistry', () => {
  it('reuses one breaker per service and recovers each independently', async () => {
    jest.useFakeTimers();
    const registry = new CircuitBreakerRegistry();
    const primary = registry.get('primary', config);
    const fallback = registry.get('fallback', config);

    expect(registry.get('primary')).toBe(primary);

    // Both endpoints are down, as in the reported scenario.
    await expect(primary.execute(boom)).rejects.toThrow();
    await expect(primary.execute(boom)).rejects.toThrow();
    await expect(fallback.execute(boom)).rejects.toThrow();
    await expect(fallback.execute(boom)).rejects.toThrow();
    expect(primary.getState()).toBe('OPEN');
    expect(fallback.getState()).toBe('OPEN');

    // The endpoint recovers; neither breaker needs a manual reset.
    jest.advanceTimersByTime(1_000);
    expect(primary.getState()).toBe('HALF_OPEN');
    expect(fallback.getState()).toBe('HALF_OPEN');
    await expect(primary.execute(pong)).resolves.toBe('pong');
    await expect(fallback.execute(pong)).resolves.toBe('pong');
    expect(primary.getState()).toBe('CLOSED');
    expect(fallback.getState()).toBe('CLOSED');

    registry.resetAll();
    expect(registry.getAll().size).toBe(2);
    jest.useRealTimers();
  });
});

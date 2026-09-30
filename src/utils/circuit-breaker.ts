/**
 * Circuit breaker pattern implementation for external service failures.
 * Prevents cascading failures by failing fast when services are degraded.
 */

import { TrustFlowError } from '../errors';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
  /** Number of failures before opening circuit. Defaults to 5. */
  failureThreshold?: number;
  /** Time in milliseconds before attempting to recover. Defaults to 30000. */
  resetTimeoutMs?: number;
  /** Number of successful calls needed to close circuit from HALF_OPEN. Defaults to 2. */
  successThreshold?: number;
  /** Optional callback when state changes. */
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
  /** Optional callback when circuit opens. */
  onOpen?: (reason: string) => void;
}

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime?: number;
  private nextRetryTime?: number;

  readonly config: Required<CircuitBreakerConfig>;

  constructor(config?: CircuitBreakerConfig) {
    this.config = {
      failureThreshold: config?.failureThreshold ?? 5,
      resetTimeoutMs: config?.resetTimeoutMs ?? 30_000,
      successThreshold: config?.successThreshold ?? 2,
      onStateChange: config?.onStateChange ?? (() => {}),
      onOpen: config?.onOpen ?? (() => {}),
    };
  }

  /**
   * Gets the current circuit state.
   */
  getState(): CircuitState {
    if (this.state === 'OPEN') {
      if (this.nextRetryTime && Date.now() >= this.nextRetryTime) {
        this.setState('HALF_OPEN');
      }
    }
    return this.state;
  }

  /**
   * Executes a function with circuit breaker protection.
   * Fails fast if circuit is open.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.getState();

    if (state === 'OPEN') {
      throw new TrustFlowError(
        'Circuit breaker is OPEN. Service unavailable. Retrying after timeout.',
        'NETWORK_ERROR',
      );
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /**
   * Synchronous variant of execute for non-async functions.
   */
  executeSync<T>(fn: () => T): T {
    const state = this.getState();

    if (state === 'OPEN') {
      throw new TrustFlowError(
        'Circuit breaker is OPEN. Service unavailable. Retrying after timeout.',
        'NETWORK_ERROR',
      );
    }

    try {
      const result = fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /**
   * Records a successful call.
   */
  private onSuccess(): void {
    this.failureCount = 0;

    if (this.state === 'HALF_OPEN') {
      this.successCount++;
      if (this.successCount >= this.config.successThreshold) {
        this.setState('CLOSED');
        this.successCount = 0;
      }
    } else if (this.state === 'CLOSED') {
      this.successCount = 0;
    }
  }

  /**
   * Records a failed call.
   */
  private onFailure(): void {
    this.lastFailureTime = Date.now();
    this.failureCount++;

    if (this.state === 'HALF_OPEN') {
      this.setState('OPEN');
    } else if (this.state === 'CLOSED' && this.failureCount >= this.config.failureThreshold) {
      this.setState('OPEN');
    }
  }

  /**
   * Transitions to a new state.
   */
  private setState(newState: CircuitState): void {
    const oldState = this.state;
    this.state = newState;

    if (newState === 'OPEN') {
      this.nextRetryTime = Date.now() + this.config.resetTimeoutMs;
      this.config.onOpen(`Circuit opened after ${this.failureCount} failures`);
    }

    if (oldState !== newState) {
      this.config.onStateChange(oldState, newState);
    }
  }

  /**
   * Manually resets the circuit to CLOSED state.
   */
  reset(): void {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = undefined;
    this.nextRetryTime = undefined;
  }

  /**
   * Gets diagnostic information about the circuit.
   */
  getDiagnostics() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
      nextRetryTime: this.nextRetryTime,
      config: this.config,
    };
  }
}

/**
 * Creates a circuit breaker factory for managing multiple services.
 */
export class CircuitBreakerRegistry {
  private breakers = new Map<string, CircuitBreaker>();

  /**
   * Gets or creates a circuit breaker for a service.
   */
  get(serviceName: string, config?: CircuitBreakerConfig): CircuitBreaker {
    if (!this.breakers.has(serviceName)) {
      this.breakers.set(serviceName, new CircuitBreaker(config));
    }
    return this.breakers.get(serviceName)!;
  }

  /**
   * Removes a circuit breaker.
   */
  remove(serviceName: string): void {
    this.breakers.delete(serviceName);
  }

  /**
   * Gets all registered circuit breakers.
   */
  getAll(): Map<string, CircuitBreaker> {
    return new Map(this.breakers);
  }

  /**
   * Resets all circuit breakers.
   */
  resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }

  /**
   * Gets diagnostic info for all breakers.
   */
  getDiagnostics() {
    const result: Record<string, any> = {};
    for (const [name, breaker] of this.breakers) {
      result[name] = breaker.getDiagnostics();
    }
    return result;
  }
}

/**
 * Global circuit breaker registry instance.
 */
export const globalCircuitBreakerRegistry = new CircuitBreakerRegistry();

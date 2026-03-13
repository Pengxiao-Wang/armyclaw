// ═══════════════════════════════════════════════════════════
// ArmyClaw — Circuit Breaker
// Three states: CLOSED (normal) → OPEN (failing) → HALF_OPEN (testing)
// Ported from IronClaw's circuit_breaker.rs
// ═══════════════════════════════════════════════════════════

import { CircuitState } from '../types.js';

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private lastFailureTime = 0;
  private halfOpenAttempts = 0;

  constructor(
    private readonly failureThreshold: number,
    private readonly resetTimeoutMs: number,
    private readonly halfOpenMax: number,
  ) {}

  /**
   * Pre-flight check: is a call allowed right now?
   *
   * CLOSED: always allowed
   * OPEN:   blocked unless resetTimeoutMs has elapsed → transition to HALF_OPEN
   * HALF_OPEN: allowed up to halfOpenMax concurrent probes
   */
  canExecute(): boolean {
    switch (this.state) {
      case 'closed':
        return true;

      case 'open': {
        const elapsed = Date.now() - this.lastFailureTime;
        if (elapsed >= this.resetTimeoutMs) {
          // Recovery timeout elapsed — transition to half-open for probing
          this.state = 'half_open';
          this.halfOpenAttempts = 0;
          return true;
        }
        return false;
      }

      case 'half_open':
        if (this.halfOpenAttempts < this.halfOpenMax) {
          this.halfOpenAttempts++;
          return true;
        }
        return false;

      default:
        return false;
    }
  }

  /**
   * Record a successful call.
   *
   * CLOSED:    reset failure counter
   * HALF_OPEN: close the circuit (fully recovered)
   */
  recordSuccess(): void {
    switch (this.state) {
      case 'closed':
        this.failureCount = 0;
        break;

      case 'half_open':
        // Probe succeeded — circuit recovers
        this.state = 'closed';
        this.failureCount = 0;
        this.halfOpenAttempts = 0;
        break;

      case 'open':
        // Shouldn't happen (canExecute blocks), but recover gracefully
        this.state = 'closed';
        this.failureCount = 0;
        break;
    }
  }

  /**
   * Record a failed call.
   *
   * CLOSED:    increment failures; trip to OPEN if threshold reached
   * HALF_OPEN: probe failed → immediately reopen
   */
  recordFailure(): void {
    this.lastFailureTime = Date.now();

    switch (this.state) {
      case 'closed':
        this.failureCount++;
        if (this.failureCount >= this.failureThreshold) {
          this.state = 'open';
        }
        break;

      case 'half_open':
        // Probe failed — back to open, reset half-open counter
        this.state = 'open';
        this.halfOpenAttempts = 0;
        break;

      case 'open':
        // Already open, just update timestamp
        break;
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  reset(): void {
    this.state = 'closed';
    this.failureCount = 0;
    this.lastFailureTime = 0;
    this.halfOpenAttempts = 0;
  }
}

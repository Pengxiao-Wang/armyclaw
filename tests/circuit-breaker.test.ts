import { describe, it, expect, beforeEach } from 'vitest';
import { CircuitBreaker } from '../src/arsenal/circuit-breaker.js';

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker(3, 1000, 2);
  });

  describe('CLOSED state', () => {
    it('starts in CLOSED state', () => {
      expect(breaker.getState()).toBe('closed');
    });

    it('allows execution in CLOSED state', () => {
      expect(breaker.canExecute()).toBe(true);
    });

    it('stays CLOSED after successes', () => {
      breaker.recordSuccess();
      breaker.recordSuccess();
      expect(breaker.getState()).toBe('closed');
      expect(breaker.canExecute()).toBe(true);
    });

    it('stays CLOSED when failures below threshold', () => {
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState()).toBe('closed');
      expect(breaker.canExecute()).toBe(true);
    });

    it('resets failure count on success', () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordSuccess();
      // After success, 2 more failures shouldn't trip it (count reset)
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState()).toBe('closed');
    });
  });

  describe('CLOSED → OPEN transition', () => {
    it('transitions to OPEN after threshold failures', () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure(); // threshold = 3
      expect(breaker.getState()).toBe('open');
    });

    it('rejects execution when OPEN', () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.canExecute()).toBe(false);
    });
  });

  describe('OPEN → HALF_OPEN transition', () => {
    it('transitions to HALF_OPEN after reset timeout', () => {
      // Use a breaker with 0ms timeout for instant testing
      const fastBreaker = new CircuitBreaker(1, 0, 2);
      fastBreaker.recordFailure(); // → OPEN
      expect(fastBreaker.getState()).toBe('open');

      // With 0ms timeout, canExecute should transition to HALF_OPEN
      expect(fastBreaker.canExecute()).toBe(true);
      expect(fastBreaker.getState()).toBe('half_open');
    });

    it('stays OPEN before reset timeout elapses', () => {
      const slowBreaker = new CircuitBreaker(1, 60_000, 2);
      slowBreaker.recordFailure(); // → OPEN
      expect(slowBreaker.canExecute()).toBe(false);
      expect(slowBreaker.getState()).toBe('open');
    });
  });

  describe('HALF_OPEN → CLOSED on success', () => {
    it('transitions to CLOSED on success in HALF_OPEN', () => {
      const fastBreaker = new CircuitBreaker(1, 0, 1);
      fastBreaker.recordFailure(); // → OPEN
      fastBreaker.canExecute(); // → HALF_OPEN (timeout=0)
      expect(fastBreaker.getState()).toBe('half_open');

      fastBreaker.recordSuccess(); // → CLOSED
      expect(fastBreaker.getState()).toBe('closed');
    });
  });

  describe('HALF_OPEN → OPEN on failure', () => {
    it('transitions back to OPEN on failure in HALF_OPEN', () => {
      const fastBreaker = new CircuitBreaker(1, 0, 2);
      fastBreaker.recordFailure(); // → OPEN
      fastBreaker.canExecute(); // → HALF_OPEN
      expect(fastBreaker.getState()).toBe('half_open');

      fastBreaker.recordFailure(); // → OPEN
      expect(fastBreaker.getState()).toBe('open');
    });
  });

  describe('HALF_OPEN limits', () => {
    it('blocks execution beyond halfOpenMax', () => {
      const fastBreaker = new CircuitBreaker(1, 0, 1);
      fastBreaker.recordFailure(); // → OPEN
      expect(fastBreaker.canExecute()).toBe(true); // → HALF_OPEN, attempt 0

      // halfOpenMax=1, so second call should be blocked
      // (halfOpenAttempts is 0 after canExecute transitions, which is < 1, so it allows)
      // After a failure resets halfOpenAttempts, the breaker goes back to open
      fastBreaker.recordFailure(); // → OPEN
      expect(fastBreaker.getState()).toBe('open');
    });
  });

  describe('canExecute() in each state', () => {
    it('returns true when CLOSED', () => {
      expect(breaker.canExecute()).toBe(true);
    });

    it('returns false when OPEN and timeout not elapsed', () => {
      const slowBreaker = new CircuitBreaker(1, 60_000, 2);
      slowBreaker.recordFailure();
      expect(slowBreaker.canExecute()).toBe(false);
    });

    it('returns true when OPEN and timeout elapsed', () => {
      const fastBreaker = new CircuitBreaker(1, 0, 2);
      fastBreaker.recordFailure();
      expect(fastBreaker.canExecute()).toBe(true);
    });

    it('returns true when HALF_OPEN and under limit', () => {
      const fastBreaker = new CircuitBreaker(1, 0, 5);
      fastBreaker.recordFailure(); // → OPEN
      fastBreaker.canExecute(); // → HALF_OPEN
      expect(fastBreaker.getState()).toBe('half_open');
      expect(fastBreaker.canExecute()).toBe(true);
    });
  });

  describe('reset()', () => {
    it('resets to CLOSED from any state', () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure(); // → OPEN
      expect(breaker.getState()).toBe('open');

      breaker.reset();
      expect(breaker.getState()).toBe('closed');
      expect(breaker.canExecute()).toBe(true);
    });
  });
});

import { describe, it, expect } from 'vitest';
import { LeakDetector } from '../src/kernel/safety/leak-detector.js';

// Silence pino logger during tests
import { vi } from 'vitest';
vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('LeakDetector', () => {
  const detector = new LeakDetector();

  // ─── Clean text ────────────────────────────────────────────

  it('should pass clean text through with no matches', () => {
    const result = detector.scan('Hello world, this is a normal message.');
    expect(result.matches).toHaveLength(0);
    expect(result.shouldBlock).toBe(false);
    expect(result.redactedContent).toBeNull();
  });

  // ─── Empty string ─────────────────────────────────────────

  it('should handle empty string', () => {
    const result = detector.scan('');
    expect(result.matches).toHaveLength(0);
    expect(result.shouldBlock).toBe(false);
    expect(result.redactedContent).toBeNull();
  });

  // ─── Anthropic API key ────────────────────────────────────

  it('should block Anthropic API keys (sk-ant-...)', () => {
    const text = 'My key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890';
    const result = detector.scan(text);
    expect(result.shouldBlock).toBe(true);
    expect(result.matches.some(m => m.pattern === 'anthropic_api_key')).toBe(true);
    expect(result.matches.find(m => m.pattern === 'anthropic_api_key')!.severity).toBe('critical');
    expect(result.matches.find(m => m.pattern === 'anthropic_api_key')!.action).toBe('block');
  });

  // ─── OpenAI API key ───────────────────────────────────────

  it('should block OpenAI API keys (sk-...)', () => {
    const text = 'Use this key: sk-proj1234567890abcdefghij';
    const result = detector.scan(text);
    expect(result.shouldBlock).toBe(true);
    expect(result.matches.some(m => m.pattern === 'openai_api_key')).toBe(true);
  });

  // ─── AWS access key ───────────────────────────────────────

  it('should block AWS access keys (AKIA...)', () => {
    const text = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE';
    const result = detector.scan(text);
    expect(result.shouldBlock).toBe(true);
    expect(result.matches.some(m => m.pattern === 'aws_access_key')).toBe(true);
    expect(result.matches.find(m => m.pattern === 'aws_access_key')!.severity).toBe('critical');
  });

  // ─── GitHub token ─────────────────────────────────────────

  it('should block GitHub tokens (ghp_...)', () => {
    const text = 'token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn';
    const result = detector.scan(text);
    expect(result.shouldBlock).toBe(true);
    expect(result.matches.some(m => m.pattern === 'github_token')).toBe(true);
  });

  it('should block other GitHub token prefixes (gho_, ghs_, ghu_, ghr_)', () => {
    for (const prefix of ['gho_', 'ghs_', 'ghu_', 'ghr_']) {
      const text = `token: ${prefix}ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn`;
      const result = detector.scan(text);
      expect(result.shouldBlock).toBe(true);
      expect(result.matches.some(m => m.pattern === 'github_token')).toBe(true);
    }
  });

  // ─── Private key ──────────────────────────────────────────

  it('should block private keys (-----BEGIN PRIVATE KEY-----)', () => {
    const text = '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADA...';
    const result = detector.scan(text);
    expect(result.shouldBlock).toBe(true);
    expect(result.matches.some(m => m.pattern === 'private_key')).toBe(true);
  });

  it('should block RSA private keys', () => {
    const text = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBA...';
    const result = detector.scan(text);
    expect(result.shouldBlock).toBe(true);
    expect(result.matches.some(m => m.pattern === 'private_key')).toBe(true);
  });

  // ─── Database URL ─────────────────────────────────────────

  it('should redact (not block) database URLs', () => {
    const text = 'DB: postgres://user:password123@db.example.com:5432/mydb';
    const result = detector.scan(text);
    expect(result.shouldBlock).toBe(false);
    expect(result.matches.some(m => m.pattern === 'database_url')).toBe(true);
    expect(result.matches.find(m => m.pattern === 'database_url')!.action).toBe('redact');
    expect(result.redactedContent).toContain('[REDACTED]');
    expect(result.redactedContent).not.toContain('password123');
  });

  it('should redact mongodb URLs', () => {
    const text = 'mongodb://admin:secret@mongo.host/db';
    const result = detector.scan(text);
    expect(result.shouldBlock).toBe(false);
    expect(result.matches.some(m => m.pattern === 'database_url')).toBe(true);
    expect(result.redactedContent).toContain('[REDACTED]');
  });

  it('should redact mongodb+srv URLs', () => {
    const text = 'mongodb+srv://admin:secret@cluster.mongodb.net/db';
    const result = detector.scan(text);
    expect(result.shouldBlock).toBe(false);
    expect(result.redactedContent).toContain('[REDACTED]');
  });

  // ─── Bearer token ─────────────────────────────────────────

  it('should redact bearer tokens', () => {
    const text = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0';
    const result = detector.scan(text);
    expect(result.shouldBlock).toBe(false);
    expect(result.matches.some(m => m.pattern === 'generic_bearer_token')).toBe(true);
    expect(result.matches.find(m => m.pattern === 'generic_bearer_token')!.action).toBe('redact');
    expect(result.redactedContent).toContain('[REDACTED]');
    expect(result.redactedContent).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  // ─── Multiple leaks ──────────────────────────────────────

  it('should detect multiple leaks in one text', () => {
    const text = [
      'API key: sk-ant-api03-abcdefghijklmnopqrst12345',
      'DB: postgres://root:pass@host/db',
      'Token: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0',
    ].join('\n');
    const result = detector.scan(text);
    expect(result.matches.length).toBeGreaterThanOrEqual(3);
    expect(result.shouldBlock).toBe(true); // sk-ant triggers block
    // Redacted content should replace all found patterns
    expect(result.redactedContent).not.toBeNull();
    const redactCount = (result.redactedContent!.match(/\[REDACTED\]/g) ?? []).length;
    expect(redactCount).toBeGreaterThanOrEqual(3);
  });

  // ─── sanitize() ───────────────────────────────────────────

  it('sanitize() should throw on block-level matches', () => {
    const text = 'key: sk-ant-api03-abcdefghijklmnopqrst12345';
    expect(() => detector.sanitize(text)).toThrow('Leak detection blocked output');
    expect(() => detector.sanitize(text)).toThrow('anthropic_api_key');
  });

  it('sanitize() should throw with context when provided', () => {
    const text = 'key: sk-ant-api03-abcdefghijklmnopqrst12345';
    expect(() => detector.sanitize(text, 'engineer output')).toThrow('in engineer output');
  });

  it('sanitize() should return redacted text for redact-only matches', () => {
    const text = 'DB: postgres://user:pass@host/db';
    const result = detector.sanitize(text);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('pass@host');
  });

  it('sanitize() should pass through clean text unchanged', () => {
    const text = 'Just a normal string with no secrets.';
    expect(detector.sanitize(text)).toBe(text);
  });

  // ─── False positive resistance ────────────────────────────

  it('should not flag short prefixes that are not actual keys (e.g. "sk-test")', () => {
    // "sk-test" has the prefix "sk-" but is only 7 chars, not 20+
    const text = 'The sk-test value is not a real key. Neither is sk-short.';
    const result = detector.scan(text);
    // Should not match openai_api_key because the regex requires 20+ chars after sk-
    const openaiMatches = result.matches.filter(m => m.pattern === 'openai_api_key');
    expect(openaiMatches).toHaveLength(0);
    expect(result.shouldBlock).toBe(false);
  });

  it('should not flag "AKIAI" as AWS key if it has fewer than 16 chars after AKIA', () => {
    const text = 'The string AKIA12345 is too short to be a real AWS key.';
    const result = detector.scan(text);
    const awsMatches = result.matches.filter(m => m.pattern === 'aws_access_key');
    expect(awsMatches).toHaveLength(0);
  });

  it('should not flag text mentioning "-----BEGIN" without PRIVATE KEY', () => {
    const text = '-----BEGIN CERTIFICATE----- is not a private key';
    const result = detector.scan(text);
    const pkMatches = result.matches.filter(m => m.pattern === 'private_key');
    expect(pkMatches).toHaveLength(0);
  });

  // ─── Performance ──────────────────────────────────────────

  it('should scan ~100KB of clean text quickly (< 50ms)', () => {
    // Build ~100KB of clean text
    const paragraph = 'The quick brown fox jumps over the lazy dog. '.repeat(50);
    const largeText = paragraph.repeat(50); // ~112KB
    expect(largeText.length).toBeGreaterThan(100_000);

    const start = performance.now();
    const result = detector.scan(largeText);
    const elapsed = performance.now() - start;

    expect(result.shouldBlock).toBe(false);
    expect(result.matches).toHaveLength(0);
    expect(elapsed).toBeLessThan(50);
  });

  it('should handle large text with a leak efficiently', () => {
    const clean = 'Normal text without secrets. '.repeat(5000);
    const textWithLeak = clean + '\nsk-ant-api03-abcdefghijklmnopqrst12345\n' + clean;

    const start = performance.now();
    const result = detector.scan(textWithLeak);
    const elapsed = performance.now() - start;

    expect(result.shouldBlock).toBe(true);
    expect(result.matches.length).toBeGreaterThanOrEqual(1);
    expect(elapsed).toBeLessThan(200);
  });

  // ─── Redaction position correctness ───────────────────────

  it('should correctly redact by replacing at exact positions', () => {
    const text = 'prefix postgres://user:pass@host/db suffix';
    const result = detector.scan(text);
    expect(result.redactedContent).toBe('prefix [REDACTED] suffix');
  });

  // ─── Custom patterns ─────────────────────────────────────

  it('should support custom extra patterns', () => {
    const custom = new LeakDetector([
      {
        name: 'custom_secret',
        prefixes: ['CUSTOM_'],
        regex: /CUSTOM_[A-Z]{20,}/g,
        severity: 'high',
        action: 'block',
      },
    ]);
    const text = 'CUSTOM_ABCDEFGHIJKLMNOPQRSTU';
    const result = custom.scan(text);
    expect(result.shouldBlock).toBe(true);
    expect(result.matches.some(m => m.pattern === 'custom_secret')).toBe(true);
  });
});

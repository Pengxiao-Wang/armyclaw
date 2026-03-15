// ArmyClaw — Leak Detector
// Two-stage detection: fast prefix scan → regex validation
// Inspired by IronClaw's Aho-Corasick + regex approach

import { logger } from '../../logger.js';
import type { LeakAction, LeakSeverity, LeakMatch, LeakScanResult } from '../../types.js';

interface LeakPattern {
  name: string;
  prefixes: string[];     // fast prefix scan (stage 1)
  regex: RegExp;           // precise validation (stage 2)
  severity: LeakSeverity;
  action: LeakAction;
}

// Built-in patterns (from IronClaw + ArmyClaw-specific)
const DEFAULT_PATTERNS: LeakPattern[] = [
  {
    name: 'anthropic_api_key',
    prefixes: ['sk-ant-'],
    regex: /sk-ant-[a-zA-Z0-9_-]{20,}/g,
    severity: 'critical',
    action: 'block',
  },
  {
    name: 'openai_api_key',
    prefixes: ['sk-'],
    regex: /sk-[a-zA-Z0-9]{20,}/g,
    severity: 'critical',
    action: 'block',
  },
  {
    name: 'aws_access_key',
    prefixes: ['AKIA'],
    regex: /AKIA[0-9A-Z]{16}/g,
    severity: 'critical',
    action: 'block',
  },
  {
    name: 'github_token',
    prefixes: ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_'],
    regex: /gh[pousr]_[A-Za-z0-9_]{36,}/g,
    severity: 'critical',
    action: 'block',
  },
  {
    name: 'private_key',
    prefixes: ['-----BEGIN'],
    regex: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/g,
    severity: 'critical',
    action: 'block',
  },
  {
    name: 'database_url',
    prefixes: ['postgres://', 'postgresql://', 'mongodb://', 'mongodb+srv://', 'mysql://'],
    regex: /(postgres|postgresql|mongodb|mongodb\+srv|mysql):\/\/[^\s'"]+/g,
    severity: 'high',
    action: 'redact',
  },
  {
    name: 'lark_app_secret',
    prefixes: ['j5Fpj7'],  // ArmyClaw's known Lark secret prefix
    regex: /[a-zA-Z0-9]{32,}/g,  // only triggered if prefix matches
    severity: 'critical',
    action: 'block',
  },
  {
    name: 'generic_bearer_token',
    prefixes: ['Bearer ey'],
    regex: /Bearer\s+ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    severity: 'medium',
    action: 'redact',
  },
];

export class LeakDetector {
  private patterns: LeakPattern[];

  constructor(extraPatterns?: LeakPattern[]) {
    this.patterns = [...DEFAULT_PATTERNS, ...(extraPatterns ?? [])];
  }

  /**
   * Scan text for leaked secrets.
   * Stage 1: Check if any known prefix appears in text (fast, O(n) string search)
   * Stage 2: Run regex only for patterns whose prefix was found
   */
  scan(text: string): LeakScanResult {
    if (!text || text.length === 0) {
      return { matches: [], shouldBlock: false, redactedContent: null };
    }

    // Stage 1: Fast prefix scan
    const candidatePatterns: LeakPattern[] = [];
    for (const pattern of this.patterns) {
      for (const prefix of pattern.prefixes) {
        if (text.includes(prefix)) {
          candidatePatterns.push(pattern);
          break; // one prefix match is enough to activate this pattern
        }
      }
    }

    // 99% of clean text exits here
    if (candidatePatterns.length === 0) {
      return { matches: [], shouldBlock: false, redactedContent: null };
    }

    // Stage 2: Regex validation on candidates
    const matches: LeakMatch[] = [];

    for (const pattern of candidatePatterns) {
      // Reset regex lastIndex for global patterns
      pattern.regex.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = pattern.regex.exec(text)) !== null) {
        matches.push({
          pattern: pattern.name,
          severity: pattern.severity,
          action: pattern.action,
          location: { start: match.index, end: match.index + match[0].length },
        });
      }
    }

    if (matches.length === 0) {
      return { matches: [], shouldBlock: false, redactedContent: null };
    }

    // Determine actions
    const shouldBlock = matches.some((m) => m.action === 'block');

    // Build redacted content (replace all matches with [REDACTED])
    let redactedContent: string | null = null;
    const redactMatches = matches.filter((m) => m.action === 'redact' || m.action === 'block');
    if (redactMatches.length > 0) {
      // Sort by start position descending to replace from end (preserves positions)
      const sorted = [...redactMatches].sort((a, b) => b.location.start - a.location.start);
      redactedContent = text;
      for (const m of sorted) {
        redactedContent =
          redactedContent.slice(0, m.location.start) +
          '[REDACTED]' +
          redactedContent.slice(m.location.end);
      }
    }

    // Log detections
    for (const m of matches) {
      logger.warn(
        { pattern: m.pattern, severity: m.severity, action: m.action },
        'Leak detected',
      );
    }

    return { matches, shouldBlock, redactedContent };
  }

  /**
   * Convenience: scan and return safe content.
   * If blocked, throws. If redacted, returns redacted version. Otherwise returns original.
   */
  sanitize(text: string, context?: string): string {
    const result = this.scan(text);

    if (result.shouldBlock) {
      const patternNames = result.matches.filter(m => m.action === 'block').map(m => m.pattern).join(', ');
      throw new Error(
        `Leak detection blocked output: ${patternNames} detected${context ? ` in ${context}` : ''}`,
      );
    }

    return result.redactedContent ?? text;
  }
}

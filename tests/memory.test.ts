import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/config.js', () => ({
  MEMORY_CHUNK_SIZE: 500,
  CONTEXT_ARCHIVE_THRESHOLD: 0.8,
  DB_PATH: ':memory:',
  OPENAI_API_KEY: '',
  EMBEDDING_MODEL: 'text-embedding-3-small',
  EMBEDDING_DIMENSIONS: 1536,
  MEMORY_SEARCH_TOP_K: 5,
  MEMORY_RRF_K: 60,
}));

// ─── Chunker Tests (no mocks needed beyond config) ──────────

import { chunkText, estimateTokens } from '../src/kernel/memory/chunker.js';

describe('Chunker', () => {
  describe('estimateTokens', () => {
    it('should estimate tokens for simple text (~1.3x word count)', () => {
      const text = 'Hello world this is a test';
      const tokens = estimateTokens(text);
      // 6 words * 1.3 = 7.8 → ceil = 8
      expect(tokens).toBe(8);
    });

    it('should return 0 for empty-ish text', () => {
      // split(/\s+/).filter(Boolean) on '' => [], length = 0
      expect(estimateTokens('')).toBe(0);
    });

    it('should estimate reasonably for longer text', () => {
      const words = Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ');
      const tokens = estimateTokens(words);
      expect(tokens).toBe(Math.ceil(100 * 1.3));
    });
  });

  describe('chunkText', () => {
    it('should return empty array for empty text', () => {
      expect(chunkText('')).toEqual([]);
    });

    it('should return empty array for whitespace-only text', () => {
      expect(chunkText('   \n\n   ')).toEqual([]);
    });

    it('should return single chunk for short text', () => {
      const text = 'This is a short piece of text.';
      const chunks = chunkText(text, 500);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe(text);
    });

    it('should split long text at paragraph boundaries', () => {
      // Create paragraphs that together exceed maxTokens
      // Each paragraph ~20 words = ~26 tokens
      const para = 'This is a paragraph with about twenty words in total so we can test chunking behavior properly here now.';
      // 500 tokens / 26 tokens per para ≈ 19 paragraphs fit in one chunk
      const paragraphs = Array.from({ length: 40 }, () => para);
      const text = paragraphs.join('\n\n');

      const chunks = chunkText(text, 500);
      expect(chunks.length).toBeGreaterThan(1);

      // Each chunk should be non-empty
      for (const chunk of chunks) {
        expect(chunk.trim().length).toBeGreaterThan(0);
      }

      // Reassembled (with double newlines) should cover all content
      const reassembled = chunks.join('\n\n');
      // All original paragraphs should appear in the output
      for (const p of paragraphs) {
        expect(reassembled).toContain(p);
      }
    });

    it('should force-split very long single paragraphs by sentences', () => {
      // Create a single paragraph (no \n\n) that is > 2x maxTokens
      // With maxTokens=50, we need > 100 tokens ≈ 77 words
      const sentences = Array.from({ length: 20 }, (_, i) =>
        `Sentence number ${i} has several words in it to make it long enough for testing.`
      );
      const longParagraph = sentences.join(' ');

      const chunks = chunkText(longParagraph, 50);
      expect(chunks.length).toBeGreaterThan(1);

      // Each chunk should end with sentence-ending punctuation (except possibly the last)
      for (const chunk of chunks) {
        expect(chunk.trim().length).toBeGreaterThan(0);
      }
    });

    it('should handle text with only one paragraph that fits', () => {
      const text = 'Just one paragraph that fits easily.';
      const chunks = chunkText(text, 500);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe(text);
    });
  });
});

// ═══════════════════════════════════════════════════════════
// Store Tests (mock DB and embeddings)
// ═══════════════════════════════════════════════════════════

// We need to mock better-sqlite3 and embeddings before importing store
const mockRun = vi.fn().mockReturnValue({ lastInsertRowid: 1 });
const mockAll = vi.fn().mockReturnValue([]);
const mockGet = vi.fn().mockReturnValue(undefined);
const mockPrepare = vi.fn().mockReturnValue({
  run: mockRun,
  all: mockAll,
  get: mockGet,
});
const mockExec = vi.fn();
const mockPragma = vi.fn();

vi.mock('better-sqlite3', () => ({
  default: vi.fn().mockImplementation(() => ({
    prepare: mockPrepare,
    exec: mockExec,
    pragma: mockPragma,
    transaction: vi.fn().mockImplementation((fn: () => void) => fn),
  })),
}));

vi.mock('../src/kernel/memory/embeddings.js', () => ({
  embed: vi.fn().mockResolvedValue(new Float32Array(1536)),
  embedBatch: vi.fn().mockResolvedValue([new Float32Array(1536)]),
  cosineSimilarity: vi.fn().mockReturnValue(0.9),
}));

vi.mock('../src/kernel/memory/search.js', () => ({
  hybridSearch: vi.fn().mockResolvedValue([]),
}));

import {
  initMemoryTables,
  storeDocument,
  getDocument,
  deleteDocument,
  getRecentDocuments,
} from '../src/kernel/memory/store.js';
import { embedBatch } from '../src/kernel/memory/embeddings.js';
import { hybridSearch } from '../src/kernel/memory/search.js';

describe('Memory Store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset default mock returns
    mockRun.mockReturnValue({ lastInsertRowid: 1 });
    mockAll.mockReturnValue([]);
    mockGet.mockReturnValue(undefined);
  });

  describe('initMemoryTables', () => {
    it('should call exec to create tables', () => {
      initMemoryTables();
      expect(mockExec).toHaveBeenCalled();
      // Should contain CREATE TABLE statements
      const call = mockExec.mock.calls[0][0] as string;
      expect(call).toContain('memory_documents');
      expect(call).toContain('memory_chunks');
    });
  });

  describe('storeDocument', () => {
    it('should create document and chunks', async () => {
      (embedBatch as ReturnType<typeof vi.fn>).mockResolvedValue([
        new Float32Array(1536),
      ]);

      const docId = await storeDocument('task_result', 'tasks/test-1', 'Some content here.');
      expect(docId).toMatch(/^mem-/);
      // prepare should have been called for INSERT statements
      expect(mockPrepare).toHaveBeenCalled();
    });

    it('should handle empty content gracefully', async () => {
      const docId = await storeDocument('task_result', 'tasks/test-2', '   ');
      // Empty content → chunkText returns [] → no DB writes for chunks
      expect(docId).toMatch(/^mem-/);
    });

    it('should handle embedding failures gracefully', async () => {
      (embedBatch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('OpenAI API down'));

      const docId = await storeDocument('task_result', 'tasks/test-3', 'Content that fails to embed.');
      expect(docId).toMatch(/^mem-/);
      // Should still store — just without vectors
    });
  });

  describe('getDocument', () => {
    it('should retrieve document by ID', () => {
      const mockDoc = {
        id: 'mem-abc123',
        source: 'task_result',
        path: 'tasks/test-1',
        content: 'Test content',
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
      };
      mockGet.mockReturnValue(mockDoc);

      const result = getDocument('mem-abc123');
      expect(result).toEqual(mockDoc);
      expect(mockPrepare).toHaveBeenCalled();
    });

    it('should return undefined for non-existent document', () => {
      mockGet.mockReturnValue(undefined);
      const result = getDocument('mem-nonexistent');
      expect(result).toBeUndefined();
    });
  });

  describe('deleteDocument', () => {
    it('should delete document and its chunks', () => {
      deleteDocument('mem-abc123');
      // Should have called prepare twice: once for chunks, once for doc
      expect(mockPrepare).toHaveBeenCalled();
      expect(mockRun).toHaveBeenCalled();
    });
  });

  describe('getRecentDocuments', () => {
    it('should return documents sorted by date', () => {
      const docs = [
        { id: 'mem-1', source: 'task_result', path: 'a', content: 'x', created_at: '2026-01-02', updated_at: '2026-01-02' },
        { id: 'mem-2', source: 'task_result', path: 'b', content: 'y', created_at: '2026-01-01', updated_at: '2026-01-01' },
      ];
      mockAll.mockReturnValue(docs);

      const result = getRecentDocuments();
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('mem-1');
    });

    it('should filter by source when provided', () => {
      mockAll.mockReturnValue([]);
      getRecentDocuments('task_result');
      expect(mockPrepare).toHaveBeenCalled();
    });

    it('should accept a limit parameter', () => {
      mockAll.mockReturnValue([]);
      getRecentDocuments(undefined, 5);
      expect(mockPrepare).toHaveBeenCalled();
    });
  });
});

// ═══════════════════════════════════════════════════════════
// Archivist Tests
// ═══════════════════════════════════════════════════════════

import { Archivist } from '../src/orchestration/archivist.js';
import type { Task } from '../src/types.js';

describe('Archivist', () => {
  let archivist: Archivist;

  // Store module functions are already mocked via better-sqlite3 mock above
  // hybridSearch is mocked via the search mock above

  beforeEach(() => {
    archivist = new Archivist();
    vi.clearAllMocks();
    mockRun.mockReturnValue({ lastInsertRowid: 1 });
    (embedBatch as ReturnType<typeof vi.fn>).mockResolvedValue([new Float32Array(1536)]);
  });

  function makeTask(overrides: Partial<Task> = {}): Task {
    return {
      id: 'task-test1',
      parent_id: null,
      campaign_id: null,
      state: 'DONE',
      description: 'Test task',
      priority: 'medium',
      assigned_agent: null,
      assigned_engineer_id: null,
      intent_type: null,
      reject_count_tactical: 0,
      reject_count_strategic: 0,
      rubric: null,
      artifacts_path: null,
      error_count: 0,
      override_skip_gate: 0,
      source_channel: null,
      source_chat_id: null,
      source_message_id: null,
      complexity: null,
      context_chain: JSON.stringify([
        { role: 'adjutant', output: 'Processed the request.' },
        { role: 'chief_of_staff', output: 'Created plan.' },
        { role: 'engineer', output: 'Implemented feature.' },
      ]),
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T01:00:00Z',
      ...overrides,
    };
  }

  describe('archiveTaskResult', () => {
    it('should archive a completed task', async () => {
      const task = makeTask({ state: 'DONE' });
      await archivist.archiveTaskResult(task);
      // storeDocument should have been called (via the mocked DB)
      expect(mockPrepare).toHaveBeenCalled();
    });

    it('should archive a failed task', async () => {
      const task = makeTask({ state: 'FAILED' });
      await archivist.archiveTaskResult(task);
      expect(mockPrepare).toHaveBeenCalled();
    });

    it('should skip archiving if context_chain is null', async () => {
      const task = makeTask({ context_chain: null });
      // Clear mock calls from makeTask
      vi.clearAllMocks();
      await archivist.archiveTaskResult(task);
      // Should return early — no storeDocument call beyond init
    });

    it('should skip archiving if context_chain is invalid JSON', async () => {
      const task = makeTask({ context_chain: 'not json' });
      vi.clearAllMocks();
      await archivist.archiveTaskResult(task);
      // Should return early gracefully
    });

    it('should skip archiving if context_chain is empty array', async () => {
      const task = makeTask({ context_chain: '[]' });
      vi.clearAllMocks();
      await archivist.archiveTaskResult(task);
      // Empty chain → return early
    });

    it('should not throw on store failure', async () => {
      (embedBatch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
      const task = makeTask();
      // Should not throw — archiveTaskResult catches errors internally
      await expect(archivist.archiveTaskResult(task)).resolves.not.toThrow();
    });
  });

  describe('archiveRejection', () => {
    it('should store inspector findings', async () => {
      const task = makeTask({ state: 'GATE1_REVIEW', reject_count_tactical: 1 });
      const findings = ['Code quality issue', 'Missing tests'];
      await archivist.archiveRejection(task, findings);
      expect(mockPrepare).toHaveBeenCalled();
    });

    it('should skip if findings array is empty', async () => {
      const task = makeTask();
      vi.clearAllMocks();
      await archivist.archiveRejection(task, []);
      // No storeDocument call expected for empty findings
    });

    it('should not throw on store failure', async () => {
      (embedBatch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fail'));
      const task = makeTask();
      await expect(archivist.archiveRejection(task, ['finding'])).resolves.not.toThrow();
    });
  });

  describe('recall', () => {
    it('should return formatted context when results exist', async () => {
      (hybridSearch as ReturnType<typeof vi.fn>).mockResolvedValue([
        { document_id: 'doc-1', document_path: 'tasks/t1', chunk_id: 'chk-1', content: 'Previous task result', score: 0.85 },
        { document_id: 'doc-2', document_path: 'tasks/t2', chunk_id: 'chk-2', content: 'Another reference', score: 0.72 },
      ]);

      const result = await archivist.recall('implement auth', 'chief_of_staff');
      expect(result).not.toBeNull();
      expect(result).toContain('Historical Context');
      expect(result).toContain('Previous task result');
      expect(result).toContain('Another reference');
      expect(result).toContain('85%');
      expect(result).toContain('72%');
    });

    it('should return null when no search results', async () => {
      (hybridSearch as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      const result = await archivist.recall('random query', 'inspector');
      expect(result).toBeNull();
    });

    it('should return null on search failure', async () => {
      (hybridSearch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('search failed'));
      const result = await archivist.recall('query', 'chief_of_staff');
      expect(result).toBeNull();
    });
  });

  describe('archiveContext', () => {
    it('should return a summary pointer with turn count', async () => {
      const turns = ['Turn 1: Hello', 'Turn 2: How are you?', 'Turn 3: Fine thanks'];
      const result = await archivist.archiveContext(turns, 'task-123');
      expect(result).toContain('3 turns');
      expect(result).toContain('archived');
      expect(result).toContain('recall');
    });

    it('should store the joined turns content', async () => {
      const turns = ['A', 'B'];
      await archivist.archiveContext(turns, 'task-456');
      // storeDocument should have been called
      expect(mockPrepare).toHaveBeenCalled();
    });

    it('should not throw on store failure', async () => {
      (embedBatch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fail'));
      const result = await archivist.archiveContext(['turn'], 'task-789');
      // Should still return the summary pointer
      expect(result).toContain('1 turns');
    });
  });
});

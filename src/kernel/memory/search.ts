// ArmyClaw — Hybrid Search (FTS5 + Vector RRF)
// Reciprocal Rank Fusion combines keyword and semantic results

import Database from 'better-sqlite3';
import { DB_PATH, MEMORY_SEARCH_TOP_K, MEMORY_RRF_K, EMBEDDING_DIMENSIONS } from '../../config.js';
import { logger } from '../../logger.js';
import { embed, cosineSimilarity } from './embeddings.js';
import type { SearchResult } from '../../types.js';

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH, { readonly: true });
    db.pragma('journal_mode = WAL');
  }
  return db;
}

interface ChunkRow {
  rowid: number;
  id: string;
  document_id: string;
  content: string;
  embedding: Buffer | null;
}

interface DocRow {
  path: string;
}

/**
 * Hybrid search: FTS5 keyword + vector cosine similarity, fused with RRF.
 *
 * 1. FTS5 keyword search → ranked list R1
 * 2. Vector cosine similarity → ranked list R2
 * 3. RRF: score = 1/(k + rank_fts) + 1/(k + rank_vec)
 * 4. Return top-K by fused score
 */
export async function hybridSearch(
  query: string,
  topK: number = MEMORY_SEARCH_TOP_K,
  minScore: number = 0.01,
): Promise<SearchResult[]> {
  const database = getDb();

  // Stage 1: FTS5 keyword search
  const ftsResults: { chunkId: string; rank: number }[] = [];
  try {
    const ftsRows = database.prepare(`
      SELECT mc.id as chunk_id, rank
      FROM memory_fts
      JOIN memory_chunks mc ON mc.rowid = memory_fts.rowid
      WHERE memory_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(escapeFtsQuery(query), topK * 3) as { chunk_id: string; rank: number }[];

    ftsRows.forEach((row, i) => {
      ftsResults.push({ chunkId: row.chunk_id, rank: i + 1 });
    });
  } catch {
    logger.debug('FTS search failed (table may not exist), falling back to vector-only');
  }

  // Stage 2: Vector similarity search
  const vecResults: { chunkId: string; rank: number; similarity: number }[] = [];
  try {
    const queryEmbedding = await embed(query);

    // Load all chunks with embeddings (for small datasets this is fine;
    // for large datasets we'd need an ANN index)
    const chunks = database.prepare(`
      SELECT rowid, id, document_id, content, embedding
      FROM memory_chunks
      WHERE embedding IS NOT NULL
    `).all() as ChunkRow[];

    // Compute similarities
    const scored: { chunkId: string; similarity: number }[] = [];
    for (const chunk of chunks) {
      if (!chunk.embedding || chunk.embedding.length === 0) continue;
      const chunkEmbedding = new Float32Array(chunk.embedding.buffer, chunk.embedding.byteOffset, EMBEDDING_DIMENSIONS);
      const sim = cosineSimilarity(queryEmbedding, chunkEmbedding);
      if (sim > 0) {
        scored.push({ chunkId: chunk.id, similarity: sim });
      }
    }

    // Sort by similarity descending
    scored.sort((a, b) => b.similarity - a.similarity);
    scored.slice(0, topK * 3).forEach((s, i) => {
      vecResults.push({ chunkId: s.chunkId, rank: i + 1, similarity: s.similarity });
    });
  } catch (err) {
    logger.debug({ error: String(err) }, 'Vector search failed, using FTS-only results');
  }

  // Stage 3: RRF Fusion
  const k = MEMORY_RRF_K;
  const scoreMap = new Map<string, number>();

  for (const r of ftsResults) {
    scoreMap.set(r.chunkId, (scoreMap.get(r.chunkId) ?? 0) + 1 / (k + r.rank));
  }
  for (const r of vecResults) {
    scoreMap.set(r.chunkId, (scoreMap.get(r.chunkId) ?? 0) + 1 / (k + r.rank));
  }

  // Normalize scores to 0-1
  const maxScore = Math.max(...scoreMap.values(), 0.001);
  const fused: { chunkId: string; score: number }[] = [];
  for (const [chunkId, score] of scoreMap) {
    const normalized = score / maxScore;
    if (normalized >= minScore) {
      fused.push({ chunkId, score: normalized });
    }
  }

  // Sort by score descending, take top-K
  fused.sort((a, b) => b.score - a.score);
  const topResults = fused.slice(0, topK);

  // Resolve chunk details
  const results: SearchResult[] = [];
  for (const item of topResults) {
    const chunk = database.prepare(
      'SELECT id, document_id, content FROM memory_chunks WHERE id = ?'
    ).get(item.chunkId) as { id: string; document_id: string; content: string } | undefined;

    if (!chunk) continue;

    const doc = database.prepare(
      'SELECT path FROM memory_documents WHERE id = ?'
    ).get(chunk.document_id) as DocRow | undefined;

    results.push({
      document_id: chunk.document_id,
      document_path: doc?.path ?? 'unknown',
      chunk_id: chunk.id,
      content: chunk.content,
      score: item.score,
    });
  }

  logger.debug({ query: query.slice(0, 50), ftsHits: ftsResults.length, vecHits: vecResults.length, results: results.length }, 'Hybrid search completed');
  return results;
}

/**
 * Escape FTS5 query: wrap words in double quotes to prevent syntax errors.
 */
function escapeFtsQuery(query: string): string {
  // Split into words, quote each, join with OR
  const words = query.split(/\s+/).filter(Boolean);
  if (words.length === 0) return '""';
  return words.map(w => `"${w.replace(/"/g, '""')}"`).join(' OR ');
}

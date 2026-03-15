// ArmyClaw — Memory Store (SQLite-backed document + chunk storage)

import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { DB_PATH } from '../../config.js';
import { logger } from '../../logger.js';
import { chunkText } from './chunker.js';
import { embed, embedBatch } from './embeddings.js';
import type { MemoryDocument, MemoryChunk } from '../../types.js';

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
  }
  return db;
}

/**
 * Initialize memory tables. Called during HQ startup.
 */
export function initMemoryTables(): void {
  const database = getDb();
  database.exec(`
    CREATE TABLE IF NOT EXISTS memory_documents (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      path TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_docs_source ON memory_documents(source);
    CREATE INDEX IF NOT EXISTS idx_memory_docs_path ON memory_documents(path);

    CREATE TABLE IF NOT EXISTS memory_chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      embedding BLOB,
      FOREIGN KEY (document_id) REFERENCES memory_documents(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_memory_chunks_doc ON memory_chunks(document_id);
  `);

  // FTS5 virtual table for keyword search
  try {
    database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        content,
        content=memory_chunks,
        content_rowid=rowid
      );
    `);
  } catch {
    // FTS5 may already exist or not be available
    logger.debug('FTS5 table creation skipped (may already exist)');
  }

  logger.info('Memory tables initialized');
}

/**
 * Store a document: chunk it, embed chunks, and persist.
 */
export async function storeDocument(
  source: MemoryDocument['source'],
  path: string,
  content: string,
): Promise<string> {
  const database = getDb();
  const docId = `mem-${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();

  // Chunk the content
  const chunks = chunkText(content);
  if (chunks.length === 0) {
    logger.debug({ path }, 'Empty content, skipping memory storage');
    return docId;
  }

  // Embed all chunks (batch for efficiency)
  let embeddings: Float32Array[];
  try {
    embeddings = await embedBatch(chunks);
  } catch (err) {
    logger.warn({ error: String(err) }, 'Embedding failed, storing without vectors');
    embeddings = chunks.map(() => new Float32Array(0));
  }

  // Persist in a transaction
  const insertDoc = database.prepare(`
    INSERT INTO memory_documents (id, source, path, content, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertChunk = database.prepare(`
    INSERT INTO memory_chunks (id, document_id, chunk_index, content, embedding)
    VALUES (?, ?, ?, ?, ?)
  `);

  const insertFts = database.prepare(`
    INSERT INTO memory_fts (rowid, content) VALUES (?, ?)
  `);

  const txn = database.transaction(() => {
    insertDoc.run(docId, source, path, content, now, now);

    for (let i = 0; i < chunks.length; i++) {
      const chunkId = `chk-${randomUUID().slice(0, 8)}`;
      const embeddingBuf = embeddings[i].byteLength > 0
        ? Buffer.from(embeddings[i].buffer)
        : null;

      const result = insertChunk.run(chunkId, docId, i, chunks[i], embeddingBuf);

      // Index in FTS
      try {
        insertFts.run(result.lastInsertRowid, chunks[i]);
      } catch {
        // FTS insert may fail if table doesn't exist
      }
    }
  });

  txn();
  logger.info({ docId, path, chunks: chunks.length }, 'Document stored in memory');
  return docId;
}

/**
 * Get a document by ID.
 */
export function getDocument(id: string): MemoryDocument | undefined {
  return getDb().prepare('SELECT * FROM memory_documents WHERE id = ?').get(id) as MemoryDocument | undefined;
}

/**
 * Get all chunks for a document.
 */
export function getChunks(documentId: string): MemoryChunk[] {
  return getDb().prepare(
    'SELECT * FROM memory_chunks WHERE document_id = ? ORDER BY chunk_index'
  ).all(documentId) as MemoryChunk[];
}

/**
 * Get recent documents by source type.
 */
export function getRecentDocuments(source?: string, limit: number = 20): MemoryDocument[] {
  if (source) {
    return getDb().prepare(
      'SELECT * FROM memory_documents WHERE source = ? ORDER BY created_at DESC LIMIT ?'
    ).all(source, limit) as MemoryDocument[];
  }
  return getDb().prepare(
    'SELECT * FROM memory_documents ORDER BY created_at DESC LIMIT ?'
  ).all(limit) as MemoryDocument[];
}

/**
 * Delete a document and its chunks (CASCADE).
 */
export function deleteDocument(id: string): void {
  const database = getDb();
  database.prepare('DELETE FROM memory_chunks WHERE document_id = ?').run(id);
  database.prepare('DELETE FROM memory_documents WHERE id = ?').run(id);
}

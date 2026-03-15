// ArmyClaw — Embedding Provider (OpenAI text-embedding-3-small)

import { OPENAI_API_KEY, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from '../../config.js';
import { logger } from '../../logger.js';

/**
 * Generate embedding vector for a text string.
 * Returns Float32Array of EMBEDDING_DIMENSIONS length.
 */
export async function embed(text: string): Promise<Float32Array> {
  if (!OPENAI_API_KEY) {
    logger.warn('OPENAI_API_KEY not set, returning zero vector');
    return new Float32Array(EMBEDDING_DIMENSIONS);
  }

  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text.slice(0, 32_000), // API limit
      dimensions: EMBEDDING_DIMENSIONS,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI Embeddings API error ${res.status}: ${err}`);
  }

  const data = (await res.json()) as {
    data: { embedding: number[] }[];
  };

  return new Float32Array(data.data[0].embedding);
}

/**
 * Batch embed multiple texts.
 */
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  if (!OPENAI_API_KEY || texts.length === 0) {
    return texts.map(() => new Float32Array(EMBEDDING_DIMENSIONS));
  }

  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: texts.map(t => t.slice(0, 32_000)),
      dimensions: EMBEDDING_DIMENSIONS,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI Embeddings API error ${res.status}: ${err}`);
  }

  const data = (await res.json()) as {
    data: { embedding: number[]; index: number }[];
  };

  // Sort by index to maintain order
  const sorted = data.data.sort((a, b) => a.index - b.index);
  return sorted.map(d => new Float32Array(d.embedding));
}

/**
 * Cosine similarity between two vectors.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

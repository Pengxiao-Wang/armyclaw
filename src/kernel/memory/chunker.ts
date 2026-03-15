// ArmyClaw — Text Chunker
// Splits documents into chunks for embedding and search

import { MEMORY_CHUNK_SIZE } from '../../config.js';

/**
 * Estimate token count (rough: ~1.3 tokens per word)
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.split(/\s+/).filter(Boolean).length * 1.3);
}

/**
 * Split text into chunks of approximately MEMORY_CHUNK_SIZE tokens.
 * Respects paragraph boundaries when possible.
 */
export function chunkText(text: string, maxTokens: number = MEMORY_CHUNK_SIZE): string[] {
  if (!text.trim()) return [];

  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    const combined = current ? `${current}\n\n${para}` : para;

    if (estimateTokens(combined) > maxTokens && current) {
      // Current chunk is full, push it
      chunks.push(current.trim());
      current = para;
    } else {
      current = combined;
    }
  }

  // Don't forget the last chunk
  if (current.trim()) {
    chunks.push(current.trim());
  }

  // Handle single paragraphs that are too large
  const result: string[] = [];
  for (const chunk of chunks) {
    if (estimateTokens(chunk) > maxTokens * 2) {
      // Force-split by sentences
      const sentences = chunk.split(/(?<=[.!?])\s+/);
      let sub = '';
      for (const sentence of sentences) {
        const combined = sub ? `${sub} ${sentence}` : sentence;
        if (estimateTokens(combined) > maxTokens && sub) {
          result.push(sub.trim());
          sub = sentence;
        } else {
          sub = combined;
        }
      }
      if (sub.trim()) result.push(sub.trim());
    } else {
      result.push(chunk);
    }
  }

  return result;
}

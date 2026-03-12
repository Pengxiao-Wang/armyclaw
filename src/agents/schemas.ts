import { z, type ZodSchema } from 'zod';

// ─── Agent Output Schemas ───────────────────────────────────────

export const AdjutantOutputSchema = z.object({
  direct_reply: z.boolean(),
  tasks: z.array(z.object({
    id: z.string(),
    description: z.string(),
    priority: z.enum(['low', 'medium', 'high', 'urgent']),
  })),
  reply: z.string(),
});

export const ChiefOfStaffOutputSchema = z.object({
  type: z.enum(['answer', 'research', 'execution', 'campaign']),
  answer: z.string().optional(),
  plan: z.object({
    goal: z.string(),
    steps: z.array(z.object({
      id: z.string(),
      description: z.string(),
      depends_on: z.array(z.string()).optional(),
    })),
    estimated_tokens: z.number(),
    complexity: z.enum(['simple', 'moderate', 'complex']),
  }).optional(),
  campaign: z.object({
    name: z.string(),
    phases: z.array(z.object({
      name: z.string(),
      goal: z.string(),
      depends_on: z.string().optional(),
    })),
  }).optional(),
});

export const InspectorOutputSchema = z.object({
  verdict: z.enum(['approve', 'reject']),
  level: z.enum(['tactical', 'strategic', 'critical']).optional(),
  rubric: z.array(z.string()),
  findings: z.array(z.string()),
});

export const OperationsOutputSchema = z.object({
  assignments: z.array(z.object({
    engineer_id: z.string(),
    subtask_id: z.string(),
    context: z.string(),
    complexity: z.enum(['simple', 'moderate', 'complex']),
  })),
});

export const EngineerOutputSchema = z.object({
  subtask_id: z.string(),
  status: z.enum(['completed', 'failed', 'blocked']),
  result: z.string(),
  files_changed: z.array(z.string()).optional(),
});

// ─── Parser ─────────────────────────────────────────────────────

/**
 * Parse and validate agent output against a Zod schema.
 *
 * 1. Tries JSON.parse on the raw string
 * 2. If that fails, tries to extract JSON from markdown code blocks
 * 3. Validates with the schema
 * 4. Throws a descriptive error on failure
 */
export function parseAgentOutput<T>(schema: ZodSchema<T>, raw: string): T {
  let parsed: unknown;

  // Step 1: Try direct JSON parse
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Step 2: Try to extract JSON from markdown code blocks
    const codeBlockMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (codeBlockMatch) {
      try {
        parsed = JSON.parse(codeBlockMatch[1].trim());
      } catch (innerErr) {
        throw new Error(
          `Failed to parse JSON from markdown code block: ${innerErr instanceof Error ? innerErr.message : String(innerErr)}`,
        );
      }
    } else {
      throw new Error(
        `Failed to parse agent output as JSON. Raw output starts with: "${raw.slice(0, 100)}..."`,
      );
    }
  }

  // Step 3: Validate with schema
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Agent output validation failed:\n${issues}`);
  }

  return result.data;
}

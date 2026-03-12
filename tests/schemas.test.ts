import { describe, it, expect } from 'vitest';
import {
  AdjutantOutputSchema,
  ChiefOfStaffOutputSchema,
  InspectorOutputSchema,
  OperationsOutputSchema,
  EngineerOutputSchema,
  parseAgentOutput,
} from '../src/agents/schemas.js';

describe('AdjutantOutputSchema', () => {
  it('should validate correct adjutant output', () => {
    const valid = {
      direct_reply: false,
      tasks: [
        { id: 'task-1', description: 'Do something', priority: 'high' },
      ],
      reply: 'I have created the task.',
    };
    expect(AdjutantOutputSchema.parse(valid)).toEqual(valid);
  });

  it('should reject invalid priority', () => {
    const invalid = {
      tasks: [{ id: 't1', description: 'X', priority: 'invalid' }],
      reply: 'ok',
    };
    expect(() => AdjutantOutputSchema.parse(invalid)).toThrow();
  });

  it('should reject missing reply', () => {
    const invalid = {
      tasks: [{ id: 't1', description: 'X', priority: 'low' }],
    };
    expect(() => AdjutantOutputSchema.parse(invalid)).toThrow();
  });
});

describe('ChiefOfStaffOutputSchema', () => {
  it('should validate answer type', () => {
    const valid = { type: 'answer', answer: 'The answer is 42.' };
    expect(ChiefOfStaffOutputSchema.parse(valid)).toEqual(valid);
  });

  it('should validate execution type with plan', () => {
    const valid = {
      type: 'execution',
      plan: {
        goal: 'Build feature',
        steps: [
          { id: 's1', description: 'Design API', depends_on: [] },
          { id: 's2', description: 'Implement', depends_on: ['s1'] },
        ],
        estimated_tokens: 10000,
        complexity: 'moderate',
      },
    };
    expect(ChiefOfStaffOutputSchema.parse(valid)).toEqual(valid);
  });

  it('should validate campaign type', () => {
    const valid = {
      type: 'campaign',
      campaign: {
        name: 'Refactor',
        phases: [
          { name: 'Phase 1', goal: 'Analysis' },
          { name: 'Phase 2', goal: 'Implementation', depends_on: 'Phase 1' },
        ],
      },
    };
    expect(ChiefOfStaffOutputSchema.parse(valid)).toEqual(valid);
  });

  it('should reject invalid type', () => {
    expect(() => ChiefOfStaffOutputSchema.parse({ type: 'invalid' })).toThrow();
  });

  it('should reject invalid complexity', () => {
    const invalid = {
      type: 'execution',
      plan: {
        goal: 'x', steps: [], estimated_tokens: 100, complexity: 'extreme',
      },
    };
    expect(() => ChiefOfStaffOutputSchema.parse(invalid)).toThrow();
  });
});

describe('InspectorOutputSchema', () => {
  it('should validate approve verdict', () => {
    const valid = {
      verdict: 'approve',
      rubric: ['correctness', 'completeness'],
      findings: ['All tests pass'],
    };
    expect(InspectorOutputSchema.parse(valid)).toEqual(valid);
  });

  it('should validate reject verdict with level', () => {
    const valid = {
      verdict: 'reject',
      level: 'tactical',
      rubric: ['correctness'],
      findings: ['Missing edge case handling'],
    };
    expect(InspectorOutputSchema.parse(valid)).toEqual(valid);
  });

  it('should reject invalid verdict', () => {
    expect(() => InspectorOutputSchema.parse({
      verdict: 'maybe', rubric: [], findings: [],
    })).toThrow();
  });

  it('should reject invalid level', () => {
    expect(() => InspectorOutputSchema.parse({
      verdict: 'reject', level: 'nuclear', rubric: [], findings: [],
    })).toThrow();
  });
});

describe('OperationsOutputSchema', () => {
  it('should validate assignments', () => {
    const valid = {
      assignments: [
        { engineer_id: 'eng-1', subtask_id: 's1', context: 'Build API', complexity: 'simple' },
        { engineer_id: 'eng-2', subtask_id: 's2', context: 'Build UI', complexity: 'complex' },
      ],
    };
    expect(OperationsOutputSchema.parse(valid)).toEqual(valid);
  });

  it('should reject missing fields', () => {
    expect(() => OperationsOutputSchema.parse({
      assignments: [{ engineer_id: 'eng-1' }],
    })).toThrow();
  });
});

describe('EngineerOutputSchema', () => {
  it('should validate completed output', () => {
    const valid = {
      subtask_id: 's1',
      status: 'completed',
      result: 'Implemented the feature',
      files_changed: ['src/foo.ts', 'src/bar.ts'],
    };
    expect(EngineerOutputSchema.parse(valid)).toEqual(valid);
  });

  it('should validate failed output without files', () => {
    const valid = {
      subtask_id: 's1',
      status: 'failed',
      result: 'Dependency not available',
    };
    expect(EngineerOutputSchema.parse(valid)).toEqual(valid);
  });

  it('should validate blocked output', () => {
    const valid = {
      subtask_id: 's1',
      status: 'blocked',
      result: 'Waiting for API credentials',
    };
    expect(EngineerOutputSchema.parse(valid)).toEqual(valid);
  });

  it('should reject invalid status', () => {
    expect(() => EngineerOutputSchema.parse({
      subtask_id: 's1', status: 'pending', result: 'x',
    })).toThrow();
  });
});

describe('parseAgentOutput', () => {
  it('should parse valid JSON string', () => {
    const raw = JSON.stringify({
      direct_reply: false,
      tasks: [{ id: 't1', description: 'Do it', priority: 'medium' }],
      reply: 'Done',
    });
    const result = parseAgentOutput(AdjutantOutputSchema, raw);
    expect(result.tasks).toHaveLength(1);
    expect(result.reply).toBe('Done');
  });

  it('should parse JSON from markdown code block', () => {
    const raw = `Here is my output:

\`\`\`json
{
  "direct_reply": false,
  "tasks": [{"id": "t1", "description": "Task", "priority": "low"}],
  "reply": "Created"
}
\`\`\`

That's all.`;

    const result = parseAgentOutput(AdjutantOutputSchema, raw);
    expect(result.tasks[0].priority).toBe('low');
  });

  it('should parse JSON from code block without language tag', () => {
    const raw = `\`\`\`
{"verdict": "approve", "rubric": ["r1"], "findings": ["f1"]}
\`\`\``;

    const result = parseAgentOutput(InspectorOutputSchema, raw);
    expect(result.verdict).toBe('approve');
  });

  it('should throw on completely invalid input', () => {
    expect(() => parseAgentOutput(AdjutantOutputSchema, 'not json at all')).toThrow(
      'Failed to parse agent output as JSON',
    );
  });

  it('should throw on valid JSON that fails schema validation', () => {
    const raw = JSON.stringify({ wrong: 'shape' });
    expect(() => parseAgentOutput(AdjutantOutputSchema, raw)).toThrow(
      'Agent output validation failed',
    );
  });

  it('should throw on invalid JSON inside code block', () => {
    const raw = '```json\n{invalid json}\n```';
    expect(() => parseAgentOutput(AdjutantOutputSchema, raw)).toThrow(
      'Failed to parse JSON from markdown code block',
    );
  });
});

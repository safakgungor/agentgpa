import { describe, expect, it } from 'vitest';
import { GRADING_VERSION, PAYLOAD_SCHEMA_VERSION } from '../src/index.ts';

describe('@agentgpa/core', () => {
  it('exports the payload schema and grading versions', () => {
    expect(PAYLOAD_SCHEMA_VERSION).toBe(1);
    expect(GRADING_VERSION).toBe('v0');
  });
});

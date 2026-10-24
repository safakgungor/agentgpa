import { describe, expect, it } from 'vitest';
import { ReportAcceptedSchema } from '../src/index.ts';

// The upload's answer, as the CLI reads it. Unknown fields are dropped, so a server can add one
// without breaking a CLI that came before it: that is how 0.1.2 reads an answer with `watched`.

describe("the upload's answer", () => {
  const reportUrl = 'https://agentgpa.dev/start';

  it('says when the page the code came from follows the run', () => {
    expect(ReportAcceptedSchema.parse({ reportUrl, watched: true })).toEqual({
      reportUrl,
      watched: true,
    });
    expect(ReportAcceptedSchema.parse({ reportUrl, watched: false }).watched).toBe(false);
  });

  it('reads an answer without it, from a server that came before', () => {
    const answer = ReportAcceptedSchema.parse({ reportUrl });
    expect(answer).toEqual({ reportUrl });
    expect(answer.watched).toBeUndefined();
  });

  it('drops a field it does not know, and refuses a broken one', () => {
    expect(ReportAcceptedSchema.parse({ reportUrl, later: 'something new' })).toEqual({
      reportUrl,
    });
    expect(ReportAcceptedSchema.safeParse({ reportUrl, watched: 'yes' }).success).toBe(false);
    expect(ReportAcceptedSchema.safeParse({ watched: true }).success).toBe(false);
  });
});

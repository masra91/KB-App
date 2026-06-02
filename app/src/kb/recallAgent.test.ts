// SPEC-0026 ASK-4/ASK-12 — the recall skill + the Copilot-SDK client adapter.
// The adapter only *constructs* lazily (no CLI spawn until createSession), so we can assert its
// shape here; the full session behavior is exercised via the fake client in recall.test.ts.
import { describe, it, expect } from 'vitest';
import { RECALL_SKILL, RECALL_SKILL_VERSION, makeSdkRecallClient } from './recallAgent';

describe('recall skill (ASK-4)', () => {
  it('teaches KB structure, grounding, and the submitAnswer finish protocol', () => {
    expect(RECALL_SKILL).toContain('KB-App Recall agent');
    expect(RECALL_SKILL).toContain('KB STRUCTURE');
    expect(RECALL_SKILL).toContain('GROUNDING');
    expect(RECALL_SKILL).toContain('submitAnswer');
    expect(RECALL_SKILL).toMatch(/tags/); // metadata-aware (SPEC-0025 META)
    expect(RECALL_SKILL_VERSION).toBe('recall/v2-sdk');
  });
});

describe('makeSdkRecallClient (ASK-12 substrate)', () => {
  it('returns a RecallClient seam without spawning the CLI (lazy)', () => {
    const client = makeSdkRecallClient({ model: 'gpt-5' });
    expect(typeof client.createSession).toBe('function');
    expect(typeof client.disconnect).toBe('function');
    // No CLI is started until createSession is called — constructing the client is side-effect free.
  });
});

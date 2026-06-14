// WS-C (SPEC-0025 META-2) — topic-tag coverage metric. Guards the dead-rail regression (every entity
// `type/X`, ~0 `topic/`) from silently returning.
import { describe, it, expect } from 'vitest';
import { isTopicTag, topicTagCoverage } from './topicTagEval';

describe('isTopicTag (WS-C)', () => {
  it('recognizes the topic/ namespace', () => {
    expect(isTopicTag('topic/machine-learning')).toBe(true);
    expect(isTopicTag('topic/travel')).toBe(true);
  });
  it('rejects curated type/ and bare tags', () => {
    expect(isTopicTag('type/person')).toBe(false);
    expect(isTopicTag('person')).toBe(false);
    expect(isTopicTag('')).toBe(false);
  });
  it('normalizes before classifying (a model-coined "Topic/Machine Learning" still counts)', () => {
    expect(isTopicTag('Topic/Machine Learning')).toBe(true);
    expect(isTopicTag('  topic/Finance  ')).toBe(true);
  });
});

describe('topicTagCoverage (WS-C)', () => {
  it('measures the fraction of entities carrying ≥1 topic/ tag', () => {
    const cov = topicTagCoverage([
      { tags: ['type/person', 'topic/ml'] }, // counts
      { tags: ['type/person'] }, // type only — the dead-rail state
      { tags: ['type/org', 'topic/finance', 'topic/startups'] }, // counts (multiple)
      { tags: [] }, // no tags
    ]);
    expect(cov).toEqual({ total: 4, withTopic: 2, coverage: 0.5 });
  });

  it('is 1.0 when every entity has a topic tag, 0 when none do (the regression floor)', () => {
    expect(topicTagCoverage([{ tags: ['topic/a'] }, { tags: ['x', 'topic/b'] }]).coverage).toBe(1);
    expect(topicTagCoverage([{ tags: ['type/person'] }, { tags: ['type/org'] }]).coverage).toBe(0);
  });

  it('guards the empty denominator → coverage 0, never NaN', () => {
    expect(topicTagCoverage([])).toEqual({ total: 0, withTopic: 0, coverage: 0 });
  });

  it('tolerates a missing tags field (legacy/partial node)', () => {
    expect(topicTagCoverage([{}, { tags: ['topic/x'] }]).withTopic).toBe(1);
  });
});

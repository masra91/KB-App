// WS-C (SPEC-0025 META-2) — topic-tag coverage metric. The `topic/` rail is fully built (Connect emits
// `tags[]`, normalizeTag normalizes, frontmatter renders them), but the dogfood vault had every entity
// carrying only its `type/<kind>` tag and ~ZERO `topic/` tags — the Connect prompt never coined them.
// This metric measures whether topic tags actually LAND, so a future prompt regression back to zero
// turns red in the eval instead of silently shipping. Pure → CI-testable; available to DEV-1's eval lane.
import { tagNamespace, normalizeTag } from './metaVocab';

/** Whether a (raw or normalized) tag is in the emergent `topic/` namespace. Normalizes first so a
 *  model-coined `Topic/Machine Learning` counts the same as `topic/machine-learning`. */
export function isTopicTag(tag: string): boolean {
  return tagNamespace(normalizeTag(tag)) === 'topic';
}

export interface TopicTagCoverage {
  /** Entities considered (one node each). */
  total: number;
  /** Entities carrying ≥1 `topic/` tag. */
  withTopic: number;
  /** `withTopic / total` in [0,1]; 0 when `total` is 0 (empty-denominator guard — never NaN). */
  coverage: number;
}

/**
 * Fraction of entities carrying at least one emergent `topic/` tag (WS-C). `entities` is each node's
 * tag list as written to frontmatter (curated `type/…` + emergent `topic/…`). The dead-rail regression
 * shows up as `coverage` near 0; the fix should lift it well off the floor. Empty input → coverage 0.
 */
export function topicTagCoverage(entities: readonly { tags?: readonly string[] }[]): TopicTagCoverage {
  const total = entities.length;
  const withTopic = entities.filter((e) => (e.tags ?? []).some(isTopicTag)).length;
  return { total, withTopic, coverage: total === 0 ? 0 : withTopic / total };
}

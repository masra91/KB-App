// Golden-set fixtures for the DECOMP-17 granularity eval (KB-QD's pass-bar). Each is a short
// source whose genuine entities (mustBeNodes) and descriptor/role/relationship traps
// (mustNotBeNodes) are known, plus a loose maxNodes over-extraction bound. Directional, NOT
// exact-count (LLM output is non-deterministic): the set assertions are hard, the bound is loose.
//
// These are reviewed by KB-QD (fixtures + thresholds). Add cases that exercise the precision guard
// — the felt-quality regression is descriptors/roles/relationships becoming standalone nodes.
import type { GranularityFixture } from '../src/kb/enrichEval';

export const GRANULARITY_FIXTURES: GranularityFixture[] = [
  {
    // THE HEADLINE (dogfood): 2 sentences that pre-DECOMP-17 yielded ~6 nodes, with
    // `concept/first-computer-programmer` promoted to a standalone entity.
    name: 'ada-lovelace-bio',
    sourceText:
      'Ada Lovelace worked with Charles Babbage on the Analytical Engine. She is regarded as the first computer programmer.',
    mustBeNodes: ['Ada Lovelace', 'Charles Babbage'],
    mustNotBeNodes: ['first computer programmer', 'computer programmer', 'programmer'],
    maxNodes: 3, // Ada, Babbage, (Analytical Engine is a defensible node) — not the role/descriptor
  },
  {
    // Role/title traps: "CEO", "co-founder" are descriptors OF entities, not entities.
    name: 'apple-succession',
    sourceText: 'Tim Cook, the CEO of Apple, succeeded Steve Jobs, the company’s co-founder.',
    mustBeNodes: ['Tim Cook', 'Apple', 'Steve Jobs'],
    mustNotBeNodes: ['CEO', 'co-founder', 'the CEO of Apple'],
    maxNodes: 4,
  },
  {
    // Relationship/attribute traps: "the Q3 budget review" / "the meeting" are events/attributes
    // the source asserts, not durable named entities the decomposer should mint as nodes.
    name: 'austin-meeting-note',
    sourceText: 'Steve and Maria met at the Austin office on Tuesday to review the Q3 budget.',
    mustBeNodes: ['Steve', 'Maria', 'Austin office'],
    mustNotBeNodes: ['the meeting', 'Q3 budget review', 'review', 'Tuesday'],
    maxNodes: 5, // Steve, Maria, Austin office, (Q3 budget as a concept is borderline-acceptable)
  },
];

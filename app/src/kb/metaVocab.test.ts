// Curated-vocabulary + tag-normalization tests (SPEC-0025 META-2/3/8). Pure functions, no FS/git.
import { describe, it, expect } from 'vitest';
import { normalizeTag, typeTag, tagNamespace, isCuratedTag, CURATED_TAG_NAMESPACES } from './metaVocab';

describe('normalizeTag (META-3: Obsidian tag rules)', () => {
  it('lowercases, turns spaces/underscores into hyphens, preserves nesting', () => {
    expect(normalizeTag('Topic/Machine Learning')).toBe('topic/machine-learning');
    expect(normalizeTag('type/Person')).toBe('type/person');
    expect(normalizeTag('big_data')).toBe('big-data');
  });

  it('drops characters Obsidian tags disallow (keeps letters, digits, /, -)', () => {
    expect(normalizeTag('topic/c++!')).toBe('topic/c');
    expect(normalizeTag('#topic/ml')).toBe('topic/ml'); // a leading # is not a valid tag char here
    expect(normalizeTag('topic/AI & ML')).toBe('topic/ai-ml');
  });

  it('collapses repeats and trims stray separators', () => {
    expect(normalizeTag('//topic//ml//')).toBe('topic/ml');
    expect(normalizeTag('topic - / - ml')).toBe('topic/ml');
    expect(normalizeTag('--x--')).toBe('x');
  });

  it('returns empty string for a tag that normalizes to nothing (caller filters)', () => {
    expect(normalizeTag('!!!')).toBe('');
    expect(normalizeTag('   ')).toBe('');
    expect(normalizeTag('/')).toBe('');
  });

  it('keeps digits and Unicode letters', () => {
    expect(normalizeTag('topic/Q3-2026')).toBe('topic/q3-2026');
    expect(normalizeTag('Topic/Café')).toBe('topic/café');
  });
});

describe('typeTag + curated classification (META-2)', () => {
  it('builds a normalized type/<kind> tag', () => {
    expect(typeTag('person')).toBe('type/person');
    expect(typeTag('Budget Line Item')).toBe('type/budget-line-item');
    expect(typeTag('')).toBe(''); // empty kind → no tag
  });

  it('classifies curated vs emergent by namespace', () => {
    expect(tagNamespace('topic/ml')).toBe('topic');
    expect(tagNamespace('flat')).toBe('flat');
    expect(isCuratedTag('type/person')).toBe(true);
    expect(isCuratedTag('topic/ml')).toBe(true);
    expect(isCuratedTag('mood/curious')).toBe(false); // emergent namespace
    expect(CURATED_TAG_NAMESPACES).toContain('type');
  });
});

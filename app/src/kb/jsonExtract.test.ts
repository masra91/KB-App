// SPEC-0049 HEAL-2 — lenient JSON extraction. These pin the exact failure modes that tossed items:
// fences, leading/trailing prose, a `}` inside a string value, and truncation.
import { describe, it, expect } from 'vitest';
import { extractBalancedJson } from './jsonExtract';

describe('extractBalancedJson (HEAL-2)', () => {
  it('returns a bare object unchanged', () => {
    expect(extractBalancedJson('{"a":1}')).toBe('{"a":1}');
  });

  it('tolerates leading and trailing prose (the greedy-regex failure mode)', () => {
    expect(extractBalancedJson('Here is the result:\n{"a":1}\nLet me know if you need more.')).toBe('{"a":1}');
  });

  it('strips a ```json code fence', () => {
    expect(extractBalancedJson('```json\n{"a":1,"b":[2,3]}\n```')).toBe('{"a":1,"b":[2,3]}');
  });

  it('strips a bare ``` fence', () => {
    expect(extractBalancedJson('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('does NOT miscount a closing brace inside a string value', () => {
    // The old `/\{[\s\S]*\}/` was greedy-to-last-`}` so this still happened to work, but a balanced
    // scan that ignored strings would stop early at the `}` in "a } b". Assert it extracts whole.
    expect(extractBalancedJson('{"note":"contains a } brace","ok":true}')).toBe('{"note":"contains a } brace","ok":true}');
  });

  it('handles an escaped quote inside a string', () => {
    expect(extractBalancedJson('{"q":"she said \\"hi\\" }"}')).toBe('{"q":"she said \\"hi\\" }"}');
  });

  it('extracts the FIRST balanced object when trailing prose contains another brace', () => {
    // Greedy-to-last-`}` would grab through the trailing `{...}` and break JSON.parse; balanced stops
    // at the first object's close.
    expect(extractBalancedJson('{"a":1} and then {"b":2}')).toBe('{"a":1}');
  });

  it('keeps nested objects intact', () => {
    expect(extractBalancedJson('prefix {"a":{"b":{"c":1}}} suffix')).toBe('{"a":{"b":{"c":1}}}');
  });

  it('returns null when there is no object at all', () => {
    expect(extractBalancedJson('no json here')).toBeNull();
    expect(extractBalancedJson('')).toBeNull();
  });

  it('returns null on a truncated object (opening brace, no balanced close)', () => {
    // The ~11KB-truncation failure mode — caller throws "no JSON object", which self-repair feeds back.
    expect(extractBalancedJson('{"a":1,"b":[2,3')).toBeNull();
  });
});

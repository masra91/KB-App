// Activity glyph-tile typing (Vellum UX v2, DL-2 contract). Pure mapping — asserts the COLOR
// DISCIPLINE (the gateable substance): kind→hue class, oxide-on-failure overriding the kind, no ember,
// and ENG-15/16 null-safety. The glyph chars themselves are placeholders pending DL-2's table.
import { describe, it, expect } from 'vitest';
import { glyphFor, isFailedEvent } from './activityGlyph';

describe('glyphFor — kind/hue typing (#184 hue-on-tile)', () => {
  it('maps actors to their categorical kind + `.gl--<kind>` hue class', () => {
    expect(glyphFor('claims').cls).toBe('gl--claim');
    expect(glyphFor('connect').cls).toBe('gl--connect');
    expect(glyphFor('enrich').cls).toBe('gl--enrich');
    expect(glyphFor('compose').cls).toBe('gl--compose');
    expect(glyphFor('archivist').cls).toBe('gl--capture');
    expect(glyphFor('output').cls).toBe('gl--promote');
  });

  it('a FAILED event-type wins → oxide tile, overriding the actor kind (honest failure)', () => {
    expect(glyphFor('claims', 'claims:setaside').cls).toBe('gl--failed');
    expect(glyphFor('connect', 'resolve-failed').cls).toBe('gl--failed');
    expect(glyphFor('watch', 'watch-refused').cls).toBe('gl--failed');
    // a non-failed event keeps the actor's kind
    expect(glyphFor('claims', 'claimed').cls).toBe('gl--claim');
  });

  it('never yields an ember class (Activity logs the past — nothing needs a decision)', () => {
    for (const a of ['claims', 'connect', 'enrich', 'compose', 'archivist', 'output', 'recall', 'panel', 'replay', 'job', 'researcher', 'maintenance', 'intake', 'watch', 'decompose', undefined]) {
      expect(glyphFor(a, undefined).cls).not.toContain('ember');
      expect(glyphFor(a, 'x-failed').cls).not.toContain('ember');
    }
  });

  it('ENG-15/16: an unknown/missing actor degrades to the neutral `event` tile, never throws', () => {
    expect(glyphFor(undefined).cls).toBe('gl--event');
    expect(glyphFor('totally-unknown-actor').cls).toBe('gl--event');
    expect(typeof glyphFor(undefined).glyph).toBe('string');
  });
});

describe('isFailedEvent', () => {
  it('detects the failure event-type families, tolerant of separators', () => {
    expect(isFailedEvent('claims:setaside')).toBe(true);
    expect(isFailedEvent('decompose:failed')).toBe(true);
    expect(isFailedEvent('research-failed')).toBe(true);
    expect(isFailedEvent('watch-refused')).toBe(true);
    expect(isFailedEvent('blocked')).toBe(true);
    expect(isFailedEvent('claimed')).toBe(false);
    expect(isFailedEvent('resolved')).toBe(false);
    expect(isFailedEvent(undefined)).toBe(false);
  });
});

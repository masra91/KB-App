import { describe, it, expect } from 'vitest';
import { reviewResumeStage } from './reviewResume';

describe('reviewResumeStage — answered-review resume routing (REVIEW-6; #46)', () => {
  it('routes a claims-review answer to the Claims stage', () => {
    expect(reviewResumeStage('claims')).toBe('claims');
  });

  it('routes an ambiguous-link review (CONNECT-15) answer to the Connect stage — the #46 fix', () => {
    // Was the bug: `connect` returned nothing, so an answered link review only rendered on the
    // ≤30s sweep, not immediately.
    expect(reviewResumeStage('connect')).toBe('connect');
  });

  it('routes nothing for an unknown or absent stage', () => {
    expect(reviewResumeStage(undefined)).toBeNull();
    expect(reviewResumeStage('reflect')).toBeNull();
    expect(reviewResumeStage('')).toBeNull();
  });
});

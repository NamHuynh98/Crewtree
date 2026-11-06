// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { toUsage } from '../src/claude/UsageService.js';

describe('toUsage', () => {
  it('keeps the plan windows that have a percentage, in sidebar order', () => {
    const usage = toUsage(
      {
        subscription_type: 'team',
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 4, resets_at: '2026-11-06T16:09:59Z' },
          seven_day: { utilization: 28, resets_at: '2026-11-10T15:59:59Z' },
          seven_day_opus: null,
          seven_day_sonnet: { utilization: null, resets_at: null },
          model_scoped: [{ display_name: 'Fable', utilization: 130, resets_at: null }],
        },
      },
      1
    );
    expect(usage).toEqual({
      available: true,
      subscriptionType: 'team',
      fetchedAt: 1,
      windows: [
        { key: 'session', label: undefined, percent: 4, resetsAt: '2026-11-06T16:09:59Z' },
        { key: 'weekly', label: undefined, percent: 28, resetsAt: '2026-11-10T15:59:59Z' },
        { key: 'weekly_model', label: 'Fable', percent: 100, resetsAt: null },
      ],
    });
  });

  it('is unavailable for logins without plan limits (API key, Bedrock, Vertex)', () => {
    expect(toUsage({ subscription_type: null, rate_limits_available: false, rate_limits: null }, 1)).toEqual({
      available: false,
      subscriptionType: null,
      windows: [],
      fetchedAt: 1,
    });
    expect(toUsage(undefined, 1).available).toBe(false);
  });
});

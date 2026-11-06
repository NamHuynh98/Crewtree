// SPDX-License-Identifier: Apache-2.0
/**
 * Plan usage of the logged-in Claude account: the same windows `/usage` shows in Claude Code (5-hour session,
 * weekly, per-model weekly), as a percentage with the reset time. Read through the Agent SDK without sending a
 * prompt (no tokens). The SDK marks this API experimental, so every field is optional here and any failure
 * just hides the meter.
 */
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export interface UsageWindow {
  /** `session` (5 hours), `weekly`, `weekly_opus`, `weekly_sonnet`, or `weekly_model` with a `label` */
  key: string;
  label?: string;
  /** 0-100 */
  percent: number;
  resetsAt: string | null;
}

export interface AccountUsage {
  /** False for API key, Bedrock, Vertex and other logins without plan limits, or when the SDK cannot tell */
  available: boolean;
  subscriptionType: string | null;
  windows: UsageWindow[];
  fetchedAt: number;
}

const TTL_MS = 2 * 60_000;
const TIMEOUT_MS = 20_000;

const idlePrompt: AsyncIterable<SDKUserMessage> = {
  [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<SDKUserMessage>>(() => {}) }),
};

type RawWindow = { utilization?: number | null; resets_at?: string | null } | null | undefined;

/** Turns the SDK's `/usage` answer into the windows the sidebar shows; unknown or empty windows are skipped. */
export function toUsage(raw: any, now = Date.now()): AccountUsage {
  const limits = raw?.rate_limits;
  if (!raw?.rate_limits_available || !limits) {
    return { available: false, subscriptionType: raw?.subscription_type ?? null, windows: [], fetchedAt: now };
  }
  const windows: UsageWindow[] = [];
  const add = (key: string, w: RawWindow, label?: string) => {
    if (typeof w?.utilization !== 'number') return;
    windows.push({ key, label, percent: Math.max(0, Math.min(100, w.utilization)), resetsAt: w.resets_at ?? null });
  };
  add('session', limits.five_hour);
  add('weekly', limits.seven_day);
  add('weekly_opus', limits.seven_day_opus);
  add('weekly_sonnet', limits.seven_day_sonnet);
  for (const m of Array.isArray(limits.model_scoped) ? limits.model_scoped : []) {
    if (m?.display_name) add('weekly_model', m, String(m.display_name));
  }
  return { available: windows.length > 0, subscriptionType: raw.subscription_type ?? null, windows, fetchedAt: now };
}

export class UsageService {
  private static instance: UsageService;
  private cache?: AccountUsage;
  private inflight?: Promise<AccountUsage>;

  public static getInstance(): UsageService {
    if (!UsageService.instance) UsageService.instance = new UsageService();
    return UsageService.instance;
  }

  public async getUsage(force = false): Promise<AccountUsage> {
    if (!force && this.cache && Date.now() - this.cache.fetchedAt < TTL_MS) return this.cache;
    if (!this.inflight) {
      this.inflight = this.fetch().finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
  }

  private async fetch(): Promise<AccountUsage> {
    if (process.env.CREWTREE_DRIVER === 'fake') {
      return { available: false, subscriptionType: null, windows: [], fetchedAt: Date.now() };
    }
    const q = query({ prompt: idlePrompt, options: { settingSources: [] } }) as any;
    try {
      const read = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
      if (typeof read !== 'function') throw new Error('This Agent SDK has no usage API');
      const raw = await Promise.race([
        read.call(q, { skipBehaviors: true }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timed out')), TIMEOUT_MS)),
      ]);
      this.cache = toUsage(raw);
      return this.cache;
    } catch (err) {
      console.warn('[Usage] could not read plan usage:', err instanceof Error ? err.message : err);
      // Keep showing the last known numbers rather than flickering the meter away
      return this.cache ?? { available: false, subscriptionType: null, windows: [], fetchedAt: Date.now() };
    } finally {
      q.close();
    }
  }
}

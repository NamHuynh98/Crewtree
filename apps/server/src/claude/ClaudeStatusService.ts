// SPDX-License-Identifier: Apache-2.0
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export type ClaudeLoginState = 'logged_in' | 'not_logged_in' | 'unknown';

export interface ClaudeAccountStatus {
  login: ClaudeLoginState;
  subscriptionType?: string;
  error?: string;
  checkedAt: number;
}

const OK_TTL_MS = 5 * 60_000;
const FAILED_TTL_MS = 30_000;
const TIMEOUT_MS = 20_000;

/** A prompt that never yields: the query only answers control requests (no model call, no tokens). */
const idlePrompt: AsyncIterable<SDKUserMessage> = {
  [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<SDKUserMessage>>(() => {}) }),
};

/**
 * Whether the local Claude Code is logged in (sidebar footer and Settings → Account, UI-WIREFRAMES 0/13).
 * Uses `accountInfo()`, which needs no model call (docs/SPIKE-REPORT.md #1).
 */
export class ClaudeStatusService {
  private static instance: ClaudeStatusService;
  private cache?: { value: ClaudeAccountStatus; expiresAt: number };
  private inflight?: Promise<ClaudeAccountStatus>;

  public static getInstance(): ClaudeStatusService {
    if (!ClaudeStatusService.instance) ClaudeStatusService.instance = new ClaudeStatusService();
    return ClaudeStatusService.instance;
  }

  public async getStatus(force = false): Promise<ClaudeAccountStatus> {
    if (!force && this.cache && this.cache.expiresAt > Date.now()) return this.cache.value;
    if (!this.inflight) {
      this.inflight = this.check().finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
  }

  private async check(): Promise<ClaudeAccountStatus> {
    if (process.env.CREWTREE_DRIVER === 'fake') {
      return this.remember({ login: 'logged_in', subscriptionType: 'fake', checkedAt: Date.now() }, OK_TTL_MS);
    }

    const q = query({ prompt: idlePrompt, options: { settingSources: [] } });
    try {
      const info = await Promise.race([
        q.accountInfo(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timed out')), TIMEOUT_MS)),
      ]);
      const loggedIn = Boolean(info.email || info.subscriptionType || info.organization);
      return this.remember(
        {
          login: loggedIn ? 'logged_in' : 'not_logged_in',
          subscriptionType: info.subscriptionType,
          checkedAt: Date.now(),
        },
        OK_TTL_MS
      );
    } catch (err: any) {
      const message = err?.message ?? String(err);
      const login: ClaudeLoginState = /auth|log ?in|credential|401/i.test(message) ? 'not_logged_in' : 'unknown';
      return this.remember({ login, error: message, checkedAt: Date.now() }, FAILED_TTL_MS);
    } finally {
      q.close();
    }
  }

  private remember(value: ClaudeAccountStatus, ttl: number): ClaudeAccountStatus {
    this.cache = { value, expiresAt: Date.now() + ttl };
    return value;
  }
}

// SPDX-License-Identifier: Apache-2.0
import { AgentDriver, DriverCapabilities, DriverOptions } from '../AgentDriver.js';
import { RuntimeType } from '@crewtree/shared';

export class FakeDriver implements AgentDriver {
  readonly runtime: RuntimeType = 'claude';
  readonly capabilities: DriverCapabilities = {
    supportsPreToolHook: true,
    supportsPermissionCallback: true,
    supportsStreamingInput: true,
    supportsResume: true,
    supportsModelList: true,
    supportsSkills: true,
    supportsPlugins: true,
    supportsMemoryFiles: true,
  };

  private options?: DriverOptions;
  private isDisposed = false;

  async init(options: DriverOptions): Promise<void> {
    this.options = options;
  }

  async sendMessage(content: string): Promise<void> {
    if (this.isDisposed) return;
    // Echo back or simulate responses
    setTimeout(() => {
      this.options?.onEvent?.({
        type: 'agent.text.delta',
        payload: { text: `[FakeDriver] Received: ${content}` },
      });
      setTimeout(() => {
        this.options?.onEvent?.({
          type: 'agent.text.done',
          payload: { text: `[FakeDriver] Received: ${content}` },
        });
      }, 50);
    }, 20);
  }

  async interrupt(): Promise<void> {
    this.options?.onEvent?.({
      type: 'agent.status',
      payload: { status: 'idle' },
    });
  }

  async dispose(): Promise<void> {
    this.isDisposed = true;
  }
}

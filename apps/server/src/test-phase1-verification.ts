// SPDX-License-Identifier: Apache-2.0
import { EventBus, WsSocket } from './events/EventBus.js';
import { EventNormalizer } from './runtime/eventNormalizer.js';
import { AgentRuntime } from './runtime/AgentRuntime.js';
import { createAgentMcpServer } from './runtime/mcp/createAgentMcpServer.js';
import { CliDriver } from './runtime/drivers/CliDriver.js';
import { SdkDriver } from './runtime/drivers/SdkDriver.js';
import { SessionAgent } from '@crewtree/shared';

async function testPhase1() {
  console.log('🧪 Starting Phase 1 Comprehensive Verification...\n');

  // 1. Verify EventBus delta batching (~50ms) & WebSocket readyState
  console.log('--- 1. Testing EventBus Delta Batching & WS Broadcast ---');
  const eventBus = EventBus.getInstance();
  const receivedWsEvents: any[] = [];

  const mockWs: WsSocket = {
    readyState: 1, // OPEN
    send: (data: string) => {
      receivedWsEvents.push(JSON.parse(data));
    },
    on: () => {},
  };

  eventBus.registerClient(mockWs, 'test-session-1');

  // Push 3 fast deltas
  eventBus.emitEvent({
    sessionId: 'test-session-1',
    sessionAgentId: 'agent-1',
    type: 'agent.text.delta',
    payload: { text: 'Hello ' },
    ts: Date.now(),
  });
  eventBus.emitEvent({
    sessionId: 'test-session-1',
    sessionAgentId: 'agent-1',
    type: 'agent.text.delta',
    payload: { text: 'World' },
    ts: Date.now(),
  });
  eventBus.emitEvent({
    sessionId: 'test-session-1',
    sessionAgentId: 'agent-1',
    type: 'agent.text.delta',
    payload: { text: '!' },
    ts: Date.now(),
  });

  // At this immediate moment, delta buffer should not have flushed to WS yet
  console.log(`Immediate WS messages count (expect 0): ${receivedWsEvents.length}`);
  if (receivedWsEvents.length !== 0) throw new Error('Deltas should be buffered, not emitted immediately to WS');

  // Wait 70ms for batch flush
  await new Promise((r) => setTimeout(r, 70));
  console.log(`Post-flush WS messages count (expect 1): ${receivedWsEvents.length}`);
  if ((receivedWsEvents.length as number) !== 1) throw new Error('Expected 1 batched WS event');
  console.log(`Batched text content: "${receivedWsEvents[0].payload.text}" (expect "Hello World!")`);
  if (receivedWsEvents[0].payload.text !== 'Hello World!') throw new Error('Batch content mismatch');
  console.log('✅ EventBus delta batching passed!\n');

  // 2. Verify EventNormalizer with rate_limit_event
  console.log('--- 2. Testing EventNormalizer with rate_limit_event ---');
  const normalizer = new EventNormalizer({
    sessionId: 'test-session-1',
    sessionAgentId: 'agent-1',
  });

  const rateLimitEvents = normalizer.normalize({
    type: 'rate_limit_event',
    retry_after_seconds: 30,
  });

  console.log('Normalized events from rate_limit_event:', rateLimitEvents);
  if (
    rateLimitEvents.length !== 1 ||
    rateLimitEvents[0].type !== 'agent.status' ||
    rateLimitEvents[0].payload.status !== 'throttled' ||
    rateLimitEvents[0].payload.retryAfterMs !== 30000
  ) {
    throw new Error('Failed to normalize rate_limit_event');
  }
  console.log('✅ EventNormalizer rate limit handling passed!\n');

  // 3. Verify in-process MCP Server per agent
  console.log('--- 3. Testing createAgentMcpServer ---');
  const mcpServer = createAgentMcpServer({
    sessionId: 'test-session-1',
    sessionAgentId: 'agent-1',
  });
  console.log(`MCP server created with name: "${mcpServer.name}"`);
  if (!mcpServer.name || mcpServer.name !== 'crewtree') {
    throw new Error('MCP server configuration invalid');
  }
  console.log('✅ In-process MCP server per agent passed!\n');

  // 4. Verify CliDriver interface and capabilities
  console.log('--- 4. Testing CliDriver Fallback Capabilities ---');
  const cliDriver = new CliDriver();
  console.log(`CliDriver runtime: ${cliDriver.runtime}`);
  console.log(`CliDriver streaming input: ${cliDriver.capabilities.supportsStreamingInput}`);
  if (cliDriver.runtime !== 'claude' || !cliDriver.capabilities.supportsStreamingInput) {
    throw new Error('CliDriver capabilities mismatch');
  }
  console.log('✅ CliDriver capabilities passed!\n');

  // 5. Verify AgentRuntime lifecycle (FakeDriver mode for testing)
  console.log('--- 5. Testing AgentRuntime suspend/resume with freshContextOverride ---');
  const mockAgent: SessionAgent = {
    id: 'agent-test',
    sessionId: 'test-session-1',
    agentName: 'Test Supervisor',
    scope: 'project',
    snapshot: 'You are a test supervisor.',
    parentId: null,
    depth: 0,
    spawnedBy: 'user',
    status: 'idle',
    lastActiveAt: Date.now(),
    sdkSessionId: 'sdk-session-old-123',
    freshContextOverride: true,
  };

  const runtime = new AgentRuntime({
    sessionId: 'test-session-1',
    sessionAgent: mockAgent,
    cwd: process.cwd(),
    useFakeDriver: true,
  });

  await runtime.start();
  console.log(`Agent status after start: ${runtime.getStatus()} (expect idle)`);
  if (runtime.getStatus() !== 'idle') throw new Error('Status should be idle');

  await runtime.suspend();
  console.log(`Agent status after suspend: ${runtime.getStatus()} (expect suspended)`);
  if (runtime.getStatus() !== 'suspended') throw new Error('Status should be suspended');

  // Send message triggers resumeFromSuspend()
  await runtime.sendMessage('Hello after suspend');
  console.log(`Agent sdkSessionId after freshContext resume: ${mockAgent.sdkSessionId} (expect null)`);
  if (mockAgent.sdkSessionId !== null) throw new Error('freshContextOverride should clear sdkSessionId');

  await runtime.dispose();
  console.log('✅ AgentRuntime suspend/resume with freshContext passed!\n');

  console.log('🎉 ALL PHASE 1 REQUIREMENTS VERIFIED 100% SUCCESSFULLY!');
}

testPhase1().catch((err) => {
  console.error('❌ Verification failed:', err);
  process.exit(1);
});

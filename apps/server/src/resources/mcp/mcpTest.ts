// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'child_process';

export interface McpTestResult {
  ok: boolean;
  serverName?: string;
  serverVersion?: string;
  tools?: string[];
  error?: string;
  durationMs: number;
}

const PROTOCOL_VERSION = '2025-06-18';
const TIMEOUT_MS = 20_000;

const initialize = (id: number) => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'crewtree', version: '0.1.0' } },
});

/** `${VAR}` and `${VAR:-default}` expansion as Claude Code does for MCP configs. */
function expand(value: string): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_m, name, def) => process.env[name] ?? def ?? ''
  );
}

function summarize(init: any, tools: any): Omit<McpTestResult, 'durationMs'> {
  return {
    ok: true,
    serverName: init?.result?.serverInfo?.name,
    serverVersion: init?.result?.serverInfo?.version,
    tools: (tools?.result?.tools ?? []).map((t: any) => String(t.name)),
  };
}

function testStdio(config: any, cwd: string): Promise<Omit<McpTestResult, 'durationMs'>> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: Omit<McpTestResult, 'durationMs'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(r);
    };
    const env = {
      ...process.env,
      ...Object.fromEntries(Object.entries(config.env ?? {}).map(([k, v]) => [k, expand(String(v))])),
    };
    const child = spawn(
      expand(config.command),
      (config.args ?? []).map((a: string) => expand(String(a))),
      {
        cwd,
        env,
        shell: process.platform === 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    const timer = setTimeout(() => done({ ok: false, error: `No answer within ${TIMEOUT_MS / 1000}s` }), TIMEOUT_MS);
    let buffer = '';
    let stderr = '';
    let init: any;
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    child.on('error', (err) => done({ ok: false, error: err.message }));
    child.on('exit', (code) =>
      done({ ok: false, error: `Exited with code ${code}${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}` })
    );
    child.stdout.on('data', (d) => {
      buffer += d;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('{')) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          if (msg.error) return done({ ok: false, error: msg.error.message ?? 'initialize failed' });
          init = msg;
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
        } else if (msg.id === 2) {
          done(summarize(init, msg));
        }
      }
    });
    child.stdin.write(`${JSON.stringify(initialize(1))}\n`);
  });
}

/** Streamable HTTP: JSON or an SSE stream per POST; the session id comes back in a header. */
async function testHttp(config: any): Promise<Omit<McpTestResult, 'durationMs'>> {
  const url = expand(config.url);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...Object.fromEntries(Object.entries(config.headers ?? {}).map(([k, v]) => [k, expand(String(v))])),
  };
  const post = async (body: unknown, extra: Record<string, string> = {}) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...headers, ...extra },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403)
      throw new Error(`HTTP ${res.status}: needs authentication (sign in with \`claude mcp\` / /mcp)`);
    if (!res.ok && res.status !== 202) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const text = await res.text();
    const json = (res.headers.get('content-type') ?? '').includes('text/event-stream')
      ? text
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => {
            try {
              return JSON.parse(l.slice(5).trim());
            } catch {
              return undefined;
            }
          })
          .find((m) => m && 'id' in m)
      : text
        ? JSON.parse(text)
        : undefined;
    return { json, session: res.headers.get('mcp-session-id') ?? undefined };
  };
  const init = await post(initialize(1));
  if (init.json?.error) throw new Error(init.json.error.message ?? 'initialize failed');
  const session: Record<string, string> = init.session ? { 'Mcp-Session-Id': init.session } : {};
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, session);
  const tools = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, session);
  return summarize(init.json, tools.json);
}

/** Connects like a client would: initialize + tools/list (UI-WIREFRAMES 11 "✓ connected · 24 tools"). */
export async function testMcpServer(config: any, cwd: string): Promise<McpTestResult> {
  const started = Date.now();
  const type = config.type ?? (config.url ? 'http' : 'stdio');
  try {
    if (type === 'sse') {
      return {
        ok: false,
        error: 'Testing legacy SSE servers is not supported here; use `claude mcp get <name>`',
        durationMs: 0,
      };
    }
    const result = type === 'stdio' ? await testStdio(config, cwd) : await testHttp(config);
    return { ...result, durationMs: Date.now() - started };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err), durationMs: Date.now() - started };
  }
}

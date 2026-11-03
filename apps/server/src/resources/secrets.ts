// SPDX-License-Identifier: Apache-2.0

export const MASK = '••••';

/** Never return MCP secrets in clear (PLAN.md 6.3, 15.3): env values and header values are masked. */
export function maskMcpConfig(config: Record<string, any>): Record<string, any> {
  const masked: Record<string, any> = { ...config };
  for (const key of ['env', 'headers']) {
    if (masked[key] && typeof masked[key] === 'object') {
      masked[key] = Object.fromEntries(Object.keys(masked[key]).map((k) => [k, MASK]));
    }
  }
  // Inline tokens in URLs (?token=…) are secrets too
  if (typeof masked.url === 'string') {
    masked.url = masked.url.replace(/([?&](?:token|key|apikey|api_key|access_token|secret)=)[^&]+/gi, `$1${MASK}`);
  }
  return masked;
}

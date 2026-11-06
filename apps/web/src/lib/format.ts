// SPDX-License-Identifier: Apache-2.0

/** 950, 1.2k, 34k, 1.5M. Own module: pages that only show numbers do not load the YAML parser. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

// SPDX-License-Identifier: Apache-2.0

/** Merges plain objects recursively; arrays and scalars in `patch` replace the target value. */
export function deepMerge(target: any, patch: any): any {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return patch;
  const out = { ...(typeof target === 'object' && target !== null ? target : {}) };
  for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(out[k], v);
  return out;
}

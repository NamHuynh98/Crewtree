// SPDX-License-Identifier: Apache-2.0
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { ResourceItem } from './types';

/** Every agent of the library (user, project, plugins). Own module so callers do not load the Agents page. */
export function useAgents() {
  return useQuery({ queryKey: ['resources', 'agents'], queryFn: () => api<ResourceItem[]>('/api/resources/agents') });
}

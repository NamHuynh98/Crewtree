// SPDX-License-Identifier: Apache-2.0
import { ProjectService } from './ProjectService.js';

/** The current project (switchable from the header, PLAN.md 6.1). */
export function getCurrentProjectPath(): string {
  return ProjectService.getInstance().currentPath();
}

export function getCurrentProject() {
  return ProjectService.getInstance().currentInfo();
}

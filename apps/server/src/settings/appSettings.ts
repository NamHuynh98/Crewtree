// SPDX-License-Identifier: Apache-2.0
import { eq } from 'drizzle-orm';
import { AppSettings, AppSettingsSchema } from '@crewtree/shared';
import { getDb } from '../db/index.js';
import { appSettingsTable } from '../db/schema.js';

export function getAppSettings(): AppSettings {
  const row = getDb().select().from(appSettingsTable).where(eq(appSettingsTable.key, 'global')).get();
  if (!row) return AppSettingsSchema.parse({});
  const parsed = AppSettingsSchema.safeParse(JSON.parse(row.value));
  return parsed.success ? parsed.data : AppSettingsSchema.parse({});
}

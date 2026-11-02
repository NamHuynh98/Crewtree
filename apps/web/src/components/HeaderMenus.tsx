// SPDX-License-Identifier: Apache-2.0
import { useTranslation } from 'react-i18next';
import { ChevronDown, SunMoon } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { LanguageSetting, ThemeSetting } from '@/lib/boot';

const triggerClass =
  'flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-semibold text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

/** ◐ Light / Dark / System (UI-WIREFRAMES 0, 13) */
export function ThemeMenu({ value, onChange }: { value: ThemeSetting; onChange: (theme: ThemeSetting) => void }) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={triggerClass} title={t('header.theme')} aria-label={t('header.theme')}>
        <SunMoon className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={value} onValueChange={(v) => onChange(v as ThemeSetting)}>
          {(['light', 'dark', 'system'] as const).map((theme) => (
            <DropdownMenuRadioItem key={theme} value={theme} className="text-xs">
              {t(`theme.${theme}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** EN ▾ — ✓ English EN / Tiếng Việt VI (UI-WIREFRAMES 13) */
export function LanguageMenu({
  value,
  onChange,
}: {
  value: LanguageSetting;
  onChange: (language: LanguageSetting) => void;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={triggerClass} title={t('header.language')} aria-label={t('header.language')}>
        {value.toUpperCase()}
        <ChevronDown className="h-3 w-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[10rem]">
        <DropdownMenuRadioGroup value={value} onValueChange={(v) => onChange(v as LanguageSetting)}>
          {(['en', 'vi'] as const).map((lang) => (
            <DropdownMenuRadioItem key={lang} value={lang} className="text-xs justify-between">
              <span>{t(`languages.${lang}`)}</span>
              <span className="text-muted-foreground">{lang.toUpperCase()}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

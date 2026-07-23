import { Languages } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { SupportedLanguage } from '../../language';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../ui/select';

export function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const { i18n, t } = useTranslation();
  const language: SupportedLanguage =
    i18n.resolvedLanguage === 'en-US' ? 'en-US' : 'zh-CN';

  return (
    <Select
      value={language}
      onValueChange={(value) => void i18n.changeLanguage(value)}
    >
      <SelectTrigger
        className={compact ? 'language-select compact' : 'language-select'}
        aria-label={t('language.label')}
      >
        {compact && <Languages />}
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="zh-CN">{t('language.zhCN')}</SelectItem>
        <SelectItem value="en-US">{t('language.enUS')}</SelectItem>
      </SelectContent>
    </Select>
  );
}

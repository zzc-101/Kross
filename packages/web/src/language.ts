export const supportedLanguages = ['zh-CN', 'en-US'] as const;
export type SupportedLanguage = typeof supportedLanguages[number];

export function resolveLanguage(
  savedLanguage: string | null,
  browserLanguage: string
): SupportedLanguage {
  if (savedLanguage === 'zh-CN' || savedLanguage === 'en-US') {
    return savedLanguage;
  }
  return browserLanguage.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
}

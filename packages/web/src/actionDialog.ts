export const GIT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function validateGitRef(value: string): string | undefined {
  if (!value.trim()) return '分支名称不能为空';
  if (!GIT_REF_PATTERN.test(value.trim())) {
    return '分支名称只能包含字母、数字、点、下划线、斜线和连字符';
  }
  return undefined;
}

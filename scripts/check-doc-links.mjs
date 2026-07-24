import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const roots = [
  join(root, 'README.md'),
  join(root, 'README.zh-CN.md'),
  join(root, 'CONTRIBUTING.md'),
  join(root, 'SECURITY.md'),
  join(root, 'CHANGELOG.md'),
  join(root, 'docs')
];

const markdownFiles = roots.flatMap(collectMarkdownFiles);
const failures = [];
const linkPattern = /(?<!!)\[[^\n]*?\]\(([^)\n]+)\)/gu;

for (const file of markdownFiles) {
  const content = readFileSync(file, 'utf8');
  for (const match of content.matchAll(linkPattern)) {
    const rawTarget = match[1]?.trim();
    if (!rawTarget || shouldSkip(rawTarget)) {
      continue;
    }
    const target = normalizeTarget(rawTarget);
    if (!target) {
      continue;
    }
    const absolute = resolve(dirname(file), target);
    if (!existsSync(absolute)) {
      failures.push(
        `${relativeToRoot(file)} -> ${rawTarget}（未找到 ${relativeToRoot(absolute)}）`
      );
    }
  }
}

if (failures.length > 0) {
  console.error('文档链接检查失败：');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log(`文档链接检查通过：${markdownFiles.length} 个 Markdown 文件`);
}

function collectMarkdownFiles(path) {
  if (!existsSync(path)) {
    return [];
  }
  if (!statSync(path).isDirectory()) {
    return extname(path) === '.md' ? [path] : [];
  }
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory()
      ? collectMarkdownFiles(child)
      : extname(entry.name) === '.md'
        ? [child]
        : [];
  });
}

function shouldSkip(target) {
  return (
    target.startsWith('#') ||
    /^[a-z][a-z0-9+.-]*:/iu.test(target) ||
    target.startsWith('//')
  );
}

function normalizeTarget(target) {
  const withoutTitle = target.replace(/\s+["'][^"']*["']$/u, '');
  const withoutFragment = withoutTitle.split('#', 1)[0];
  const decoded = decodeURIComponent(withoutFragment ?? '');
  return decoded.length > 0 ? decoded : undefined;
}

function relativeToRoot(path) {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

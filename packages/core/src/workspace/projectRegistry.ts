import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import {
  projectRegistrySchema,
  type ProjectConfig,
  type ProjectRegistry,
  type RepoConfig
} from '../domain';

export interface ProjectRegistryLoadOptions {
  homeDir?: string;
  krossHome?: string;
  /** Optional workspace root: also try `<cwd>/.kross/project.json`. */
  workspaceRoot?: string;
  /** Override primary file path (tests). */
  registryPath?: string;
}

export interface LoadedProjectRegistry {
  registry: ProjectRegistry;
  /** Absolute path of the file that was loaded (primary). */
  sourcePath: string;
  /** Extra paths merged (e.g. workspace override). */
  mergedPaths: string[];
}

export interface ActiveProjectSelection {
  projectId: string;
  project: ProjectConfig;
  reason: string;
}

/**
 * Resolve `~/.kross/projects.json` (or custom krossHome).
 */
export function resolveProjectsRegistryPath(
  options: ProjectRegistryLoadOptions = {}
): string {
  if (options.registryPath) {
    return options.registryPath;
  }
  const root =
    options.krossHome ?? join(options.homeDir ?? homedir(), '.kross');
  return join(root, 'projects.json');
}

/**
 * Load and validate project registry. Returns undefined if file missing.
 * Throws if file exists but is invalid JSON/schema.
 */
export function loadProjectRegistry(
  options: ProjectRegistryLoadOptions = {}
): LoadedProjectRegistry | undefined {
  const primary = resolveProjectsRegistryPath(options);
  const workspaceOverride =
    options.workspaceRoot !== undefined
      ? join(options.workspaceRoot, '.kross', 'project.json')
      : undefined;

  const pathsToTry = [primary];
  if (workspaceOverride && workspaceOverride !== primary) {
    pathsToTry.push(workspaceOverride);
  }

  let base: ProjectRegistry | undefined;
  let sourcePath = primary;
  const mergedPaths: string[] = [];

  for (const path of pathsToTry) {
    if (!existsSync(path)) {
      continue;
    }
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const parsed = projectRegistrySchema.parse(raw);
    const normalized = normalizeRegistryPaths(parsed, path);
    if (!base) {
      base = normalized;
      sourcePath = path;
    } else {
      base = mergeRegistries(base, normalized);
      mergedPaths.push(path);
    }
  }

  if (!base) {
    return undefined;
  }

  return { registry: base, sourcePath, mergedPaths };
}

/**
 * Expand relative repo paths against the registry file's directory;
 * keep absolute paths as resolve()'d.
 */
export function normalizeRegistryPaths(
  registry: ProjectRegistry,
  registryFilePath: string
): ProjectRegistry {
  const baseDir = resolve(registryFilePath, '..');
  const projects: ProjectRegistry['projects'] = {};
  for (const [projectId, project] of Object.entries(registry.projects)) {
    projects[projectId] = {
      repos: project.repos.map((repo) => ({
        ...repo,
        path: isAbsolute(repo.path)
          ? resolve(repo.path)
          : resolve(baseDir, repo.path)
      }))
    };
  }
  return {
    defaultProjectId: registry.defaultProjectId,
    projects
  };
}

function mergeRegistries(
  base: ProjectRegistry,
  overlay: ProjectRegistry
): ProjectRegistry {
  return {
    defaultProjectId: overlay.defaultProjectId ?? base.defaultProjectId,
    projects: {
      ...base.projects,
      ...overlay.projects
    }
  };
}

/**
 * Pick active project: explicit id → cwd match → defaultProjectId → sole project.
 */
export function selectActiveProject(
  registry: ProjectRegistry,
  options: {
    activeProjectId?: string;
    workspaceRoot?: string;
  } = {}
): ActiveProjectSelection | undefined {
  const entries = Object.entries(registry.projects);
  if (entries.length === 0) {
    return undefined;
  }

  if (options.activeProjectId) {
    const project = registry.projects[options.activeProjectId];
    if (project) {
      return {
        projectId: options.activeProjectId,
        project,
        reason: `explicit activeProjectId=${options.activeProjectId}`
      };
    }
  }

  if (options.workspaceRoot) {
    const cwd = resolve(options.workspaceRoot);
    for (const [projectId, project] of entries) {
      for (const repo of project.repos) {
        const repoPath = resolve(repo.path);
        if (cwd === repoPath || cwd.startsWith(repoPath + '/') || cwd.startsWith(repoPath + '\\')) {
          return {
            projectId,
            project,
            reason: `workspaceRoot matches repo ${repo.id} (${repo.path})`
          };
        }
      }
    }
  }

  if (registry.defaultProjectId) {
    const project = registry.projects[registry.defaultProjectId];
    if (project) {
      return {
        projectId: registry.defaultProjectId,
        project,
        reason: `defaultProjectId=${registry.defaultProjectId}`
      };
    }
  }

  if (entries.length === 1) {
    const [projectId, project] = entries[0]!;
    return {
      projectId,
      project,
      reason: 'sole project in registry'
    };
  }

  return undefined;
}

/** Realpath-style absolute roots allowed for multi-root Task (cwd + all repo paths). */
export function collectAllowedWorkspaceRoots(
  registry: ProjectRegistry | undefined,
  workspaceRoot?: string
): string[] {
  const roots = new Set<string>();
  if (workspaceRoot) {
    roots.add(resolve(workspaceRoot));
  }
  if (registry) {
    for (const project of Object.values(registry.projects)) {
      for (const repo of project.repos) {
        roots.add(resolve(repo.path));
      }
    }
  }
  return [...roots];
}

export function findRepoById(
  project: ProjectConfig,
  repoId: string
): RepoConfig | undefined {
  return project.repos.find((repo) => repo.id === repoId);
}

/** Human-readable registry summary for SessionContext / planner prompt. */
export function formatRegistryForPrompt(
  selection: ActiveProjectSelection,
  registrySourcePath?: string
): string {
  const lines = [
    `Active project: ${selection.projectId} (${selection.reason})`,
    registrySourcePath ? `Registry file: ${registrySourcePath}` : undefined,
    'Repos (use Task with repoId to edit outside main cwd):',
    ...selection.project.repos.map(
      (repo) =>
        `- id=${repo.id} type=${repo.type} path=${repo.path}` +
        (repo.testCommand ? ` test=${repo.testCommand}` : '')
    )
  ].filter((line): line is string => line !== undefined);
  return lines.join('\n');
}

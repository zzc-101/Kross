import type { EvalReport } from './schema';

export const PROVIDER_MATRIX_VERSION = 1;

export interface ProviderCapabilityResult {
  capability: string;
  passed: number;
  failed: number;
}

export interface ProviderMatrixRow {
  provider: string;
  model: string;
  runs: number;
  passed: number;
  failed: number;
  passRate: number;
  capabilities: ProviderCapabilityResult[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCostUsd?: number;
    pricingCoverage: 'complete' | 'partial' | 'unavailable';
  };
  latency: {
    totalMs: number;
    meanMs: number;
    p95Ms: number;
  };
  rateLimitCount: number;
  errorCategories: Record<string, number>;
}

export interface ProviderMatrix {
  version: typeof PROVIDER_MATRIX_VERSION;
  deterministicOnly: boolean;
  rows: ProviderMatrixRow[];
}

/** Aggregate Eval evidence; never invent compatibility or pricing data. */
export function buildProviderMatrix(
  reports: readonly EvalReport[]
): ProviderMatrix {
  const groups = new Map<string, EvalReport[]>();
  for (const report of reports) {
    const key = `${report.runtime.provider}\u0000${report.runtime.model}`;
    const group = groups.get(key) ?? [];
    group.push(report);
    groups.set(key, group);
  }

  const rows = [...groups.values()]
    .map(buildRow)
    .sort((left, right) =>
      `${left.provider}/${left.model}`.localeCompare(
        `${right.provider}/${right.model}`
      )
    );
  return {
    version: PROVIDER_MATRIX_VERSION,
    deterministicOnly: reports.every((report) => report.deterministic),
    rows
  };
}

function buildRow(reports: EvalReport[]): ProviderMatrixRow {
  const first = reports[0]!;
  const passed = reports.filter((report) => report.status === 'passed').length;
  const durations = reports
    .map((report) => report.durationMs)
    .sort((left, right) => left - right);
  const priced = reports.filter(
    (report) => report.usage.estimatedCostUsd !== undefined
  );
  const estimatedCostUsd = priced.reduce(
    (total, report) => total + (report.usage.estimatedCostUsd ?? 0),
    0
  );
  const errors: Record<string, number> = {};
  let rateLimitCount = 0;
  for (const report of reports) {
    const category = report.providerErrorCategory ?? report.failureCategory;
    if (category) errors[category] = (errors[category] ?? 0) + 1;
    if (report.providerErrorCategory === 'rate-limit') rateLimitCount += 1;
  }

  return {
    provider: first.runtime.provider,
    model: first.runtime.model,
    runs: reports.length,
    passed,
    failed: reports.length - passed,
    passRate: reports.length === 0 ? 0 : passed / reports.length,
    capabilities: aggregateCapabilities(reports),
    usage: {
      inputTokens: sum(reports, (report) => report.usage.inputTokens),
      outputTokens: sum(reports, (report) => report.usage.outputTokens),
      totalTokens: sum(reports, (report) => report.usage.totalTokens),
      ...(priced.length > 0 ? { estimatedCostUsd } : {}),
      pricingCoverage:
        priced.length === 0
          ? 'unavailable'
          : priced.length === reports.length
            ? 'complete'
            : 'partial'
    },
    latency: {
      totalMs: sum(reports, (report) => report.durationMs),
      meanMs:
        reports.length === 0
          ? 0
          : Math.round(
              sum(reports, (report) => report.durationMs) / reports.length
            ),
      p95Ms: percentile(durations, 0.95)
    },
    rateLimitCount,
    errorCategories: errors
  };
}

function aggregateCapabilities(
  reports: EvalReport[]
): ProviderCapabilityResult[] {
  const results = new Map<string, { passed: number; failed: number }>();
  for (const report of reports) {
    for (const capability of report.capabilities) {
      const current = results.get(capability) ?? { passed: 0, failed: 0 };
      if (report.status === 'passed') current.passed += 1;
      else current.failed += 1;
      results.set(capability, current);
    }
  }
  return [...results.entries()]
    .map(([capability, result]) => ({ capability, ...result }))
    .sort((left, right) => left.capability.localeCompare(right.capability));
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const index = Math.max(
    0,
    Math.ceil(values.length * percentileValue) - 1
  );
  return values[index] ?? 0;
}

function sum(
  reports: EvalReport[],
  select: (report: EvalReport) => number
): number {
  return reports.reduce((total, report) => total + select(report), 0);
}

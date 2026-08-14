import type { ConductorTaskPlan } from './conductorPlan';

export interface PendingConductorExecution {
  kind: 'conductor';
  goal: string;
  mode: 'conductor';
  plan: ConductorTaskPlan;
}

export interface PendingPlanExecution {
  kind: 'plan';
  goal: string;
  mode: 'plan';
  planText: string;
}

export type PendingModeExecution =
  | PendingConductorExecution
  | PendingPlanExecution;

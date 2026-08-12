export type DomainInvariantCode =
  | 'active_run_conflict'
  | 'approval_already_consumed'
  | 'approval_decision_conflict'
  | 'approval_not_approved'
  | 'approval_request_mismatch'
  | 'invalid_artifact_revision'
  | 'invalid_status_transition'
  | 'invalid_source_revision'
  | 'missing_ready_metadata'
  | 'organization_boundary_violation'
  | 'permission_denied'
  | 'task_not_open';

export class DomainInvariantError extends Error {
  readonly code: DomainInvariantCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: DomainInvariantCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {}
  ) {
    super(message);
    this.name = 'DomainInvariantError';
    this.code = code;
    this.details = details;
  }
}

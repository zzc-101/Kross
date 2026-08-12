import { ForbiddenError } from './errors';
import type {
  AuthorizationContext,
  OrchestratorAuthorizer,
  OrchestratorScope
} from './types';

export class ScopeAuthorizer implements OrchestratorAuthorizer {
  authorize(
    context: AuthorizationContext,
    scope: OrchestratorScope
  ): void {
    if (!context.principal.scopes.includes(scope)) throw new ForbiddenError();
  }
}

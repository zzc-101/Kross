import { PROTOCOL_VERSION, runSpecSchema, type RunSpec } from '@kross/protocol';

export function createRunSpec(overrides: Partial<RunSpec> = {}): RunSpec {
  const now = '2026-08-12T00:00:00.000Z';
  return runSpecSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    organizationId: 'org1',
    projectId: 'project1',
    taskId: 'task1',
    runId: 'run1',
    generation: 1,
    leaseId: 'lease1',
    leaseExpiresAt: '2099-08-12T00:00:00.000Z',
    issuedAt: now,
    task: {
      type: 'general',
      title: 'Prepare summary',
      objective: 'Prepare a concise summary.',
      constraints: [],
      acceptanceCriteria: ['A response exists'],
      messages: [{ id: 'message1', role: 'user', text: 'Please summarize.', createdAt: now }]
    },
    sources: [],
    model: { provider: 'openai', model: 'test-model', credentialHandle: 'credential1' },
    mode: 'auto',
    executionProfile: 'work',
    policy: {
      permissionPolicy: {
        version: 1,
        allowNetworkAccess: false,
        allowRepositoryWrite: false,
        allowedConnectorScopes: [],
        approvalPolicy: {
          requirePlanApproval: false,
          requireExternalActionApproval: true,
          minimumToolRiskRequiringApproval: 'high',
          allowAdminOrganizationHighRiskApproval: true,
          allowMemberHighRiskApproval: false
        }
      },
      allowedToolNames: [],
      connectorInstallationIds: [],
      externalActions: 'require_approval',
      networkAccess: 'disabled'
    },
    resourceLimits: {
      cpuMillis: 1000,
      memoryBytes: 1024 * 1024,
      maxPids: 32,
      diskBytes: 1024 * 1024,
      maxDurationMs: 60_000,
      maxSourceBytes: 1024 * 1024,
      maxArtifactBytes: 1024 * 1024,
      maxEventPayloadBytes: 64 * 1024,
      maxTokens: 1000
    },
    workspace: {
      root: '/work',
      inputDirectory: '/work/input',
      outputDirectory: '/work/output',
      checkpointDirectory: '/work/checkpoint'
    },
    ...overrides
  });
}

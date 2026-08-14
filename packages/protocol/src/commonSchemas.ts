import { z } from 'zod';

import { PROTOCOL_LIMITS } from './limits';
import { PROTOCOL_VERSION } from './version';

export const protocolVersionSchema = z.literal(PROTOCOL_VERSION);

/** Opaque resource IDs. Their server-side generation strategy is not public API. */
export const resourceIdSchema = z
  .string()
  .min(1)
  .max(PROTOCOL_LIMITS.idChars)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);

export const organizationIdSchema = resourceIdSchema;
export const projectIdSchema = resourceIdSchema;
export const taskIdSchema = resourceIdSchema;
export const taskMessageIdSchema = resourceIdSchema;
export const runIdSchema = resourceIdSchema;
export const sourceIdSchema = resourceIdSchema;
export const artifactIdSchema = resourceIdSchema;
export const approvalIdSchema = resourceIdSchema;
export const userIdSchema = resourceIdSchema;
export const notificationIdSchema = resourceIdSchema;
export const workerIdSchema = resourceIdSchema;
export const workerSessionIdSchema = resourceIdSchema;
export const leaseIdSchema = resourceIdSchema;
export const toolCallIdSchema = resourceIdSchema;

export const opaqueCursorSchema = z
  .string()
  .min(1)
  .max(PROTOCOL_LIMITS.cursorChars)
  .regex(/^[\x21-\x7e]+$/);
export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(PROTOCOL_LIMITS.idempotencyKeyChars)
  .regex(/^[\x21-\x7e]+$/);
export const isoDateTimeSchema = z.string().datetime({ offset: true });
export const shortLabelSchema = z
  .string()
  .min(1)
  .max(PROTOCOL_LIMITS.shortLabelChars)
  .regex(/\S/);
export const optionalSummarySchema = z
  .string()
  .max(PROTOCOL_LIMITS.summaryChars);
export const summarySchema = z
  .string()
  .min(1)
  .max(PROTOCOL_LIMITS.summaryChars)
  .regex(/\S/);
export const inlineTextSchema = z
  .string()
  .max(PROTOCOL_LIMITS.inlineTextChars);
export const nonEmptyInlineTextSchema = z
  .string()
  .min(1)
  .max(PROTOCOL_LIMITS.inlineTextChars)
  .regex(/\S/);
export const messageDeltaSchema = z
  .string()
  .min(1)
  .max(PROTOCOL_LIMITS.messageDeltaChars)
  .regex(/\S/);
export const httpUrlSchema = z
  .string()
  .url()
  .max(PROTOCOL_LIMITS.urlChars)
  .regex(/^https?:\/\//i);
export const mimeTypeSchema = z
  .string()
  .min(1)
  .max(PROTOCOL_LIMITS.mimeTypeChars)
  .regex(/^[!#$&^_.+A-Za-z0-9-]+\/[!#$&^_.+A-Za-z0-9-]+$/);
export const sha256Schema = z
  .string()
  .length(PROTOCOL_LIMITS.sha256Chars)
  .regex(/^[a-f0-9]{64}$/);
export const byteCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const positiveDurationMsSchema = z.number().int().positive().max(86_400_000);
export const sequenceSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const generationSchema = z.number().int().positive().max(2_147_483_647);

export const paginationQuerySchema = z
  .object({
    cursor: opaqueCursorSchema.optional(),
    limit: z.number().int().min(1).max(PROTOCOL_LIMITS.listItems).default(50)
  })
  .strict();

export const pageInfoSchema = z
  .object({
    nextCursor: opaqueCursorSchema.optional(),
    hasMore: z.boolean()
  })
  .strict();

export function paginatedSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z
    .object({
      items: z.array(itemSchema).max(PROTOCOL_LIMITS.listItems),
      pageInfo: pageInfoSchema
    })
    .strict();
}

export const failureSchema = z
  .object({
    code: z.string().min(1).max(120).regex(/^[A-Z][A-Z0-9_]*$/),
    summary: summarySchema,
    retryable: z.boolean()
  })
  .strict();

export const riskLevels = ['low', 'medium', 'high', 'critical'] as const;
export const riskLevelSchema = z.enum(riskLevels);
export const workAgentModeSchema = z.enum(['auto', 'plan']);

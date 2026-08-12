/** Wire-level limits shared by public and internal protocol schemas. */
export const PROTOCOL_LIMITS = {
  idChars: 128,
  cursorChars: 512,
  idempotencyKeyChars: 200,
  shortLabelChars: 500,
  summaryChars: 4_000,
  inlineTextChars: 32_768,
  messageDeltaChars: 8_192,
  urlChars: 4_096,
  mimeTypeChars: 255,
  sha256Chars: 64,
  listItems: 100,
  snapshotListItems: 500,
  eventBatchItems: 100,
  headerCount: 32,
  headerNameChars: 128,
  headerValueChars: 2_048
} as const;

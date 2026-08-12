export const sourceArtifactBlobMigration = String.raw`
ALTER TABLE artifacts ADD COLUMN generation integer CHECK (generation > 0);
ALTER TABLE artifacts ADD COLUMN reserve_idempotency_key text;
ALTER TABLE artifacts ADD COLUMN upload_blob_key text;
ALTER TABLE artifacts ADD COLUMN ready_at timestamptz;

CREATE UNIQUE INDEX artifacts_reserve_idempotency
  ON artifacts (organization_id, run_id, reserve_idempotency_key)
  WHERE reserve_idempotency_key IS NOT NULL;

ALTER TABLE artifacts ADD CONSTRAINT artifacts_pending_upload_metadata
  CHECK (
    reserve_idempotency_key IS NULL OR
    (generation IS NOT NULL AND
      ((status = 'pending' AND upload_blob_key IS NOT NULL AND blob_key IS NULL AND ready_at IS NULL) OR
       (status = 'ready' AND upload_blob_key IS NULL AND blob_key IS NOT NULL AND ready_at IS NOT NULL) OR
       status IN ('failed','deleted')))
  );
`;

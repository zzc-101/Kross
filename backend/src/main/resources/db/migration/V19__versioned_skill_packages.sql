CREATE TABLE platform_skill_versions (
  id text PRIMARY KEY,
  skill_id text NOT NULL REFERENCES platform_skills(id) ON DELETE CASCADE,
  version bigint NOT NULL CHECK (version > 0),
  package_key text,
  package_sha256 text CHECK (package_sha256 IS NULL OR package_sha256 ~ '^[0-9a-f]{64}$'),
  package_size_bytes bigint NOT NULL DEFAULT 0 CHECK (package_size_bytes >= 0),
  skill_md text NOT NULL,
  skill_md_digest text NOT NULL CHECK (skill_md_digest ~ '^[0-9a-f]{64}$'),
  manifest jsonb NOT NULL DEFAULT '{}',
  changelog text NOT NULL DEFAULT '',
  created_by text REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (skill_id, version)
);

CREATE INDEX platform_skill_versions_history
  ON platform_skill_versions (skill_id, version DESC);

INSERT INTO platform_skill_versions
  (id, skill_id, version, skill_md, skill_md_digest, manifest, changelog, created_by,
   created_at, published_at)
SELECT
  skill.id || ':v1', skill.id, 1, skill.content, skill.content_digest,
  jsonb_build_object(
    'format', 'legacy-inline',
    'skillMdPath', 'SKILL.md',
    'fileCount', 1,
    'uncompressedSizeBytes', octet_length(skill.content),
    'hasScripts', false,
    'hasReferences', false,
    'hasAssets', false
  ),
  '由旧版 Skill 迁移', skill.created_by, skill.created_at, skill.updated_at
FROM platform_skills skill;

ALTER TABLE platform_skills
  ADD COLUMN active_version_id text REFERENCES platform_skill_versions(id) ON DELETE SET NULL;

UPDATE platform_skills skill
SET active_version_id = version.id
FROM platform_skill_versions version
WHERE version.skill_id = skill.id AND version.version = 1;

ALTER TABLE platform_skills DROP CONSTRAINT platform_skills_status_check;
ALTER TABLE platform_skills
  ADD CONSTRAINT platform_skills_status_check CHECK (status IN ('draft', 'active', 'disabled'));

ALTER TABLE platform_skills
  DROP COLUMN content,
  DROP COLUMN content_digest,
  DROP COLUMN revision;

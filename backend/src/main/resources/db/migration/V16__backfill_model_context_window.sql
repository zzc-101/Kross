-- Existing platform models predate the explicit context-window setting.
-- Persist the same default used by the API and Worker so every profile is complete.
UPDATE model_profiles
SET configuration = jsonb_set(
      COALESCE(configuration, '{}'::jsonb),
      '{contextWindow}',
      '256000'::jsonb,
      true),
    updated_at = now()
WHERE NOT COALESCE(configuration, '{}'::jsonb) ? 'contextWindow';

-- Optional profile fields. display_name remains the nickname shown in the UI.

ALTER TABLE users
  ADD COLUMN avatar_url text,
  ADD COLUMN gender text NOT NULL DEFAULT 'unspecified'
    CHECK (gender IN ('unspecified', 'male', 'female', 'other')),
  ADD COLUMN phone text;

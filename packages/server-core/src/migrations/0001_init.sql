CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  module TEXT NOT NULL DEFAULT 'core',
  version INT NOT NULL DEFAULT 1,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS households (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  created_by_user_id UUID,
  profile_lock BOOLEAN NOT NULL DEFAULT FALSE,
  shared_tv_idle_minutes INT NOT NULL DEFAULT 240
    CHECK (shared_tv_idle_minutes IN (30, 60, 240, 720)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  email TEXT UNIQUE,
  household_id UUID NOT NULL REFERENCES households(id),
  ui_language TEXT NOT NULL DEFAULT 'en',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY,
  household_id UUID NOT NULL REFERENCES households(id),
  name TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  pin_hash TEXT,
  ui_language TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS devices (
  id UUID PRIMARY KEY,
  household_id UUID NOT NULL REFERENCES households(id),
  kind TEXT NOT NULL CHECK (kind IN ('phone', 'tv')),
  display_name TEXT NOT NULL DEFAULT '',
  secret_hash TEXT NOT NULL,
  last_lan_host TEXT,
  last_lan_port INT,
  lan_cert_sha256 TEXT,
  hardware_hash TEXT,
  trust_level TEXT NOT NULL DEFAULT 'home'
    CHECK (trust_level IN ('home', 'temporary')),
  trust_expires_at TIMESTAMPTZ,
  telegram_direct_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS devices_user ON devices (user_id) WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  device_id UUID REFERENCES devices(id),
  refresh_token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  client TEXT NOT NULL DEFAULT 'app' CHECK (client IN ('app', 'web')),
  chain_id UUID
);

CREATE TABLE IF NOT EXISTS pairing_sessions (
  id UUID PRIMARY KEY,
  household_id UUID REFERENCES households(id),
  pin_lookup TEXT NOT NULL,
  pairing_token_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'paired', 'expired', 'revoked')),
  tv_device_id UUID REFERENCES devices(id),
  lan_capability_hash TEXT,
  lan_capability_plain TEXT,
  device_name TEXT,
  hardware_hash TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auth_rate_limits (
  key TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  hits INT NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);

CREATE TABLE IF NOT EXISTS setup_codes (
  id UUID PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  attempts INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS phone_join_requests (
  id UUID PRIMARY KEY,
  household_id UUID REFERENCES households(id) ON DELETE CASCADE,
  short_code_lookup TEXT NOT NULL,
  poll_secret_hash TEXT NOT NULL,
  device_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  approved_by_device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
  approved_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
  access_token TEXT,
  refresh_token TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_phone_join_requests_code
  ON phone_join_requests (short_code_lookup)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS media_items (
  id UUID PRIMARY KEY,
  household_id UUID NOT NULL REFERENCES households(id),
  title TEXT NOT NULL,
  original_display_hint TEXT,
  year INT,
  description TEXT,
  duration_seconds DOUBLE PRECISION,
  media_type TEXT NOT NULL DEFAULT 'movie',
  series_identity TEXT,
  season_number INT,
  episode_number INT,
  episode_title TEXT,
  special BOOLEAN NOT NULL DEFAULT FALSE,
  genres TEXT[] NOT NULL DEFAULT '{}',
  director TEXT,
  match_status TEXT NOT NULL DEFAULT 'unmatched',
  hidden_at TIMESTAMPTZ,
  user_metadata_fields TEXT[] NOT NULL DEFAULT '{}',
  metadata_revision INT NOT NULL DEFAULT 0,
  metadata_edit_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_media_items_household_type
  ON media_items (household_id, media_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_media_items_household_series
  ON media_items (household_id, series_identity, season_number, episode_number);

CREATE TABLE IF NOT EXISTS media_sources (
  id UUID PRIMARY KEY,
  media_item_id UUID NOT NULL REFERENCES media_items(id),
  household_id UUID NOT NULL REFERENCES households(id),
  kind TEXT NOT NULL,
  origin_filename TEXT NOT NULL,
  origin_identity TEXT NOT NULL,
  serving_device_id UUID REFERENCES devices(id),
  availability TEXT NOT NULL DEFAULT 'unknown',
  stable_source_key TEXT,
  phone_location TEXT,
  source_fingerprint TEXT,
  archive_state TEXT NOT NULL DEFAULT 'active',
  bytes_total BIGINT,
  playback_mime TEXT,
  private BOOLEAN NOT NULL DEFAULT FALSE,
  last_seen_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_media_sources_household_origin
  ON media_sources (household_id, origin_identity);

CREATE INDEX IF NOT EXISTS idx_media_sources_stable_key
  ON media_sources (household_id, stable_source_key);

CREATE INDEX IF NOT EXISTS idx_media_sources_phone_location
  ON media_sources (household_id, phone_location);

CREATE TABLE IF NOT EXISTS collections (
  id UUID PRIMARY KEY,
  household_id UUID NOT NULL REFERENCES households(id),
  name TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_collections_household_name
  ON collections (household_id, LOWER(name));

CREATE TABLE IF NOT EXISTS collection_members (
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  media_item_id UUID NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (collection_id, media_item_id)
);

CREATE TABLE IF NOT EXISTS profile_my_list (
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  media_item_id UUID NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (profile_id, media_item_id)
);

CREATE TABLE IF NOT EXISTS profile_switch_requests (
  id UUID PRIMARY KEY,
  household_id UUID NOT NULL REFERENCES households(id),
  profile_id UUID NOT NULL REFERENCES profiles(id),
  device_name TEXT,
  tv_device_id UUID,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS private_playback_grants (
  id UUID PRIMARY KEY,
  household_id UUID NOT NULL REFERENCES households(id),
  profile_id UUID REFERENCES profiles(id),
  tv_device_id UUID REFERENCES devices(id),
  media_item_id UUID REFERENCES media_items(id),
  media_source_id UUID,
  attempt_id TEXT NOT NULL,
  token_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'consumed', 'expired', 'denied')),
  approved_by_user_id UUID REFERENCES users(id),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  lan_pass_hash TEXT,
  lan_pass_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ppg_attempt ON private_playback_grants (attempt_id);
CREATE INDEX IF NOT EXISTS idx_ppg_lan_pass ON private_playback_grants (lan_pass_hash);

CREATE TABLE IF NOT EXISTS watch_progress (
  profile_id UUID NOT NULL REFERENCES profiles(id),
  media_item_id UUID NOT NULL REFERENCES media_items(id),
  position_seconds DOUBLE PRECISION NOT NULL,
  duration_seconds DOUBLE PRECISION,
  state TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (profile_id, media_item_id)
);

CREATE TABLE IF NOT EXISTS tv_commands (
  id UUID PRIMARY KEY,
  household_id UUID NOT NULL REFERENCES households(id),
  command TEXT NOT NULL,
  payload TEXT,
  target_device_id UUID REFERENCES devices(id),
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  rejection_reason TEXT,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 seconds'),
  delivery_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tv_command_pending
  ON tv_commands (target_device_id, created_at)
  WHERE completed_at IS NULL AND rejected_at IS NULL;

CREATE TABLE IF NOT EXISTS source_tombstones (
  household_id UUID NOT NULL REFERENCES households(id),
  stable_source_key TEXT NOT NULL,
  media_item_id UUID REFERENCES media_items(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('hidden', 'deleting', 'deleted')),
  chat_id BIGINT,
  message_ids BIGINT[] NOT NULL DEFAULT '{}',
  high_water_message_id BIGINT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (household_id, stable_source_key)
);

CREATE TABLE IF NOT EXISTS telegram_links (
  household_id UUID PRIMARY KEY REFERENCES households(id),
  telegram_user_id BIGINT NOT NULL,
  display_name TEXT NOT NULL,
  library_chat_id BIGINT NOT NULL,
  linked_by_device_id UUID REFERENCES devices(id),
  two_step BOOLEAN,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS telegram_tv_logins (
  id UUID PRIMARY KEY,
  household_id UUID NOT NULL REFERENCES households(id),
  tv_device_id UUID NOT NULL REFERENCES devices(id),
  login_link TEXT,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'approved', 'denied', 'failed', 'expired')),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS telegram_tv_logins_household_state
  ON telegram_tv_logins (household_id, state);

CREATE TABLE IF NOT EXISTS telegram_tv_state (
  tv_device_id UUID PRIMARY KEY REFERENCES devices(id),
  logout_required BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS telegram_tv_sessions (
  tv_device_id UUID PRIMARY KEY REFERENCES devices(id),
  household_id UUID NOT NULL REFERENCES households(id),
  telegram_session_id TEXT NOT NULL,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  sign_out_at TIMESTAMPTZ,
  terminated_at TIMESTAMPTZ,
  outcome TEXT,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS telegram_phone_logins (
  id UUID PRIMARY KEY,
  household_id UUID NOT NULL REFERENCES households(id),
  tv_device_id UUID NOT NULL REFERENCES devices(id),
  phone_device_id UUID REFERENCES devices(id),
  login_link TEXT,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'approved', 'denied', 'failed', 'expired')),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS telegram_phone_logins_tv_state
  ON telegram_phone_logins (tv_device_id, state);

CREATE TABLE IF NOT EXISTS telegram_tv_password_requests (
  id UUID PRIMARY KEY,
  household_id UUID NOT NULL REFERENCES households(id),
  tv_device_id UUID NOT NULL REFERENCES devices(id),
  tv_public_key TEXT NOT NULL,
  hint TEXT NOT NULL DEFAULT '',
  sealed TEXT,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'sealed', 'delivered', 'cancelled', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS telegram_tv_password_requests_tv_state
  ON telegram_tv_password_requests (tv_device_id, state);

ALTER TABLE media_items
  ADD COLUMN IF NOT EXISTS user_metadata_fields TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  ADD COLUMN IF NOT EXISTS metadata_revision INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS metadata_edit_id UUID;

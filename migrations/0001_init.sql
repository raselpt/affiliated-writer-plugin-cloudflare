-- licenses / activations
CREATE TABLE IF NOT EXISTS licenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  key TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  max_activations INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT,        -- ISO date
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id INTEGER NOT NULL,
  site_url TEXT NOT NULL,
  site_hash TEXT NOT NULL,
  wp_version TEXT,
  plugin_version TEXT,
  activated_at TEXT NOT NULL,
  deactivated_at TEXT,
  last_check_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  UNIQUE (license_id, site_hash)
);

-- releases & tokens
CREATE TABLE IF NOT EXISTS releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,
  version TEXT NOT NULL,
  key_path TEXT,          -- R2 object key (recommended)
  zip_url TEXT,           -- optional external URL
  changelog TEXT,
  signature TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (slug, version)
);

CREATE TABLE IF NOT EXISTS update_tokens (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  version TEXT NOT NULL,
  license_id INTEGER NOT NULL,
  site_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

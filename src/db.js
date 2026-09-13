import pg from 'pg';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway's internal Postgres URL (postgres.railway.internal) does NOT support SSL and errors if you force it.
  // Only enable SSL when explicitly asked (e.g. using the public proxy URL).
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

export const q = (text, params) => pool.query(text, params);

export async function migrate() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set — add the Postgres plugin and reference its DATABASE_URL in this service\'s variables');
  await q(`
    CREATE TABLE IF NOT EXISTS locations (
      location_id   TEXT PRIMARY KEY,
      name          TEXT,
      pit_token     TEXT,                 -- Private Integration Token (option A)
      oauth_token   TEXT,                 -- minted location token (option B)
      oauth_expires TIMESTAMPTZ,
      created_at    TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id            SERIAL PRIMARY KEY,
      location_id   TEXT NOT NULL REFERENCES locations(location_id),
      sources       TEXT[] NOT NULL,      -- which crawlers to run
      status        TEXT NOT NULL DEFAULT 'queued',  -- queued|running|done|failed
      progress      JSONB NOT NULL DEFAULT '{}',     -- per-source cursors + counters, for resume
      error         TEXT,
      created_at    TIMESTAMPTZ DEFAULT now(),
      started_at    TIMESTAMPTZ,
      finished_at   TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS files (
      id                SERIAL PRIMARY KEY,
      location_id       TEXT NOT NULL,
      job_id            INT,
      source            TEXT NOT NULL,     -- contact_field|opportunity_field|conversation|recording|form|survey|media|document
      contact_id        TEXT,
      opportunity_id    TEXT,
      conversation_id   TEXT,
      message_id        TEXT,
      submission_id     TEXT,
      document_id       TEXT,
      field_id          TEXT,
      field_name        TEXT,
      original_filename TEXT,
      mime_type         TEXT,
      size_bytes        BIGINT,
      source_url        TEXT NOT NULL,
      r2_key            TEXT,
      status            TEXT NOT NULL DEFAULT 'pending',  -- pending|done|failed|skipped
      error             TEXT,
      downloaded_at     TIMESTAMPTZ,
      created_at        TIMESTAMPTZ DEFAULT now(),
      UNIQUE (location_id, source_url)     -- idempotent re-runs
    );
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS since TIMESTAMPTZ;   -- incremental: only contacts updated after this
    CREATE INDEX IF NOT EXISTS files_loc_status ON files(location_id, status);
    CREATE INDEX IF NOT EXISTS files_contact ON files(location_id, contact_id);

    -- Contact records captured during the contact_fields crawl so packages are self-contained.
    CREATE TABLE IF NOT EXISTS contacts (
      location_id  TEXT NOT NULL,
      contact_id   TEXT NOT NULL,
      first_name   TEXT, last_name TEXT, email TEXT, phone TEXT, company TEXT,
      address      TEXT, city TEXT, state TEXT, postal_code TEXT,
      tags         TEXT[],
      date_added   TIMESTAMPTZ,
      custom       JSONB NOT NULL DEFAULT '{}',   -- non-file custom fields {fieldName: value}
      file_count   INT NOT NULL DEFAULT 0,
      updated_at   TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (location_id, contact_id)
    );

    -- Randomised, non-overlapping chunks of contacts + their files, for splitting across reps.
    CREATE TABLE IF NOT EXISTS packages (
      id             SERIAL PRIMARY KEY,
      location_id    TEXT NOT NULL,
      label          TEXT,
      requested_size INT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'queued',   -- queued|running|done|failed
      contact_count  INT DEFAULT 0,
      file_count     INT DEFAULT 0,
      r2_prefix      TEXT,
      progress       JSONB NOT NULL DEFAULT '{}',
      error          TEXT,
      created_at     TIMESTAMPTZ DEFAULT now(),
      finished_at    TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS package_contacts (
      package_id   INT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
      location_id  TEXT NOT NULL,
      contact_id   TEXT NOT NULL,
      PRIMARY KEY (package_id, contact_id),
      UNIQUE (location_id, contact_id)     -- a contact can only ever be in one package
    );
    CREATE INDEX IF NOT EXISTS files_job ON files(job_id);

    -- ---------- usage analytics ----------
    CREATE TABLE IF NOT EXISTS users (
      location_id TEXT NOT NULL, user_id TEXT NOT NULL,
      name TEXT, email TEXT, role TEXT, type TEXT, updated_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (location_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      location_id TEXT NOT NULL, message_id TEXT NOT NULL,
      conversation_id TEXT, contact_id TEXT, user_id TEXT,
      direction TEXT,            -- inbound|outbound
      channel TEXT,              -- SMS|EMAIL|CALL|VOICEMAIL|WHATSAPP|FB|IG|LIVE_CHAT|GMB|OTHER
      status TEXT, call_duration INT, date_added TIMESTAMPTZ,
      PRIMARY KEY (location_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS messages_loc_date ON messages(location_id, date_added);
    CREATE INDEX IF NOT EXISTS messages_loc_user ON messages(location_id, user_id);
    CREATE TABLE IF NOT EXISTS opportunities (
      location_id TEXT NOT NULL, opportunity_id TEXT NOT NULL,
      contact_id TEXT, assigned_to TEXT, pipeline_id TEXT, stage_id TEXT, status TEXT,
      monetary_value NUMERIC, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, status_changed_at TIMESTAMPTZ,
      PRIMARY KEY (location_id, opportunity_id)
    );
    CREATE INDEX IF NOT EXISTS opps_loc_created ON opportunities(location_id, created_at);
    CREATE TABLE IF NOT EXISTS appointments (
      location_id TEXT NOT NULL, event_id TEXT NOT NULL,
      contact_id TEXT, user_id TEXT, calendar_id TEXT, status TEXT, start_time TIMESTAMPTZ, created_at TIMESTAMPTZ,
      PRIMARY KEY (location_id, event_id)
    );
    CREATE INDEX IF NOT EXISTS appts_loc_start ON appointments(location_id, start_time);
    ALTER TABLE locations ADD COLUMN IF NOT EXISTS report_token TEXT UNIQUE;
    CREATE TABLE IF NOT EXISTS events (          -- webhook audit stream from the marketplace app
      id BIGSERIAL PRIMARY KEY, location_id TEXT NOT NULL, event_type TEXT NOT NULL,
      user_id TEXT, contact_id TEXT, object_id TEXT, occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(), payload JSONB
    );
    CREATE INDEX IF NOT EXISTS events_loc_time ON events(location_id, occurred_at);
    CREATE INDEX IF NOT EXISTS events_loc_user ON events(location_id, user_id, event_type);
    ALTER TABLE files ADD COLUMN IF NOT EXISTS cdn_url TEXT;
    ALTER TABLE files ADD COLUMN IF NOT EXISTS uploaded_at TIMESTAMPTZ;   -- Last-Modified from GHL storage ≈ upload time
    CREATE INDEX IF NOT EXISTS files_loc_uploaded ON files(location_id, uploaded_at);
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS date_updated TIMESTAMPTZ;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS assigned_to TEXT;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS created_by_user TEXT;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS source TEXT;
  `);
  // One-time cleanup: recordings that 422'd are calls with no recording, not failures.
  await q(`UPDATE files SET status='skipped', error='no recording' WHERE source='recording' AND status='failed' AND error LIKE 'HTTP 422%'`);
}

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
  `);
}

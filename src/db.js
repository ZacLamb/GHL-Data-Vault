import pg from 'pg';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : undefined,
});

export const q = (text, params) => pool.query(text, params);

export async function migrate() {
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
    CREATE INDEX IF NOT EXISTS files_job ON files(job_id);
  `);
}

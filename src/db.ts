import { Pool } from "pg";
import { config } from "./config";

export const pool = new Pool({ connectionString: config.databaseUrl });

export async function initDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS documents (
      id            TEXT PRIMARY KEY,
      filename      TEXT NOT NULL,
      document_type TEXT NOT NULL DEFAULT 'unknown',
      status        TEXT NOT NULL DEFAULT 'processing',
      raw_text      TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS extractions (
      id              SERIAL PRIMARY KEY,
      document_id     TEXT REFERENCES documents(id),
      data            JSONB NOT NULL,
      field_confidence JSONB NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS review_items (
      id               SERIAL PRIMARY KEY,
      document_id      TEXT REFERENCES documents(id),
      field_name       TEXT NOT NULL,
      extracted_value  TEXT NOT NULL,
      confidence       FLOAT NOT NULL,
      reason           TEXT NOT NULL,
      resolved         BOOLEAN NOT NULL DEFAULT FALSE,
      corrected_value  TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

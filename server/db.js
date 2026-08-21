import pg from 'pg'
import { config } from './config.js'
import { hashPassword } from './security.js'

const { Pool } = pg
export const db = new Pool({
  connectionString: config.databaseUrl,
  max: config.databasePoolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : false,
})
db.on('error', error => console.error('[database] Koneksi idle bermasalah:', error))

export const query = (text, params = []) => db.query(text, params)
export async function one(text, params = []) {
  const result = await query(text, params)
  return result.rows[0] || null
}
export async function transaction(work) {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}

export async function initializeDatabase() {
await query(`
CREATE TABLE IF NOT EXISTS departments (
  id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS roles (
  id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  can_manage_users BOOLEAN NOT NULL DEFAULT FALSE,
  can_manage_cameras BOOLEAN NOT NULL DEFAULT FALSE,
  can_view_all BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY, username TEXT NOT NULL UNIQUE, full_name TEXT NOT NULL,
  password_hash TEXT NOT NULL, role_id BIGINT NOT NULL REFERENCES roles(id),
  department_id BIGINT REFERENCES departments(id), active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS cameras (
  id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, location TEXT NOT NULL DEFAULT '', brand TEXT NOT NULL DEFAULT '',
  stream_path TEXT NOT NULL UNIQUE, department_id BIGINT REFERENCES departments(id),
  enabled BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rtsp_source_encrypted TEXT, nvr_channel INTEGER CHECK (nvr_channel BETWEEN 1 AND 128)
);
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS rtsp_source_encrypted TEXT;
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS nvr_channel INTEGER;
DO $$ BEGIN
  ALTER TABLE cameras ADD CONSTRAINT cameras_nvr_channel_check CHECK (nvr_channel BETWEEN 1 AND 128);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE TABLE IF NOT EXISTS role_cameras (
  role_id BIGINT NOT NULL, camera_id BIGINT NOT NULL,
  PRIMARY KEY(role_id, camera_id),
  FOREIGN KEY(role_id) REFERENCES roles(id) ON DELETE CASCADE, FOREIGN KEY(camera_id) REFERENCES cameras(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id BIGINT NOT NULL, expires_at BIGINT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY, user_id BIGINT, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS recordings (
  id BIGSERIAL PRIMARY KEY, camera_id BIGINT NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL, ended_at TIMESTAMPTZ NOT NULL,
  storage_path TEXT NOT NULL UNIQUE, size_bytes BIGINT,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('recording','ready','missing','failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), CHECK (ended_at > started_at)
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_recordings_camera_time ON recordings(camera_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
`)

await query(`INSERT INTO roles (name, can_manage_users, can_manage_cameras, can_view_all) VALUES
  ('Administrator', TRUE, TRUE, TRUE), ('Supervisor', FALSE, FALSE, TRUE), ('Viewer', FALSE, FALSE, FALSE)
  ON CONFLICT (name) DO NOTHING`)
await query(`INSERT INTO departments (name, description) VALUES ('Keamanan', 'Tim keamanan kantor') ON CONFLICT (name) DO NOTHING`)

const admin = await one('SELECT id FROM users WHERE username = $1', [config.adminUsername])
if (!admin) {
  const role = await one("SELECT id FROM roles WHERE name = 'Administrator'")
  await query('INSERT INTO users (username, full_name, password_hash, role_id) VALUES ($1, $2, $3, $4)',
    [config.adminUsername, 'System Administrator', hashPassword(config.adminPassword), role.id])
  console.log(`[seed] Admin dibuat: ${config.adminUsername}. Segera ubah password default.`)
}
}

export async function audit(userId, action, detail = '') {
  await query('INSERT INTO audit_logs (user_id, action, detail) VALUES ($1, $2, $3)', [userId || null, action, detail])
}
export const config = {
  port: Number(process.env.PORT || 8080),
  databaseUrl: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/sentra_cctv',
  databasePoolMax: Number(process.env.DATABASE_POOL_MAX || 10),
  databaseSsl: process.env.DATABASE_SSL === 'true',
  sessionTtlMs: Number(process.env.SESSION_TTL_HOURS || 12) * 60 * 60 * 1000,
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'ChangeMe123!',
  mediaBase: (process.env.MEDIAMTX_WEBRTC_BASE || 'http://localhost:8889').replace(/\/$/, ''),
  production: process.env.NODE_ENV === 'production',
  secureCookies: process.env.SECURE_COOKIES === 'true',
}
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { audit, initializeDatabase, one, query, transaction } from './db.js'
import { config } from './config.js'
import { hashPassword, newSessionToken, tokenDigest, verifyPassword } from './security.js'

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function body(req) {
  const chunks = []; let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1_000_000) throw Object.assign(new Error('Payload terlalu besar'), { status: 413 })
    chunks.push(chunk)
  }
  try { return chunks.length ? JSON.parse(Buffer.concat(chunks)) : {} }
  catch { throw Object.assign(new Error('JSON tidak valid'), { status: 400 }) }
}

function sessionToken(req) {
  return req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('cctv_session='))?.split('=')[1]
}

async function currentUser(req) {
  const token = sessionToken(req)
  if (!token) return null
  return one(`SELECT u.id, u.username, u.full_name, u.active, r.name role,
    r.can_manage_users, r.can_manage_cameras, r.can_view_all, u.role_id, u.department_id
    FROM sessions s JOIN users u ON u.id=s.user_id JOIN roles r ON r.id=u.role_id
    WHERE s.token_hash=$1 AND s.expires_at>$2 AND u.active=TRUE`, [tokenDigest(token), Date.now()])
}

const clean = value => String(value || '').trim()
const routeId = (pathname, resource) => pathname.match(new RegExp(`^/api/${resource}/(\\d+)$`))?.[1]

async function api(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/health') {
    await query('SELECT 1')
    return json(res, 200, { ok: true, database: 'connected' })
  }
  if (req.method === 'POST' && url.pathname === '/api/login') {
    const input = await body(req)
    const user = await one('SELECT * FROM users WHERE username=$1 AND active=TRUE', [clean(input.username)])
    if (!user || !verifyPassword(String(input.password || ''), user.password_hash)) {
      await audit(user?.id, 'LOGIN_FAILED', clean(input.username)); return json(res, 401, { error: 'Username atau password salah' })
    }
    const token = newSessionToken()
    await query('DELETE FROM sessions WHERE expires_at<=$1', [Date.now()])
    await query('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES ($1,$2,$3)', [tokenDigest(token), user.id, Date.now() + config.sessionTtlMs])
    await audit(user.id, 'LOGIN_SUCCESS')
    res.setHeader('set-cookie', `cctv_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${config.sessionTtlMs / 1000}${config.secureCookies ? '; Secure' : ''}`)
    return json(res, 200, { ok: true })
  }

  const user = await currentUser(req)
  if (!user) return json(res, 401, { error: 'Silakan login' })
  if (req.method === 'POST' && url.pathname === '/api/logout') {
    const token = sessionToken(req); if (token) await query('DELETE FROM sessions WHERE token_hash=$1', [tokenDigest(token)])
    res.setHeader('set-cookie', 'cctv_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return json(res, 200, { ok: true })
  }
  if (req.method === 'GET' && url.pathname === '/api/me') return json(res, 200, user)

  if (req.method === 'GET' && url.pathname === '/api/cameras') {
    const sql = user.can_view_all ? `SELECT c.*, d.name department FROM cameras c LEFT JOIN departments d ON d.id=c.department_id WHERE c.enabled=TRUE ORDER BY c.name`
      : `SELECT DISTINCT c.*, d.name department FROM cameras c JOIN role_cameras rc ON rc.camera_id=c.id LEFT JOIN departments d ON d.id=c.department_id WHERE c.enabled=TRUE AND rc.role_id=$1 ORDER BY c.name`
    const { rows } = await query(sql, user.can_view_all ? [] : [user.role_id])
    return json(res, 200, rows.map(c => ({ ...c, player_url: `${config.mediaBase}/${encodeURIComponent(c.stream_path)}/` })))
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/catalog') {
    if (!user.can_manage_users && !user.can_manage_cameras) return json(res, 403, { error: 'Akses ditolak' })
    const [departments, roles, cameras, users] = await Promise.all([
      query('SELECT * FROM departments ORDER BY name'), query('SELECT * FROM roles ORDER BY name'),
      query('SELECT c.*, d.name department FROM cameras c LEFT JOIN departments d ON d.id=c.department_id ORDER BY c.name'),
      query(`SELECT u.id,u.username,u.full_name,u.active,u.role_id,u.department_id,r.name role,d.name department FROM users u JOIN roles r ON r.id=u.role_id LEFT JOIN departments d ON d.id=u.department_id ORDER BY u.username`),
    ])
    return json(res, 200, { departments: departments.rows, roles: roles.rows, cameras: cameras.rows, users: users.rows })
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/cameras') {
    if (!user.can_manage_cameras) return json(res, 403, { error: 'Akses ditolak' })
    const v = await body(req); if (!clean(v.name) || !clean(v.stream_path)) return json(res, 400, { error: 'Nama dan stream path wajib diisi' })
    const result = await one('INSERT INTO cameras(name,location,brand,stream_path,department_id) VALUES($1,$2,$3,$4,$5) RETURNING id', [clean(v.name), clean(v.location), clean(v.brand), clean(v.stream_path), v.department_id || null])
    await audit(user.id, 'CAMERA_CREATED', String(result.id)); return json(res, 201, { id: Number(result.id) })
  }
  if (req.method === 'PUT' && routeId(url.pathname, 'admin/cameras')) {
    if (!user.can_manage_cameras) return json(res, 403, { error: 'Akses ditolak' })
    const id = Number(routeId(url.pathname, 'admin/cameras')); const v = await body(req)
    if (!clean(v.name) || !clean(v.stream_path)) return json(res, 400, { error: 'Nama dan stream path wajib diisi' })
    const result = await one(`UPDATE cameras SET name=$1,location=$2,brand=$3,stream_path=$4,department_id=$5
      WHERE id=$6 RETURNING id`, [clean(v.name), clean(v.location), clean(v.brand), clean(v.stream_path), v.department_id || null, id])
    if (!result) return json(res, 404, { error: 'Kamera tidak ditemukan' })
    await audit(user.id, 'CAMERA_UPDATED', String(id)); return json(res, 200, { id })
  }
  if (req.method === 'DELETE' && routeId(url.pathname, 'admin/cameras')) {
    if (!user.can_manage_cameras) return json(res, 403, { error: 'Akses ditolak' })
    const id = Number(routeId(url.pathname, 'admin/cameras')); await query('DELETE FROM cameras WHERE id=$1', [id]); await audit(user.id, 'CAMERA_DELETED', String(id)); return json(res, 200, { ok: true })
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/users') {
    if (!user.can_manage_users) return json(res, 403, { error: 'Akses ditolak' })
    const v = await body(req); if (!clean(v.username) || !clean(v.full_name) || String(v.password || '').length < 8) return json(res, 400, { error: 'Data wajib diisi; password minimal 8 karakter' })
    const result = await one('INSERT INTO users(username,full_name,password_hash,role_id,department_id) VALUES($1,$2,$3,$4,$5) RETURNING id', [clean(v.username), clean(v.full_name), hashPassword(v.password), Number(v.role_id), v.department_id || null])
    await audit(user.id, 'USER_CREATED', String(result.id)); return json(res, 201, { id: Number(result.id) })
  }
  if (req.method === 'PUT' && url.pathname.match(/^\/api\/admin\/roles\/\d+\/cameras$/)) {
    if (!user.can_manage_users) return json(res, 403, { error: 'Akses ditolak' })
    const roleId = Number(url.pathname.split('/')[4]); const v = await body(req); const ids = [...new Set((v.camera_ids || []).map(Number).filter(Number.isInteger))]
    await transaction(async client => { await client.query('DELETE FROM role_cameras WHERE role_id=$1', [roleId]); for (const id of ids) await client.query('INSERT INTO role_cameras VALUES($1,$2)', [roleId, id]) })
    await audit(user.id, 'ROLE_CAMERAS_UPDATED', `${roleId}:${ids.join(',')}`); return json(res, 200, { ok: true })
  }
  if (req.method === 'GET' && url.pathname.match(/^\/api\/admin\/roles\/\d+\/cameras$/)) {
    if (!user.can_manage_users) return json(res, 403, { error: 'Akses ditolak' })
    const roleId = Number(url.pathname.split('/')[4]); const result = await query('SELECT camera_id FROM role_cameras WHERE role_id=$1', [roleId]); return json(res, 200, result.rows.map(x=>Number(x.camera_id)))
  }
  return json(res, 404, { error: 'Endpoint tidak ditemukan' })
}

const mime = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png' }
function staticFile(req, res, pathname) {
  const dist = path.resolve('dist'); let file = path.resolve(dist, `.${pathname}`)
  if (!file.startsWith(dist)) return json(res, 403, { error: 'Akses ditolak' })
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html')
  if (!fs.existsSync(file)) return json(res, 503, { error: 'Frontend belum dibuild. Jalankan npm run build.' })
  res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream' }); fs.createReadStream(file).pipe(res)
}

await initializeDatabase()
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  try { if (url.pathname.startsWith('/api/')) await api(req, res, url); else staticFile(req, res, url.pathname) }
  catch (error) { console.error(error); const duplicate = error.code === '23505'; json(res, error.status || (duplicate ? 409 : 500), { error: error.status ? error.message : duplicate ? 'Data sudah digunakan' : 'Terjadi kesalahan server' }) }
})
server.listen(config.port, '0.0.0.0', () => console.log(`Sentra CCTV berjalan di http://localhost:${config.port}`))
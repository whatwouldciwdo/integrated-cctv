import { db, one, query, initializeDatabase } from './db.js'
import { config } from './config.js'
import { hashPassword } from './security.js'

async function main() {
  const newPassword = process.argv[2] || config.adminPassword || 'ChangeMe123!'
  console.log(`[reset-admin] Mempersiapkan database...`)
  await initializeDatabase()

  const admin = await one('SELECT id, username FROM users WHERE username = $1', [config.adminUsername])
  if (admin) {
    await query('UPDATE users SET password_hash = $1, active = TRUE WHERE id = $2', [hashPassword(newPassword), admin.id])
    console.log(`[reset-admin] Password untuk user '${config.adminUsername}' berhasil direset!`)
    console.log(`[reset-admin] Username: ${config.adminUsername}`)
    console.log(`[reset-admin] Password: ${newPassword}`)
  } else {
    const role = await one("SELECT id FROM roles WHERE name = 'Administrator'")
    if (!role) {
      console.error('[reset-admin] Role Administrator belum ada.')
      process.exit(1)
    }
    await query('INSERT INTO users (username, full_name, password_hash, role_id, active) VALUES ($1, $2, $3, $4, TRUE)',
      [config.adminUsername, 'System Administrator', hashPassword(newPassword), role.id])
    console.log(`[reset-admin] User '${config.adminUsername}' berhasil dibuat!`)
    console.log(`[reset-admin] Password: ${newPassword}`)
  }

  // Bersihkan sessions lama agar sesi lama tidak konflik
  await query('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = $1)', [config.adminUsername])
  console.log(`[reset-admin] Sesi lama untuk '${config.adminUsername}' telah dibersihkan.`)

  await db.end()
}

main().catch(err => {
  console.error('[reset-admin] Gagal:', err.message)
  process.exit(1)
})

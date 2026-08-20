import { readFile } from 'node:fs/promises'
import { config } from './config.js'
import { initializeDatabase, one, query, transaction, db } from './db.js'
import { synchronizeMediaPaths, validateRtspSource } from './mediamtx.js'
import { encryptSecret } from './security.js'

function wisenetPaths(yaml) {
  const rows = []
  const lines = String(yaml).split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const pathMatch = lines[index].match(/^\s{2}(wisenet-[A-Za-z0-9._~-]+):(?:\s*\{\s*source:\s*([^,}\s]+))?/)
    if (!pathMatch) continue
    const source = pathMatch[2] || lines.slice(index + 1, index + 4).map(line => line.match(/^\s+source:\s*(\S+)\s*$/)?.[1]).find(Boolean)
    if (!source) throw new Error(`Source untuk ${pathMatch[1]} tidak ditemukan`)
    rows.push({ streamPath: pathMatch[1], source: validateRtspSource(source) })
  }
  return rows
}

try {
  if (process.stdin.isTTY) throw new Error('Kirim backup mediamtx.yml melalui stdin')
  const input = await readFile(0, 'utf8')
  const cameras = wisenetPaths(input)
  if (!cameras.length) throw new Error('Tidak ada path dengan prefix wisenet- pada input')

  await initializeDatabase()
  const department = await one("SELECT id FROM departments WHERE name='Keamanan'")
  await transaction(async client => {
    for (const camera of cameras) {
      const number = camera.streamPath.replace(/^wisenet-/, '')
      await client.query(`INSERT INTO cameras
        (name,location,brand,stream_path,department_id,enabled,rtsp_source_encrypted)
        VALUES($1,$2,$3,$4,$5,TRUE,$6)
        ON CONFLICT(stream_path) DO UPDATE SET
          name=EXCLUDED.name,location=EXCLUDED.location,brand=EXCLUDED.brand,
          department_id=EXCLUDED.department_id,enabled=TRUE,rtsp_source_encrypted=EXCLUDED.rtsp_source_encrypted`,
      [`Wisenet ${number}`, new URL(camera.source).hostname, 'Wisenet', camera.streamPath, department?.id || null, encryptSecret(camera.source, config.rtspEncryptionKey)])
    }
  })

  const synced = await synchronizeMediaPaths()
  const { rows } = await query(`SELECT stream_path FROM cameras
    WHERE stream_path LIKE 'wisenet-%' AND rtsp_source_encrypted IS NOT NULL ORDER BY stream_path`)
  console.log(`[import] ${cameras.length} path Wisenet dibaca; ${rows.length} kamera tersimpan; ${synced} total path database disinkronkan`)
  console.log(rows.map(row => row.stream_path).join(', '))
} catch (error) {
  console.error(`[import] Gagal: ${error.message}`)
  process.exitCode = 1
} finally {
  await db.end()
}
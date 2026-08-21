import { config } from './config.js'
import { decryptSecret } from './security.js'
import { query } from './db.js'

export function validateStreamPath(value) {
  const streamPath = String(value || '').trim()
  if (!/^[A-Za-z0-9._~-]+$/.test(streamPath)) {
    throw Object.assign(new Error('Stream path hanya boleh berisi huruf, angka, titik, underscore, tilde, atau tanda hubung'), { status: 400 })
  }
  return streamPath
}

function validateRtspSource(value) {
  let url
  try { url = new URL(String(value || '')) } catch { throw Object.assign(new Error('RTSP Source URL tidak valid'), { status: 400 }) }
  if (!['rtsp:', 'rtsps:'].includes(url.protocol) || !url.hostname) {
    throw Object.assign(new Error('RTSP Source URL harus menggunakan rtsp:// atau rtsps://'), { status: 400 })
  }
  return url.toString()
}

async function mediaRequest(method, route, payload, accepted = [200]) {
  let response
  try {
    response = await fetch(`${config.mediaApiBase}${route}`, {
      method,
      headers: payload ? { 'content-type': 'application/json' } : undefined,
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(5_000),
    })
  } catch (error) {
    throw Object.assign(new Error(`MediaMTX Control API tidak dapat dijangkau (${error.name === 'TimeoutError' ? 'timeout' : 'koneksi gagal'})`), { status: 502 })
  }
  if (!accepted.includes(response.status)) {
    throw Object.assign(new Error(`MediaMTX menolak konfigurasi path (HTTP ${response.status})`), { status: 502, mediaStatus: response.status })
  }
  return response
}

export async function upsertMediaPath(streamPath, source) {
  streamPath = validateStreamPath(streamPath)
  // Docker/NAT dan jaringan CCTV sering kehilangan fragmen RTP UDP berukuran besar.
  // Interleaved RTSP-over-TCP menjaga urutan paket dan mencegah invalid FU-A frames.
  const payload = { source: validateRtspSource(source), sourceOnDemand: true, rtspTransport: 'tcp' }
  const routeName = encodeURIComponent(streamPath)
  const patched = await mediaRequest('PATCH', `/v3/config/paths/patch/${routeName}`, payload, [200, 404])
  if (patched.status === 404) await mediaRequest('POST', `/v3/config/paths/add/${routeName}`, payload)
}

export async function upsertPlaybackPath(streamPath, source) {
  streamPath = validateStreamPath(streamPath)
  const payload = { source: validateRtspSource(source), sourceOnDemand: true, rtspTransport: 'tcp' }
  const routeName = encodeURIComponent(streamPath)
  const patched = await mediaRequest('PATCH', `/v3/config/paths/patch/${routeName}`, payload, [200, 404])
  if (patched.status === 404) await mediaRequest('POST', `/v3/config/paths/add/${routeName}`, payload)
}

export async function deleteMediaPath(streamPath) {
  streamPath = validateStreamPath(streamPath)
  await mediaRequest('DELETE', `/v3/config/paths/delete/${encodeURIComponent(streamPath)}`, null, [200, 404])
}

export async function synchronizeMediaPaths() {
  const { rows } = await query(`SELECT stream_path, rtsp_source_encrypted FROM cameras
    WHERE enabled=TRUE AND rtsp_source_encrypted IS NOT NULL ORDER BY id`)
  for (const camera of rows) {
    const source = decryptSecret(camera.rtsp_source_encrypted, config.rtspEncryptionKey)
    await upsertMediaPath(camera.stream_path, source)
  }
  return rows.length
}

export function scheduleMediaPathSynchronization(delays = [0, 2_000, 5_000, 10_000]) {
  let completed = false
  for (const delay of delays) {
    setTimeout(async () => {
      if (completed) return
      try {
        const count = await synchronizeMediaPaths()
        completed = true
        console.log(`[mediamtx] ${count} path dari database berhasil disinkronkan`)
      } catch (error) {
        console.error(`[mediamtx] Sinkronisasi gagal${delay ? ` setelah ${delay / 1000} detik` : ''}: ${error.message}`)
      }
    }, delay)
  }
}

export { validateRtspSource }
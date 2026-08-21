import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { config } from './config.js'

const httpError = (message, status = 502) => Object.assign(new Error(message), { status })
const md5 = value => createHash('md5').update(value).digest('hex')
const xmlEscape = value => String(value).replace(/[<>&'\"]/g, char => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', "'":'&apos;', '"':'&quot;' })[char])
const xmlDecode = value => String(value || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
const tag = (xml, name) => xmlDecode(xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1]?.trim() || '')

function requireNvr() {
  if (!config.nvrBaseUrl || !config.nvrUsername || !config.nvrPassword) throw httpError('Integrasi NVR belum dikonfigurasi', 503)
  try { new URL(config.nvrBaseUrl) } catch { throw httpError('NVR_BASE_URL tidak valid', 503) }
  if (!Number.isInteger(config.nvrRtspPort) || config.nvrRtspPort < 1 || config.nvrRtspPort > 65535) throw httpError('NVR_RTSP_PORT tidak valid', 503)
}

function digestValues(challenge) {
  const result = {}
  for (const match of challenge.replace(/^Digest\s+/i, '').matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) result[match[1]] = match[2] ?? match[3]
  return result
}

async function digestFetch(route, { method = 'GET', body, headers = {} } = {}) {
  requireNvr()
  const url = new URL(route, `${config.nvrBaseUrl}/`)
  const options = { method, headers, body, signal: AbortSignal.timeout(15_000) }
  let response
  try { response = await fetch(url, options) } catch (error) { throw httpError(`NVR tidak dapat dijangkau (${error.name === 'TimeoutError' ? 'timeout' : 'koneksi gagal'})`) }
  if (response.status !== 401) return response
  const challenge = response.headers.get('www-authenticate') || ''
  if (!/^Digest/i.test(challenge)) throw httpError('NVR tidak menawarkan Digest Authentication')
  const auth = digestValues(challenge)
  const uri = `${url.pathname}${url.search}`
  const qop = String(auth.qop || '').split(',').map(x => x.trim()).find(x => x === 'auth')
  const nc = '00000001', cnonce = randomBytes(12).toString('hex')
  const ha1 = md5(`${config.nvrUsername}:${auth.realm}:${config.nvrPassword}`)
  const ha2 = md5(`${method}:${uri}`)
  const digest = qop ? md5(`${ha1}:${auth.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${auth.nonce}:${ha2}`)
  const fields = [`username="${config.nvrUsername}"`, `realm="${auth.realm}"`, `nonce="${auth.nonce}"`, `uri="${uri}"`, `response="${digest}"`, `algorithm=${auth.algorithm || 'MD5'}`]
  if (auth.opaque) fields.push(`opaque="${auth.opaque}"`)
  if (qop) fields.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`)
  try { return await fetch(url, { ...options, headers: { ...headers, authorization: `Digest ${fields.join(', ')}` } }) }
  catch (error) { throw httpError(`NVR tidak dapat dijangkau (${error.name === 'TimeoutError' ? 'timeout' : 'koneksi gagal'})`) }
}

function validTime(value, field) {
  const date = new Date(value)
  if (!value || Number.isNaN(date.getTime())) throw httpError(`${field} tidak valid`, 400)
  return date
}

export function validatePlaybackRange(startValue, endValue) {
  const start = validTime(startValue, 'Waktu mulai'), end = validTime(endValue, 'Waktu selesai')
  const duration = end - start
  if (duration <= 0) throw httpError('Waktu selesai harus setelah waktu mulai', 400)
  if (duration > 48 * 60 * 60 * 1000) throw httpError('Rentang pencarian maksimal 48 jam', 400)
  if (end > new Date(Date.now() + 5 * 60 * 1000)) throw httpError('Waktu selesai tidak boleh di masa depan', 400)
  return { start, end }
}

function trackId(channel) {
  const value = Number(channel)
  if (!Number.isInteger(value) || value < 1 || value > 128) throw httpError('Channel NVR kamera belum valid', 400)
  return value * 100 + 1
}

export async function searchRecordings(channel, startValue, endValue) {
  const { start, end } = validatePlaybackRange(startValue, endValue)
  const track = trackId(channel)
  const payload = `<?xml version="1.0" encoding="UTF-8"?>
<CMSearchDescription version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
<searchID>${randomUUID()}</searchID><trackList><trackID>${track}</trackID></trackList>
<timeSpanList><timeSpan><startTime>${xmlEscape(start.toISOString())}</startTime><endTime>${xmlEscape(end.toISOString())}</endTime></timeSpan></timeSpanList>
<maxResults>100</maxResults><searchResultPostion>0</searchResultPostion>
<metadataList><metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor></metadataList>
</CMSearchDescription>`
  const response = await digestFetch('/ISAPI/ContentMgmt/search', { method: 'POST', body: payload, headers: { 'content-type': 'application/xml' } })
  const xml = await response.text()
  if (!response.ok) throw httpError(`Pencarian rekaman ditolak NVR (HTTP ${response.status})`, response.status === 401 || response.status === 403 ? 502 : response.status)
  if (tag(xml, 'responseStatusStrg').toUpperCase() !== 'OK') throw httpError(`NVR gagal mencari rekaman (${tag(xml, 'responseStatusStrg') || 'respons tidak dikenal'})`)
  return [...xml.matchAll(/<searchMatchItem>([\s\S]*?)<\/searchMatchItem>/gi)].map(([, item], index) => ({
    id: `${track}-${index}-${tag(item, 'startTime')}`,
    track_id: track,
    start_time: tag(item, 'startTime'),
    end_time: tag(item, 'endTime'),
    codec: tag(item, 'codecType'),
    record_type: tag(item, 'metadataDescriptor').split('/').pop() || 'recording',
  })).filter(item => item.start_time && item.end_time)
}

export async function listInputProxyChannels() {
  const response = await digestFetch('/ISAPI/ContentMgmt/InputProxy/channels')
  const xml = await response.text()
  if (!response.ok) throw httpError(`Daftar channel ditolak NVR (HTTP ${response.status})`, response.status === 401 || response.status === 403 ? 502 : response.status)
  const channels = [...xml.matchAll(/<InputProxyChannel(?:\s[^>]*)?>([\s\S]*?)<\/InputProxyChannel>/gi)].map(([, item]) => ({
    channel: Number(tag(item, 'id')),
    ip_address: tag(item, 'ipAddress').toLowerCase(),
    name: tag(item, 'name'),
  })).filter(item => Number.isInteger(item.channel) && item.channel >= 1 && item.channel <= 128 && item.ip_address)
  if (!channels.length) throw httpError('NVR tidak mengembalikan InputProxy channel beserta alamat IP')
  return channels
}

const hikvisionTime = date => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')

export function playbackRtspUrl(channel, startValue, endValue) {
  requireNvr()
  const { start, end } = validatePlaybackRange(startValue, endValue)
  const base = new URL(config.nvrBaseUrl)
  const hostname = config.nvrRtspHost || base.hostname
  const url = new URL(`rtsp://${hostname}:${config.nvrRtspPort}/Streaming/tracks/${trackId(channel)}/`)
  url.username = config.nvrUsername
  url.password = config.nvrPassword
  url.searchParams.set('starttime', hikvisionTime(start))
  url.searchParams.set('endtime', hikvisionTime(end))
  return url.toString()
}
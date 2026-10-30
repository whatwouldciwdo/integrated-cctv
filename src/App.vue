<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'

// ─── Timezone helper: WIB = UTC+7 ──────────────────────────────────────────
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000

/** Format ISO string (from NVR) → tampilkan sebagai WIB, tanpa shifting */
function dateToWIB(value) {
  // NVR returns ISO UTC string, browser Intl will auto-convert to local tz.
  // We force Asia/Jakarta so it always shows WIB regardless of client tz.
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(value))
}

/** datetime-local input value (local browser) → WIB ISO string for API */
function inputToISO(localStr) {
  // Treat input value as WIB time, convert to UTC for API
  const localMs = new Date(localStr).getTime()
  return new Date(localMs - WIB_OFFSET_MS + new Date().getTimezoneOffset() * 60_000).toISOString()
}

/** Date → datetime-local string in WIB */
function dateToLocalInput(date) {
  return new Date(date.getTime() + WIB_OFFSET_MS - date.getTimezoneOffset() * 60_000)
    .toISOString().slice(0, 16)
}

const dateLabel = value => dateToWIB(value)

// ─── State ──────────────────────────────────────────────────────────────────
const me = ref(null), cameras = ref([]), catalog = reactive({ cameras: [], users: [], roles: [], departments: [] })
const loading = ref(true), notice = ref(''), error = ref(''), page = ref('dashboard'), grid = ref(16), offset = ref(0), search = ref(''), selectedDepartment = ref('')
const credentials = reactive({ username: 'admin', password: '' })
const cameraForm = reactive({ name: '', location: '', brand: '', stream_path: '', department_id: '', rtsp_source: '', nvr_channel: '' })
const editingCameraId = ref(null)
const userForm = reactive({ username: '', full_name: '', password: '', role_id: '', department_id: '' })
const deptForm = reactive({ name: '', description: '' })
const permissionRole = ref(''), permissionIds = ref([])

// ─── Playback speeds ────────────────────────────────────────────────────────
const playbackSpeeds = [
  { label: '0.25x', value: 0.25, title: 'Slow motion 0.25x' },
  { label: '0.5x',  value: 0.5,  title: 'Slow motion 0.5x' },
  { label: '1x',    value: 1,    title: 'Kecepatan normal (1x)' },
  { label: '2x',    value: 2,    title: 'Percepatan 2x' },
  { label: '4x',    value: 4,    title: 'Percepatan 4x' },
  { label: '6x',    value: 6,    title: 'Percepatan 6x' },
  { label: '8x',    value: 8,    title: 'Percepatan 8x' },
]

// ─── Playback page state ─────────────────────────────────────────────────────
const playback = reactive({
  camera_id: '', start: '', end: '',
  recordings: [], player_url: '', stream_path: '',
  scale: 1, loading: false, changingSpeed: false, active: null,
  // Scrubber
  scrubberValue: 0,   // 0-1000
  scrubberDragging: false,
  activeSeekStart: null, // Date object: actual playback start_time of current seek
})

// ─── Quick Playback (Live View modal) ────────────────────────────────────────
const qp = reactive({
  visible: false,
  camera: null,          // camera object
  player_url: '',
  stream_path: '',
  scale: 1,
  loading: false,
  changingSpeed: false,
  active: null,          // recording segment being played
  recordings: [],
  listLoading: false,
  scrubberValue: 0,
  scrubberDragging: false,
  activeSeekStart: null,
  // Search range (last 2 hours)
  start: '',
  end: '',
})

// ─── Sidebar collapse ────────────────────────────────────────────────────────
const sidebarCollapsed = ref(typeof localStorage !== 'undefined' && localStorage.getItem('sidebar_collapsed') === 'true')
function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value
  try { localStorage.setItem('sidebar_collapsed', sidebarCollapsed.value ? 'true' : 'false') } catch {}
}
const nvrConnectedCount = computed(() => catalog.cameras.filter(c => c.nvr_channel).length)

// ─── Open playback page for a camera ─────────────────────────────────────────
function openCameraPlayback(cameraId) {
  playback.camera_id = cameraId
  resetPlaybackRange()
  page.value = 'playback'
  findRecordings()
}

// ─── Fullscreen ───────────────────────────────────────────────────────────────
const isFullscreen = ref(false)

function syncFullscreenClasses(active) {
  if (typeof document === 'undefined') return
  if (active) {
    document.documentElement.classList.add('fullscreen-mode')
    document.body.classList.add('fullscreen-mode')
  } else {
    document.documentElement.classList.remove('fullscreen-mode')
    document.body.classList.remove('fullscreen-mode')
  }
}

function handleFullscreenChange() {
  const isApiFs = Boolean(document.fullscreenElement)
  const isScreenFs = Math.abs(window.innerHeight - screen.height) <= 6 && Math.abs(window.innerWidth - screen.width) <= 6
  const isMediaFs = window.matchMedia?.('(display-mode: fullscreen)')?.matches ?? false
  const active = isApiFs || isScreenFs || isMediaFs
  isFullscreen.value = active
  syncFullscreenClasses(active)
}

async function toggleFullscreen() {
  if (page.value !== 'dashboard') page.value = 'dashboard'
  try {
    if (!document.fullscreenElement && !isFullscreen.value) {
      if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen()
      isFullscreen.value = true
    } else {
      if (document.fullscreenElement && document.exitFullscreen) await document.exitFullscreen()
      isFullscreen.value = false
    }
  } catch { isFullscreen.value = !isFullscreen.value }
  syncFullscreenClasses(isFullscreen.value)
  setTimeout(handleFullscreenChange, 100)
}

function handleKeydown(e) {
  if (e.key === 'Escape') {
    if (qp.visible) { closeQuickPlayback(); return }
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    isFullscreen.value = false
    syncFullscreenClasses(false)
    setTimeout(handleFullscreenChange, 120)
  } else if (e.key === 'F11') {
    setTimeout(handleFullscreenChange, 120)
    setTimeout(handleFullscreenChange, 400)
  } else if (isFullscreen.value && page.value === 'dashboard') {
    if (e.key === 'ArrowRight' || e.key === 'PageDown') next(1)
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') next(-1)
  }
}

// ─── Playback range helpers ───────────────────────────────────────────────────
function resetPlaybackRange() {
  const end = new Date(), start = new Date(end.getTime() - 2 * 60 * 60 * 1000)
  playback.start = dateToLocalInput(start)
  playback.end   = dateToLocalInput(end)
}
resetPlaybackRange()

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
async function request(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', headers: { 'content-type': 'application/json', ...(options.headers || {}) }, ...options })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'Permintaan gagal')
  return data
}
function flash(message, bad = false) { (bad ? error : notice).value = message; setTimeout(() => (bad ? error : notice).value = '', 3500) }

// ─── Bootstrap / Auth ─────────────────────────────────────────────────────────
const loginLoading = ref(false)

async function bootstrap() {
  loading.value = true
  try {
    me.value = await request('/api/me')
  } catch {
    me.value = null
    return
  } finally {
    loading.value = false
  }

  try {
    await loadCameras()
    if (isAdmin.value) await loadCatalog()
  } catch (e) {
    flash(`Gagal memuat katalog: ${e.message}`, true)
  }
}

async function login() {
  if (loginLoading.value) return
  loginLoading.value = true
  try {
    await request('/api/login', { method: 'POST', body: JSON.stringify(credentials) })
    credentials.password = ''
    await bootstrap()
  } catch (e) {
    flash(e.message || 'Login gagal', true)
  } finally {
    loginLoading.value = false
  }
}
async function logout() { await request('/api/logout', { method: 'POST' }); me.value = null; cameras.value = [] }
async function loadCameras() { cameras.value = await request('/api/cameras'); offset.value = 0 }
async function loadCatalog() { Object.assign(catalog, await request('/api/admin/catalog')) }
async function syncNvrChannels() {
  try {
    const result = await request('/api/admin/nvr/sync-channels', { method: 'POST' })
    await Promise.all([loadCatalog(), loadCameras()])
    const detail = result.unmatched.length || result.ambiguous.length ? `; ${result.unmatched.length} tidak ditemukan, ${result.ambiguous.length} IP duplikat` : ''
    flash(`${result.matched.length} kamera cocok dari ${result.nvr_channels} channel NVR${detail}`, result.matched.length === 0)
  } catch (e) { flash(e.message, true) }
}
const isAdmin = computed(() => me.value?.can_manage_users || me.value?.can_manage_cameras)

// ─── Camera filters & pagination ──────────────────────────────────────────────
const availableDepartments = computed(() => {
  const depts = new Set()
  cameras.value.forEach(c => { if (c.department) depts.add(c.department) })
  return Array.from(depts).sort()
})
const filtered = computed(() => {
  const q = search.value.toLowerCase().trim()
  return cameras.value.filter(c => {
    const matchesSearch = !q || [c.name, c.location, c.department, c.brand].some(v => String(v || '').toLowerCase().includes(q))
    const matchesDept = !selectedDepartment.value || (c.department || 'Umum') === selectedDepartment.value
    return matchesSearch && matchesDept
  })
})
const visible = computed(() => filtered.value.slice(offset.value, offset.value + grid.value))
const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / grid.value)))
const currentPage = computed(() => Math.floor(offset.value / grid.value) + 1)

// ─── Auto tour ────────────────────────────────────────────────────────────────
const savedInterval = typeof localStorage !== 'undefined' ? Number(localStorage.getItem('cctv_autotour_sec')) : 10
const autoTourInterval = ref(savedInterval >= 2 ? savedInterval : 10)
const autoTourActive = ref(false)
let autoTourTimer = null

function nextLoop(delta = 1) {
  if (pages.value <= 1) return
  let nextOffset = offset.value + delta * grid.value
  const maxOffset = (pages.value - 1) * grid.value
  if (nextOffset > maxOffset) nextOffset = 0
  else if (nextOffset < 0) nextOffset = maxOffset
  offset.value = nextOffset
  if (autoTourActive.value) restartAutoTourTimer()
}
function startAutoTour() { stopAutoTour(); autoTourActive.value = true; restartAutoTourTimer() }
function restartAutoTourTimer() {
  if (autoTourTimer) clearInterval(autoTourTimer)
  const sec = Math.max(2, Math.round(Number(autoTourInterval.value) || 10))
  autoTourTimer = setInterval(() => { if (pages.value > 1 && page.value === 'dashboard') nextLoop(1) }, sec * 1000)
}
function stopAutoTour() { autoTourActive.value = false; if (autoTourTimer) { clearInterval(autoTourTimer); autoTourTimer = null } }
function toggleAutoTour() { autoTourActive.value ? stopAutoTour() : startAutoTour() }
function onIntervalChange() {
  let val = Math.round(Number(autoTourInterval.value))
  if (isNaN(val) || val < 2) val = 5
  if (val > 3600) val = 3600
  autoTourInterval.value = val
  try { localStorage.setItem('cctv_autotour_sec', String(val)) } catch {}
  if (autoTourActive.value) restartAutoTourTimer()
}
function setGrid(value) { grid.value = value; offset.value = 0; if (autoTourActive.value) restartAutoTourTimer() }
function next(delta) { nextLoop(delta) }

// ─── Admin CRUD ───────────────────────────────────────────────────────────────
function resetCameraForm() { Object.keys(cameraForm).forEach(k => cameraForm[k] = ''); editingCameraId.value = null }
function editCamera(camera) {
  editingCameraId.value = camera.id
  Object.assign(cameraForm, { name: camera.name, location: camera.location || '', brand: camera.brand || '', stream_path: camera.stream_path, department_id: camera.department_id || '', rtsp_source: '', nvr_channel: camera.nvr_channel || '' })
  window.scrollTo({ top: 0, behavior: 'smooth' })
}
async function saveCamera() {
  const editing = editingCameraId.value !== null
  const url = editing ? `/api/admin/cameras/${editingCameraId.value}` : '/api/admin/cameras'
  try { await request(url, { method: editing ? 'PUT' : 'POST', body: JSON.stringify(cameraForm) }); resetCameraForm(); await Promise.all([loadCatalog(), loadCameras()]); flash(editing ? 'Kamera berhasil diperbarui' : 'Kamera berhasil ditambahkan') }
  catch(e) { flash(e.message, true) }
}
async function removeCamera(id) {
  if (!confirm('Hapus kamera ini?')) return
  try { await request(`/api/admin/cameras/${id}`, { method: 'DELETE' }); if (editingCameraId.value === id) resetCameraForm(); await Promise.all([loadCatalog(), loadCameras()]); flash('Kamera dihapus') } catch(e) { flash(e.message, true) }
}
async function addUser() {
  try { await request('/api/admin/users', { method: 'POST', body: JSON.stringify(userForm) }); Object.keys(userForm).forEach(k => userForm[k] = ''); await loadCatalog(); flash('User berhasil dibuat') } catch(e) { flash(e.message, true) }
}
async function addDepartment() {
  try { await request('/api/admin/departments', { method: 'POST', body: JSON.stringify(deptForm) }); deptForm.name = ''; deptForm.description = ''; await loadCatalog(); flash('Bidang berhasil ditambahkan') } catch(e) { flash(e.message, true) }
}
async function loadPermissions() {
  if (!permissionRole.value) return permissionIds.value = []
  try { permissionIds.value = await request(`/api/admin/roles/${permissionRole.value}/cameras`) } catch(e) { flash(e.message, true) }
}
async function savePermissions() {
  try { await request(`/api/admin/roles/${permissionRole.value}/cameras`, { method: 'PUT', body: JSON.stringify({ camera_ids: permissionIds.value }) }); flash('Pembagian kamera tersimpan') } catch(e) { flash(e.message, true) }
}

// ─── Playback page ────────────────────────────────────────────────────────────
async function findRecordings() {
  if (!playback.camera_id) return flash('Pilih kamera terlebih dahulu', true)
  playback.loading = true; playback.player_url = ''; playback.stream_path = ''; playback.active = null; playback.scrubberValue = 0
  try {
    const params = new URLSearchParams({ camera_id: playback.camera_id, start: new Date(playback.start).toISOString(), end: new Date(playback.end).toISOString() })
    const data = await request(`/api/playback/recordings?${params}`)
    playback.recordings = data.recordings
    if (!data.recordings.length) flash('Tidak ada rekaman pada rentang waktu tersebut')
  } catch (e) { playback.recordings = []; flash(e.message, true) }
  finally { playback.loading = false }
}

async function playRecording(recording, scale = playback.scale || 1, seekToMs = 0) {
  playback.loading = true
  playback.scale = scale
  try {
    // If seeking within same segment, compute a new start_time offset
    let startTime = recording.start_time
    if (seekToMs > 0) {
      const newStart = new Date(new Date(recording.start_time).getTime() + seekToMs)
      startTime = newStart.toISOString()
    }
    const data = await request('/api/playback/session', {
      method: 'POST',
      body: JSON.stringify({
        camera_id: playback.camera_id,
        start: startTime,
        end: recording.end_time,
        scale,
        previous_stream_path: playback.stream_path || undefined
      })
    })
    playback.player_url = data.player_url
    playback.stream_path = data.stream_path || ''
    playback.active = recording
    playback.activeSeekStart = new Date(startTime)
    // Set scrubber position
    const total = new Date(recording.end_time) - new Date(recording.start_time)
    playback.scrubberValue = total > 0 ? Math.round((seekToMs / total) * 1000) : 0
  } catch (e) { flash(e.message, true) }
  finally { playback.loading = false }
}

async function setPlaybackSpeed(newScale) {
  if (!playback.active || playback.loading || playback.changingSpeed) return
  if (playback.scale === newScale) return
  playback.changingSpeed = true
  const prevScale = playback.scale
  playback.scale = newScale
  try {
    const data = await request('/api/playback/session', {
      method: 'POST',
      body: JSON.stringify({
        camera_id: playback.camera_id,
        start: playback.activeSeekStart?.toISOString() || playback.active.start_time,
        end: playback.active.end_time,
        scale: newScale,
        previous_stream_path: playback.stream_path || undefined
      })
    })
    playback.player_url = data.player_url
    playback.stream_path = data.stream_path || ''
  } catch (e) { playback.scale = prevScale; flash(e.message, true) }
  finally { playback.changingSpeed = false }
}

function onScrubberInput(val) {
  playback.scrubberValue = val
}
function onScrubberChange(val) {
  if (!playback.active) return
  const total = new Date(playback.active.end_time) - new Date(playback.active.start_time)
  const seekToMs = Math.round((val / 1000) * total)
  playback.scrubberValue = val
  playback.scrubberDragging = false
  playRecording(playback.active, playback.scale, seekToMs)
}

function scrubberSeek(deltaSeconds) {
  if (!playback.active) return
  const total = new Date(playback.active.end_time) - new Date(playback.active.start_time)
  const currentMs = Math.round((playback.scrubberValue / 1000) * total)
  const newMs = Math.max(0, Math.min(total, currentMs + deltaSeconds * 1000))
  const newVal = Math.round((newMs / total) * 1000)
  onScrubberChange(newVal)
}

// Scrubber display time
const scrubberCurrentTime = computed(() => {
  if (!playback.active) return ''
  const total = new Date(playback.active.end_time) - new Date(playback.active.start_time)
  const elapsedMs = Math.round((playback.scrubberValue / 1000) * total)
  const d = new Date(new Date(playback.active.start_time).getTime() + elapsedMs)
  return new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', timeStyle: 'medium' }).format(d)
})

function durationLabel(item) {
  const seconds = Math.max(0, Math.round((new Date(item.end_time) - new Date(item.start_time)) / 1000))
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60
  if (h) return `${h}j ${m}m`
  if (m) return `${m}m ${s}s`
  return `${s}s`
}

function formatDurationMs(ms) {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60
  return `${h ? h + ':' : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

// ─── Quick Playback (Live View) ───────────────────────────────────────────────
async function openQuickPlayback(camera) {
  qp.camera = camera
  qp.visible = true
  qp.player_url = ''
  qp.stream_path = ''
  qp.scale = 1
  qp.loading = false
  qp.changingSpeed = false
  qp.active = null
  qp.recordings = []
  qp.scrubberValue = 0
  qp.activeSeekStart = null
  // Set default search range last 2 hours WIB
  const end = new Date(), start = new Date(end.getTime() - 2 * 60 * 60 * 1000)
  qp.start = dateToLocalInput(start)
  qp.end   = dateToLocalInput(end)
  await qpFindRecordings()
}

function closeQuickPlayback() {
  if (qp.stream_path) {
    // cleanup session on close
    request('/api/playback/session', {
      method: 'POST',
      body: JSON.stringify({
        camera_id: qp.camera?.id,
        start: new Date().toISOString(),
        end: new Date().toISOString(),
        scale: 1,
        previous_stream_path: qp.stream_path
      })
    }).catch(() => {})
  }
  qp.visible = false
  qp.player_url = ''
  qp.stream_path = ''
  qp.active = null
  qp.camera = null
}

async function qpFindRecordings() {
  if (!qp.camera) return
  qp.listLoading = true
  try {
    const params = new URLSearchParams({
      camera_id: qp.camera.id,
      start: new Date(qp.start).toISOString(),
      end: new Date(qp.end).toISOString()
    })
    const data = await request(`/api/playback/recordings?${params}`)
    qp.recordings = data.recordings
    if (!data.recordings.length) flash('Tidak ada rekaman pada rentang waktu tersebut')
    else if (data.recordings.length) await qpPlayRecording(data.recordings[data.recordings.length - 1], 1)
  } catch (e) { qp.recordings = []; flash(e.message, true) }
  finally { qp.listLoading = false }
}

async function qpPlayRecording(recording, scale = qp.scale || 1, seekToMs = 0) {
  qp.loading = true
  qp.scale = scale
  try {
    let startTime = recording.start_time
    if (seekToMs > 0) {
      startTime = new Date(new Date(recording.start_time).getTime() + seekToMs).toISOString()
    }
    const data = await request('/api/playback/session', {
      method: 'POST',
      body: JSON.stringify({
        camera_id: qp.camera.id,
        start: startTime,
        end: recording.end_time,
        scale,
        previous_stream_path: qp.stream_path || undefined
      })
    })
    qp.player_url = data.player_url
    qp.stream_path = data.stream_path || ''
    qp.active = recording
    qp.activeSeekStart = new Date(startTime)
    const total = new Date(recording.end_time) - new Date(recording.start_time)
    qp.scrubberValue = total > 0 ? Math.round((seekToMs / total) * 1000) : 0
  } catch (e) { flash(e.message, true) }
  finally { qp.loading = false }
}

async function qpSetSpeed(newScale) {
  if (!qp.active || qp.loading || qp.changingSpeed) return
  if (qp.scale === newScale) return
  qp.changingSpeed = true
  const prev = qp.scale
  qp.scale = newScale
  try {
    const data = await request('/api/playback/session', {
      method: 'POST',
      body: JSON.stringify({
        camera_id: qp.camera.id,
        start: qp.activeSeekStart?.toISOString() || qp.active.start_time,
        end: qp.active.end_time,
        scale: newScale,
        previous_stream_path: qp.stream_path || undefined
      })
    })
    qp.player_url = data.player_url
    qp.stream_path = data.stream_path || ''
  } catch (e) { qp.scale = prev; flash(e.message, true) }
  finally { qp.changingSpeed = false }
}

function qpScrubberChange(val) {
  if (!qp.active) return
  const total = new Date(qp.active.end_time) - new Date(qp.active.start_time)
  const seekToMs = Math.round((val / 1000) * total)
  qp.scrubberValue = val
  qpPlayRecording(qp.active, qp.scale, seekToMs)
}

function qpScrubberSeek(deltaSeconds) {
  if (!qp.active) return
  const total = new Date(qp.active.end_time) - new Date(qp.active.start_time)
  const currentMs = Math.round((qp.scrubberValue / 1000) * total)
  const newMs = Math.max(0, Math.min(total, currentMs + deltaSeconds * 1000))
  qpScrubberChange(Math.round((newMs / total) * 1000))
}

const qpCurrentTime = computed(() => {
  if (!qp.active) return ''
  const total = new Date(qp.active.end_time) - new Date(qp.active.start_time)
  const elapsedMs = Math.round((qp.scrubberValue / 1000) * total)
  const d = new Date(new Date(qp.active.start_time).getTime() + elapsedMs)
  return new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', timeStyle: 'medium' }).format(d)
})

const qpElapsed = computed(() => {
  if (!qp.active) return ''
  const total = new Date(qp.active.end_time) - new Date(qp.active.start_time)
  return formatDurationMs(Math.round((qp.scrubberValue / 1000) * total))
})
const qpDuration = computed(() => {
  if (!qp.active) return ''
  return formatDurationMs(new Date(qp.active.end_time) - new Date(qp.active.start_time))
})

// ─── Mount / Unmount ──────────────────────────────────────────────────────────
const mql = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(display-mode: fullscreen)') : null
onMounted(() => {
  bootstrap()
  document.addEventListener('fullscreenchange', handleFullscreenChange)
  window.addEventListener('resize', handleFullscreenChange)
  window.addEventListener('keydown', handleKeydown)
  if (mql) {
    if (mql.addEventListener) mql.addEventListener('change', handleFullscreenChange)
    else if (mql.addListener) mql.addListener(handleFullscreenChange)
  }
  handleFullscreenChange()
})
onUnmounted(() => {
  stopAutoTour()
  document.removeEventListener('fullscreenchange', handleFullscreenChange)
  window.removeEventListener('resize', handleFullscreenChange)
  window.removeEventListener('keydown', handleKeydown)
  if (mql) {
    if (mql.removeEventListener) mql.removeEventListener('change', handleFullscreenChange)
    else if (mql.removeListener) mql.removeListener(handleFullscreenChange)
  }
  syncFullscreenClasses(false)
})
</script>

<template>
  <!-- Global notification toasts -->
  <div v-if="notice" class="toast success">{{ notice }}</div>
  <div v-if="error" class="toast danger">{{ error }}</div>

  <div v-if="loading" class="center"><div class="spinner"></div><p>Menyiapkan pusat kendali…</p></div>
  <main v-else-if="!me" class="login-shell">
    <section class="login-brand"><div class="logo large">SC</div><p class="eyebrow">INTEGRATED SURVEILLANCE</p><h1>Satu pandangan.<br><span>Kontrol menyeluruh.</span></h1><p>Kelola akses kamera lintas brand dan bidang dari satu pusat kendali internal.</p><div class="feature-row"><span>● LAN ONLY</span><span>● ROLE BASED</span><span>● LOW LATENCY</span></div></section>
    <form class="login-card" @submit.prevent="login">
      <p class="eyebrow">AKSES TERBATAS</p>
      <h2>Masuk ke dashboard</h2>
      <p>Gunakan akun bidang yang telah diberikan administrator.</p>

      <div v-if="error" class="login-alert danger">⚠️ {{ error }}</div>
      <div v-if="notice" class="login-alert success">✓ {{ notice }}</div>

      <label>Username<input v-model="credentials.username" autocomplete="username" required :disabled="loginLoading"></label>
      <label>Password<input v-model="credentials.password" type="password" autocomplete="current-password" required autofocus :disabled="loginLoading"></label>
      <button class="primary" :disabled="loginLoading">
        <span>{{ loginLoading ? 'Memverifikasi…' : 'Masuk' }}</span>
        <span>→</span>
      </button>
      <small>Default awal: admin / password dari environment server</small>
    </form>
  </main>
  <div v-else class="app-shell" :class="{ 'sidebar-collapsed': sidebarCollapsed, 'fullscreen-mode': isFullscreen }">
    <aside :class="{ collapsed: sidebarCollapsed }">
      <div class="brand">
        <div class="brand-info">
          <div class="logo">SC</div>
          <div v-show="!sidebarCollapsed" class="brand-text"><b>SENTRA</b><small>CCTV CONTROL</small></div>
        </div>
        <button type="button" class="sidebar-toggle" :title="sidebarCollapsed ? 'Perluas sidebar' : 'Minimize sidebar'" @click="toggleSidebar">{{ sidebarCollapsed ? '»' : '«' }}</button>
      </div>
      <nav>
        <button :class="{active:page==='dashboard'}" :title="sidebarCollapsed ? 'Live Monitor' : ''" @click="page='dashboard'">
          <span class="nav-icon">▦</span><span v-show="!sidebarCollapsed">Live Monitor</span>
        </button>
        <button :class="{active:page==='playback'}" :title="sidebarCollapsed ? 'Playback' : ''" @click="page='playback'">
          <span class="nav-icon">▶</span><span v-show="!sidebarCollapsed">Playback</span>
        </button>
        <button v-if="isAdmin" :class="{active:page==='admin'}" :title="sidebarCollapsed ? 'Management' : ''" @click="page='admin';loadCatalog()">
          <span class="nav-icon">⚙</span><span v-show="!sidebarCollapsed">Management</span>
        </button>
      </nav>
      <div class="aside-status" :title="sidebarCollapsed ? `System Online · ${cameras.length} kamera tersedia` : ''">
        <i></i>
        <div v-show="!sidebarCollapsed"><b>System Online</b><small>{{ cameras.length }} kamera tersedia</small></div>
      </div>
    </aside>

    <!-- ── MAIN WORKSPACE ─────────────────────────────────────────────────── -->
    <section class="workspace" :class="[`page-${page}`, { 'in-fullscreen': isFullscreen }]">
      <header><div><p class="eyebrow">PUSAT KENDALI INTERNAL</p><h1>{{ page==='dashboard' ? 'Live Monitor' : page==='playback' ? 'Playback Rekaman' : 'Management' }}</h1></div><div class="user"><div class="avatar">{{ me.full_name.slice(0,2).toUpperCase() }}</div><div><b>{{ me.full_name }}</b><small>{{ me.role }}</small></div><button title="Keluar" @click="logout">↪</button></div></header>

      <!-- ── LIVE MONITOR ──────────────────────────────────────────────────── -->
      <template v-if="page==='dashboard'">
        <div class="toolbar" :class="{ 'in-fullscreen': isFullscreen }">
          <div class="search">⌕<input v-model="search" placeholder="Cari nama, lokasi, bidang…"></div>
          <select v-if="availableDepartments.length" v-model="selectedDepartment" class="filter-select" @change="offset = 0">
            <option value="">Semua Bidang</option>
            <option v-for="d in availableDepartments" :key="d" :value="d">{{d}}</option>
          </select>
          <div class="segmented"><button v-for="n in [1,4,9,16,32]" :class="{active:grid===n}" @click="setGrid(n)">{{n}}</button></div>
          <button class="ghost" @click="loadCameras">↻ Refresh</button>
          <div v-if="pages > 1" class="fullscreen-page-controls">
            <button type="button" title="Halaman sebelumnya (looping)" @click="nextLoop(-1)">←</button>
            <span class="page-count">{{ currentPage }} / {{ pages }}</span>
            <button type="button" title="Halaman berikutnya (looping)" @click="nextLoop(1)">→</button>
            <span class="tour-sep"></span>
            <button type="button" class="tour-btn" :class="{ active: autoTourActive }" :title="autoTourActive ? 'Klik untuk hentikan auto tour halaman' : 'Klik untuk mulai auto tour halaman'" @click="toggleAutoTour">
              <span v-if="autoTourActive" class="tour-dot"></span>
              <span>{{ autoTourActive ? '⏸ Stop' : '▶ Auto' }}</span>
            </button>
            <div class="tour-input-box" title="Jeda waktu ganti halaman (detik)">
              <input type="number" v-model.number="autoTourInterval" min="2" max="3600" class="tour-input" @change="onIntervalChange" @keyup.enter="onIntervalChange" @click.stop />
              <span class="tour-unit">dtk</span>
            </div>
          </div>
          <button type="button" class="fullscreen-btn" :class="{ active: isFullscreen }" :title="isFullscreen ? 'Keluar dari layar penuh (Esc / F11)' : 'Tampilkan hanya kamera di layar penuh (F11)'" @click="toggleFullscreen">
            <span>{{ isFullscreen ? '✕' : '⛶' }}</span>
            <span>{{ isFullscreen ? 'Keluar Fullscreen' : 'Layar Penuh' }}</span>
          </button>
        </div>
        <div v-if="!visible.length" class="empty"><b>Belum ada kamera untuk akun ini</b><p>Administrator perlu menambahkan kamera dan memberikan akses ke role Anda.</p></div>
        <div v-else class="camera-grid" :class="`grid-${grid}`">
          <article v-for="camera in visible" :key="camera.id">
            <div class="feed">
              <iframe :src="camera.player_url" allow="autoplay; fullscreen" loading="lazy"></iframe>
              <span class="live">● LIVE</span>
              <a :href="camera.player_url" target="_blank" title="Buka layar penuh">⛶</a>
              <!-- Quick Playback button: only for NVR-connected cameras -->
              <button
                v-if="camera.nvr_channel"
                class="quick-replay-btn"
                title="Putar rekaman kamera ini"
                @click.prevent="openQuickPlayback(camera)"
              >⏪ Replay</button>
            </div>
            <footer>
              <div>
                <b :title="camera.name">{{camera.name}}</b>
                <small :title="`${camera.location||'Lokasi belum diatur'} · ${camera.brand||'Generic'}`">{{camera.location||'Lokasi belum diatur'}} · {{camera.brand||'Generic'}}</small>
              </div>
              <span :title="camera.department||'Umum'">{{camera.department||'Umum'}}</span>
            </footer>
          </article>
        </div>
        <div class="pagination"><button :disabled="currentPage===1" @click="next(-1)">← Sebelumnya</button><span>{{currentPage}} / {{pages}} · {{filtered.length}} kamera</span><button :disabled="currentPage===pages" @click="next(1)">Berikutnya →</button></div>
      </template>

      <!-- ── PLAYBACK PAGE ─────────────────────────────────────────────────── -->
      <template v-else-if="page==='playback'">
        <section class="panel playback-filter">
          <div><p class="eyebrow">ARSIP NVR</p><h2>Cari rekaman</h2></div>
          <form @submit.prevent="findRecordings" class="playback-form">
            <label>Kamera<select v-model="playback.camera_id" required><option value="" disabled>Pilih kamera</option><option v-for="c in cameras" :key="c.id" :value="c.id">{{c.name}}{{c.nvr_channel ? ` · CH ${c.nvr_channel}` : ' · belum dipetakan'}}</option></select></label>
            <label>Mulai (WIB)<input v-model="playback.start" type="datetime-local" required></label>
            <label>Selesai (WIB)<input v-model="playback.end" type="datetime-local" required></label>
            <button class="primary" :disabled="playback.loading">{{playback.loading?'Memproses…':'⌕ Cari rekaman'}}</button>
          </form>
        </section>
        <div class="playback-layout">
          <!-- Player + controls -->
          <section class="panel playback-viewer">
            <div v-if="playback.player_url" class="archive-feed">
              <iframe :key="playback.player_url" :src="playback.player_url" allow="autoplay; fullscreen"></iframe>
            </div>
            <div v-else class="playback-placeholder">
              <span>▶</span><b>Pilih segmen rekaman</b><small>Hasil pencarian akan tampil di sebelah kanan.</small>
            </div>

            <!-- ── TIMELINE SCRUBBER ───────────────────────────────────────── -->
            <div v-if="playback.active" class="scrubber-bar">
              <div class="scrubber-seek-btns">
                <button type="button" @click="scrubberSeek(-30)" title="Mundur 30 detik">-30s</button>
                <button type="button" @click="scrubberSeek(-10)" title="Mundur 10 detik">-10s</button>
                <button type="button" @click="scrubberSeek(10)" title="Maju 10 detik">+10s</button>
                <button type="button" @click="scrubberSeek(30)" title="Maju 30 detik">+30s</button>
              </div>
              <div class="scrubber-track-wrap">
                <span class="scrubber-time-label">{{ dateLabel(playback.active.start_time) }}</span>
                <input
                  class="scrubber-input"
                  type="range"
                  min="0" max="1000"
                  :value="playback.scrubberValue"
                  :disabled="playback.loading || playback.changingSpeed"
                  @input="e => onScrubberInput(Number(e.target.value))"
                  @change="e => onScrubberChange(Number(e.target.value))"
                />
                <span class="scrubber-time-label">{{ dateLabel(playback.active.end_time) }}</span>
              </div>
              <div class="scrubber-position">
                <span class="scrubber-now">🕐 {{ scrubberCurrentTime }}</span>
                <span class="scrubber-dur">
                  {{ formatDurationMs(Math.round((playback.scrubberValue/1000)*(new Date(playback.active.end_time)-new Date(playback.active.start_time)))) }}
                  /
                  {{ formatDurationMs(new Date(playback.active.end_time)-new Date(playback.active.start_time)) }}
                </span>
              </div>
            </div>

            <!-- ── SPEED BAR ───────────────────────────────────────────────── -->
            <div v-if="playback.active" class="playback-speed-bar">
              <div class="speed-label">
                <svg class="speed-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                <span>Kecepatan:</span>
              </div>
              <div class="speed-buttons">
                <button v-for="s in playbackSpeeds" :key="s.value" type="button" class="speed-btn"
                  :class="{ active: playback.scale === s.value }"
                  :disabled="playback.changingSpeed || playback.loading"
                  :title="s.title"
                  @click="setPlaybackSpeed(s.value)">{{ s.label }}</button>
              </div>
              <span v-if="playback.changingSpeed" class="speed-status">Mengubah kecepatan…</span>
            </div>

            <!-- ── INFO BAR ────────────────────────────────────────────────── -->
            <div v-if="playback.active" class="playing-info">
              <div>
                <b>{{cameras.find(c=>String(c.id)===String(playback.camera_id))?.name}}</b>
                <small>{{ dateLabel(playback.active.start_time) }} — {{ dateLabel(playback.active.end_time) }}</small>
              </div>
              <div class="playing-right">
                <span class="speed-badge" :class="{ accelerated: playback.scale > 1, slowmo: playback.scale < 1 }">
                  {{ playback.scale === 1 ? '1x Normal' : `${playback.scale}x ${playback.scale > 1 ? 'Fast' : 'Slow'}` }}
                </span>
                <a :href="playback.player_url" target="_blank" title="Buka layar penuh">Buka penuh ⛶</a>
              </div>
            </div>
          </section>

          <!-- Recording list -->
          <section class="panel recording-list">
            <div class="panel-title"><div><p class="eyebrow">HASIL PENCARIAN</p><h2>{{playback.recordings.length}} segmen</h2></div></div>
            <div v-if="!playback.recordings.length" class="recording-empty">Atur kamera dan rentang waktu, lalu tekan <b>Cari rekaman</b>.</div>
            <button v-for="item in playback.recordings" :key="item.id" class="recording-item" :class="{active:playback.active?.id===item.id}" @click="playRecording(item)">
              <span class="record-icon">▶</span>
              <span>
                <b>{{ dateLabel(item.start_time) }}</b>
                <small>s.d. {{ dateLabel(item.end_time) }} · {{ durationLabel(item) }}</small>
              </span>
              <em>{{item.codec}}</em>
            </button>
          </section>
        </div>
      </template>

      <!-- ── ADMIN ─────────────────────────────────────────────────────────── -->
      <template v-else>
        <div class="stats">
          <div><span>◉</span><p><b>{{catalog.cameras.length}}</b><small>Total kamera</small></p></div>
          <div><span>🏢</span><p><b>{{catalog.departments.length}}</b><small>Bidang terdaftar</small></p></div>
          <div><span>♙</span><p><b>{{catalog.users.length}}</b><small>Account aktif</small></p></div>
          <div><span>⌘</span><p><b>{{catalog.roles.length}}</b><small>Role tersedia</small></p></div>
        </div>
        <div class="admin-grid">
          <section v-if="me.can_manage_cameras || me.can_manage_users" class="panel wide">
            <div class="panel-title"><div><p class="eyebrow">ORGANISASI</p><h2>Bidang terdaftar</h2></div></div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin:14px 0 16px">
              <span v-for="d in catalog.departments" :key="d.id" class="source-status managed" style="background:#0c1e2e;border:1px solid #1c3d52;padding:6px 12px;border-radius:6px;font-size:12px;color:#dce7f5"><b>{{d.name}}</b><span v-if="d.description" style="color:var(--muted);margin-left:6px">· {{d.description}}</span></span>
            </div>
            <form @submit.prevent="addDepartment" class="form-grid" style="grid-template-columns:1fr 1fr auto;align-items:end;gap:10px">
              <label>Nama bidang baru<input v-model="deptForm.name" required placeholder="Operasi / Engineering / Pemeliharaan"></label>
              <label>Keterangan<input v-model="deptForm.description" placeholder="Deskripsi tugas bidang"></label>
              <button class="primary" style="height:45px;white-space:nowrap;margin-top:0">+ Tambah bidang</button>
            </form>
          </section>
          <section v-if="me.can_manage_cameras" class="panel"><div class="panel-title"><div><p class="eyebrow">INVENTARIS</p><h2>{{ editingCameraId === null ? 'Tambah kamera' : 'Edit kamera' }}</h2></div><button v-if="editingCameraId !== null" class="ghost compact" type="button" @click="resetCameraForm">Batal edit</button></div><form @submit.prevent="saveCamera" class="form-grid"><label>Nama<input v-model="cameraForm.name" required placeholder="Gerbang Utama"></label><label>Stream path<input v-model="cameraForm.stream_path" required pattern="[A-Za-z0-9._~-]+" title="Gunakan huruf, angka, titik, underscore, tilde, atau tanda hubung" placeholder="gerbang-utama"></label><label>Lokasi<input v-model="cameraForm.location" placeholder="Gedung A"></label><label>Brand<input v-model="cameraForm.brand" placeholder="Hikvision"></label><label>Bidang<select v-model="cameraForm.department_id"><option value="">Umum</option><option v-for="d in catalog.departments" :value="d.id">{{d.name}}</option></select></label><label>Channel NVR <small>ID InputProxy Hikvision (1–128) untuk playback.</small><input v-model="cameraForm.nvr_channel" type="number" min="1" max="128" placeholder="7"></label><label class="full-field">RTSP Source URL <small v-if="editingCameraId !== null">Kosongkan untuk mempertahankan URL tersimpan.</small><input v-model="cameraForm.rtsp_source" type="password" autocomplete="new-password" placeholder="rtsp://viewer:password@192.168.1.10:554/substream"></label><button class="primary">{{ editingCameraId === null ? '+ Tambah kamera' : 'Simpan perubahan' }}</button></form></section>
          <section v-if="me.can_manage_users" class="panel"><p class="eyebrow">IDENTITAS</p><h2>Buat account</h2><form @submit.prevent="addUser" class="form-grid"><label>Username<input v-model="userForm.username" required></label><label>Nama lengkap<input v-model="userForm.full_name" required></label><label>Password<input v-model="userForm.password" type="password" minlength="8" required></label><label>Role<select v-model="userForm.role_id" required><option value="" disabled>Pilih role</option><option v-for="r in catalog.roles" :value="r.id">{{r.name}}</option></select></label><label>Bidang<select v-model="userForm.department_id"><option value="">Tanpa bidang</option><option v-for="d in catalog.departments" :value="d.id">{{d.name}}</option></select></label><button class="primary">+ Buat account</button></form></section>
          <section v-if="me.can_manage_users" class="panel wide"><p class="eyebrow">OTORISASI</p><h2>Pembagian kamera per role</h2><div class="permission-head"><select v-model="permissionRole" @change="loadPermissions"><option value="">Pilih role</option><option v-for="r in catalog.roles.filter(x=>!x.can_view_all)" :value="r.id">{{r.name}}</option></select><button class="primary" :disabled="!permissionRole" @click="savePermissions">Simpan akses</button></div><div v-if="permissionRole" class="checks"><label v-for="c in catalog.cameras"><input v-model="permissionIds" type="checkbox" :value="c.id"><span><b>{{c.name}}</b><small>{{c.location||'Tanpa lokasi'}}</small></span></label></div><p v-else class="muted">Pilih role non-administrator untuk mengatur kamera yang dapat dilihat.</p></section>
          <section class="panel wide">
            <div class="panel-title">
              <div><p class="eyebrow">DAFTAR ASET</p><h2>Kamera terdaftar</h2></div>
              <div class="panel-actions">
                <span class="nvr-stat-pill" :title="`${nvrConnectedCount} dari ${catalog.cameras.length} kamera sudah terhubung ke NVR untuk playback`"><i class="nvr-dot" :class="nvrConnectedCount > 0 ? 'online' : 'offline'"></i><span>{{ nvrConnectedCount }} / {{ catalog.cameras.length }} NVR Terhubung</span></span>
                <button v-if="me.can_manage_cameras" class="ghost compact" type="button" @click="syncNvrChannels">↻ Cocokkan IP dari NVR</button>
              </div>
            </div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Nama</th><th>Path</th><th>NVR Playback</th><th>Sumber</th><th>Lokasi</th><th>Bidang</th><th></th></tr></thead>
                <tbody>
                  <tr v-for="c in catalog.cameras" :key="c.id">
                    <td><b>{{c.name}}</b><small>{{c.brand||'Generic'}}</small></td>
                    <td><code>{{c.stream_path}}</code></td>
                    <td>
                      <span v-if="c.nvr_channel" class="nvr-status connected" :title="`Terhubung ke NVR InputProxy CH ${c.nvr_channel} untuk playback rekaman. Klik untuk buka playback.`" @click="openCameraPlayback(c.id)">
                        <i class="nvr-dot online"></i><b>CH {{c.nvr_channel}}</b><small>Terhubung</small>
                      </span>
                      <span v-else class="nvr-status unmapped" title="Belum terhubung ke NVR. Edit kamera untuk mengisi Channel NVR (1–128) atau klik 'Cocokkan IP dari NVR'">
                        <i class="nvr-dot offline"></i><small>Belum terhubung</small>
                      </span>
                    </td>
                    <td><span class="source-status" :class="{managed:c.rtsp_configured}">{{c.rtsp_configured?'Database':'YAML / eksternal'}}</span></td>
                    <td>{{c.location||'—'}}</td>
                    <td>{{c.department||'Umum'}}</td>
                    <td><div v-if="me.can_manage_cameras" class="row-actions"><button class="edit-text" @click="editCamera(c)">Edit</button><button class="danger-text" @click="removeCamera(c.id)">Hapus</button></div></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </template>
    </section>
  </div>

  <!-- ═══════════════════════════════════════════════════════════════════════
       QUICK PLAYBACK MODAL (Live View Replay)
       ════════════════════════════════════════════════════════════════════════ -->
  <teleport to="body">
    <transition name="qp-fade">
      <div v-if="qp.visible" class="qp-backdrop" @click.self="closeQuickPlayback">
        <div class="qp-modal">
          <!-- Header -->
          <div class="qp-header">
            <div class="qp-title">
              <span class="qp-replay-icon">⏪</span>
              <div>
                <b>{{ qp.camera?.name }}</b>
                <small>{{ qp.camera?.location || 'Quick Playback' }} · CH {{ qp.camera?.nvr_channel }}</small>
              </div>
            </div>
            <div class="qp-header-right">
              <span v-if="qp.active" class="speed-badge" :class="{ accelerated: qp.scale > 1, slowmo: qp.scale < 1 }">
                {{ qp.scale === 1 ? '1x Normal' : `${qp.scale}x ${qp.scale > 1 ? 'Fast' : 'Slow'}` }}
              </span>
              <button class="qp-close-btn" @click="closeQuickPlayback" title="Tutup (Esc)">✕</button>
            </div>
          </div>

          <div class="qp-body">
            <!-- Video -->
            <div class="qp-video-side">
              <div class="qp-video-wrap">
                <div v-if="qp.player_url" class="qp-feed">
                  <iframe :key="qp.player_url" :src="qp.player_url" allow="autoplay; fullscreen"></iframe>
                  <div v-if="qp.loading" class="qp-loading-overlay"><div class="spinner"></div></div>
                </div>
                <div v-else-if="qp.loading" class="qp-placeholder"><div class="spinner"></div><p>Memuat rekaman…</p></div>
                <div v-else class="qp-placeholder"><span>⏪</span><p>Mencari rekaman…</p></div>
              </div>

              <!-- Scrubber -->
              <div v-if="qp.active" class="scrubber-bar">
                <div class="scrubber-seek-btns">
                  <button type="button" @click="qpScrubberSeek(-30)">-30s</button>
                  <button type="button" @click="qpScrubberSeek(-10)">-10s</button>
                  <button type="button" @click="qpScrubberSeek(10)">+10s</button>
                  <button type="button" @click="qpScrubberSeek(30)">+30s</button>
                </div>
                <div class="scrubber-track-wrap">
                  <span class="scrubber-time-label">{{ dateLabel(qp.active.start_time) }}</span>
                  <input
                    class="scrubber-input"
                    type="range" min="0" max="1000"
                    :value="qp.scrubberValue"
                    :disabled="qp.loading || qp.changingSpeed"
                    @input="e => qp.scrubberValue = Number(e.target.value)"
                    @change="e => qpScrubberChange(Number(e.target.value))"
                  />
                  <span class="scrubber-time-label">{{ dateLabel(qp.active.end_time) }}</span>
                </div>
                <div class="scrubber-position">
                  <span class="scrubber-now">🕐 {{ qpCurrentTime }}</span>
                  <span class="scrubber-dur">{{ qpElapsed }} / {{ qpDuration }}</span>
                </div>
              </div>

              <!-- Speed bar -->
              <div v-if="qp.active" class="playback-speed-bar">
                <div class="speed-label">
                  <svg class="speed-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                  <span>Kecepatan:</span>
                </div>
                <div class="speed-buttons">
                  <button v-for="s in playbackSpeeds" :key="s.value" type="button" class="speed-btn"
                    :class="{ active: qp.scale === s.value }"
                    :disabled="qp.changingSpeed || qp.loading"
                    :title="s.title"
                    @click="qpSetSpeed(s.value)">{{ s.label }}</button>
                </div>
                <span v-if="qp.changingSpeed" class="speed-status">Mengubah kecepatan…</span>
              </div>

              <!-- Search range -->
              <div class="qp-search-bar">
                <label>Dari (WIB)<input type="datetime-local" v-model="qp.start"></label>
                <label>Sampai (WIB)<input type="datetime-local" v-model="qp.end"></label>
                <button class="primary" :disabled="qp.listLoading" @click="qpFindRecordings">
                  {{ qp.listLoading ? 'Mencari…' : '⌕ Cari' }}
                </button>
              </div>
            </div>

            <!-- Recording list (sidebar) -->
            <div class="qp-list-side">
              <p class="eyebrow" style="margin:0 0 10px">SEGMEN REKAMAN</p>
              <div v-if="qp.listLoading" class="qp-list-loading"><div class="spinner small"></div></div>
              <div v-else-if="!qp.recordings.length" class="recording-empty">Tidak ada rekaman ditemukan.</div>
              <button
                v-for="item in qp.recordings" :key="item.id"
                class="recording-item"
                :class="{active: qp.active?.id === item.id}"
                @click="qpPlayRecording(item)"
              >
                <span class="record-icon">▶</span>
                <span>
                  <b>{{ dateLabel(item.start_time) }}</b>
                  <small>s.d. {{ dateLabel(item.end_time) }} · {{ durationLabel(item) }}</small>
                </span>
                <em>{{item.codec}}</em>
              </button>
            </div>
          </div>
        </div>
      </div>
    </transition>
  </teleport>
</template>

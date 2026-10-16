<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'

const me = ref(null), cameras = ref([]), catalog = reactive({ cameras: [], users: [], roles: [], departments: [] })
const loading = ref(true), notice = ref(''), error = ref(''), page = ref('dashboard'), grid = ref(16), offset = ref(0), search = ref(''), selectedDepartment = ref('')
const credentials = reactive({ username: 'admin', password: '' })
const cameraForm = reactive({ name: '', location: '', brand: '', stream_path: '', department_id: '', rtsp_source: '', nvr_channel: '' })
const editingCameraId = ref(null)
const userForm = reactive({ username: '', full_name: '', password: '', role_id: '', department_id: '' })
const deptForm = reactive({ name: '', description: '' })
const permissionRole = ref(''), permissionIds = ref([])
const playback = reactive({ camera_id: '', start: '', end: '', recordings: [], player_url: '', loading: false, active: null })
const sidebarCollapsed = ref(typeof localStorage !== 'undefined' && localStorage.getItem('sidebar_collapsed') === 'true')
function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value
  try { localStorage.setItem('sidebar_collapsed', sidebarCollapsed.value ? 'true' : 'false') } catch {}
}
const nvrConnectedCount = computed(() => catalog.cameras.filter(c => c.nvr_channel).length)
function openCameraPlayback(cameraId) {
  playback.camera_id = cameraId
  resetPlaybackRange()
  page.value = 'playback'
  findRecordings()
}

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
      if (document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen()
      }
      isFullscreen.value = true
    } else {
      if (document.fullscreenElement && document.exitFullscreen) {
        await document.exitFullscreen()
      }
      isFullscreen.value = false
    }
  } catch {
    isFullscreen.value = !isFullscreen.value
  }
  syncFullscreenClasses(isFullscreen.value)
  setTimeout(handleFullscreenChange, 100)
}

function handleKeydown(e) {
  if (e.key === 'F11') {
    // Let browser perform native F11 and sync state
    setTimeout(handleFullscreenChange, 120)
    setTimeout(handleFullscreenChange, 400)
  } else if (e.key === 'Escape') {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {})
    }
    isFullscreen.value = false
    syncFullscreenClasses(false)
    setTimeout(handleFullscreenChange, 120)
  } else if (isFullscreen.value && page.value === 'dashboard') {
    if (e.key === 'ArrowRight' || e.key === 'PageDown') next(1)
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') next(-1)
  }
}

function localDateTime(date) {
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}
function resetPlaybackRange() {
  const end = new Date(), start = new Date(end.getTime() - 2 * 60 * 60 * 1000)
  playback.start = localDateTime(start); playback.end = localDateTime(end)
}
resetPlaybackRange()

async function request(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', headers: { 'content-type': 'application/json', ...(options.headers || {}) }, ...options })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'Permintaan gagal')
  return data
}
function flash(message, bad = false) { (bad ? error : notice).value = message; setTimeout(() => (bad ? error : notice).value = '', 3500) }

async function bootstrap() {
  loading.value = true
  try { me.value = await request('/api/me'); await loadCameras(); if (isAdmin.value) await loadCatalog() }
  catch { me.value = null }
  finally { loading.value = false }
}
async function login() {
  try { await request('/api/login', { method: 'POST', body: JSON.stringify(credentials) }); credentials.password = ''; await bootstrap() }
  catch (e) { flash(e.message, true) }
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
function setGrid(value) { grid.value = value; offset.value = 0 }
function next(delta) { offset.value = Math.min(Math.max(0, offset.value + delta * grid.value), Math.max(0, (pages.value - 1) * grid.value)) }

function resetCameraForm() {
  Object.keys(cameraForm).forEach(k => cameraForm[k] = '')
  editingCameraId.value = null
}
function editCamera(camera) {
  editingCameraId.value = camera.id
  Object.assign(cameraForm, { name: camera.name, location: camera.location || '', brand: camera.brand || '', stream_path: camera.stream_path, department_id: camera.department_id || '', rtsp_source: '', nvr_channel: camera.nvr_channel || '' })
  window.scrollTo({ top: 0, behavior: 'smooth' })
}
async function saveCamera() {
  const editing = editingCameraId.value !== null
  const url = editing ? `/api/admin/cameras/${editingCameraId.value}` : '/api/admin/cameras'
  try { await request(url, { method: editing ? 'PUT' : 'POST', body:JSON.stringify(cameraForm) }); resetCameraForm(); await Promise.all([loadCatalog(),loadCameras()]); flash(editing ? 'Kamera berhasil diperbarui' : 'Kamera berhasil ditambahkan') }
  catch(e) { flash(e.message,true) }
}
async function removeCamera(id) {
  if (!confirm('Hapus kamera ini?')) return
  try { await request(`/api/admin/cameras/${id}`,{method:'DELETE'}); if (editingCameraId.value === id) resetCameraForm(); await Promise.all([loadCatalog(),loadCameras()]); flash('Kamera dihapus') } catch(e){ flash(e.message,true) }
}
async function addUser() {
  try { await request('/api/admin/users',{method:'POST',body:JSON.stringify(userForm)}); Object.keys(userForm).forEach(k=>userForm[k]=''); await loadCatalog(); flash('User berhasil dibuat') } catch(e){ flash(e.message,true) }
}
async function addDepartment() {
  try {
    await request('/api/admin/departments', { method: 'POST', body: JSON.stringify(deptForm) })
    deptForm.name = ''; deptForm.description = ''
    await loadCatalog()
    flash('Bidang berhasil ditambahkan')
  } catch(e) { flash(e.message, true) }
}
async function loadPermissions() {
  if (!permissionRole.value) return permissionIds.value=[]
  try { permissionIds.value=await request(`/api/admin/roles/${permissionRole.value}/cameras`) } catch(e){ flash(e.message,true) }
}
async function savePermissions() {
  try { await request(`/api/admin/roles/${permissionRole.value}/cameras`,{method:'PUT',body:JSON.stringify({camera_ids:permissionIds.value})}); flash('Pembagian kamera tersimpan') } catch(e){ flash(e.message,true) }
}
async function findRecordings() {
  if (!playback.camera_id) return flash('Pilih kamera terlebih dahulu', true)
  playback.loading = true; playback.player_url = ''; playback.active = null
  try {
    const params = new URLSearchParams({ camera_id: playback.camera_id, start: new Date(playback.start).toISOString(), end: new Date(playback.end).toISOString() })
    const data = await request(`/api/playback/recordings?${params}`)
    playback.recordings = data.recordings
    if (!data.recordings.length) flash('Tidak ada rekaman pada rentang waktu tersebut')
  } catch (e) { playback.recordings = []; flash(e.message, true) }
  finally { playback.loading = false }
}
async function playRecording(recording) {
  playback.loading = true
  try {
    const data = await request('/api/playback/session', { method: 'POST', body: JSON.stringify({ camera_id: playback.camera_id, start: recording.start_time, end: recording.end_time }) })
    playback.player_url = data.player_url; playback.active = recording
  } catch (e) { flash(e.message, true) }
  finally { playback.loading = false }
}
const dateLabel = value => new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value))
function durationLabel(item) {
  const seconds = Math.max(0, Math.round((new Date(item.end_time) - new Date(item.start_time)) / 1000))
  const hours = Math.floor(seconds / 3600), minutes = Math.floor((seconds % 3600) / 60)
  return `${hours ? `${hours} jam ` : ''}${minutes} menit`
}
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
  <div v-if="loading" class="center"><div class="spinner"></div><p>Menyiapkan pusat kendali…</p></div>
  <main v-else-if="!me" class="login-shell">
    <section class="login-brand"><div class="logo large">SC</div><p class="eyebrow">INTEGRATED SURVEILLANCE</p><h1>Satu pandangan.<br><span>Kontrol menyeluruh.</span></h1><p>Kelola akses kamera lintas brand dan bidang dari satu pusat kendali internal.</p><div class="feature-row"><span>● LAN ONLY</span><span>● ROLE BASED</span><span>● LOW LATENCY</span></div></section>
    <form class="login-card" @submit.prevent="login"><p class="eyebrow">AKSES TERBATAS</p><h2>Masuk ke dashboard</h2><p>Gunakan akun bidang yang telah diberikan administrator.</p><label>Username<input v-model="credentials.username" autocomplete="username" required></label><label>Password<input v-model="credentials.password" type="password" autocomplete="current-password" required autofocus></label><button class="primary">Masuk <span>→</span></button><small>Default awal: admin / password dari environment server</small></form>
  </main>
  <div v-else class="app-shell" :class="{ 'sidebar-collapsed': sidebarCollapsed, 'fullscreen-mode': isFullscreen }">
    <aside :class="{ collapsed: sidebarCollapsed }">
      <div class="brand">
        <div class="brand-info">
          <div class="logo">SC</div>
          <div v-show="!sidebarCollapsed" class="brand-text">
            <b>SENTRA</b>
            <small>CCTV CONTROL</small>
          </div>
        </div>
        <button
          type="button"
          class="sidebar-toggle"
          :title="sidebarCollapsed ? 'Perluas sidebar (Buka menu)' : 'Minimize sidebar (Perkecil)'"
          @click="toggleSidebar"
        >
          {{ sidebarCollapsed ? '»' : '«' }}
        </button>
      </div>
      <nav>
        <button :class="{active:page==='dashboard'}" :title="sidebarCollapsed ? 'Live Monitor' : ''" @click="page='dashboard'">
          <span class="nav-icon">▦</span>
          <span v-show="!sidebarCollapsed">Live Monitor</span>
        </button>
        <button :class="{active:page==='playback'}" :title="sidebarCollapsed ? 'Playback' : ''" @click="page='playback'">
          <span class="nav-icon">▶</span>
          <span v-show="!sidebarCollapsed">Playback</span>
        </button>
        <button v-if="isAdmin" :class="{active:page==='admin'}" :title="sidebarCollapsed ? 'Management' : ''" @click="page='admin';loadCatalog()">
          <span class="nav-icon">⚙</span>
          <span v-show="!sidebarCollapsed">Management</span>
        </button>
      </nav>
      <div class="aside-status" :title="sidebarCollapsed ? `System Online · ${cameras.length} kamera tersedia` : ''">
        <i></i>
        <div v-show="!sidebarCollapsed">
          <b>System Online</b>
          <small>{{ cameras.length }} kamera tersedia</small>
        </div>
      </div>
    </aside>
    <section class="workspace">
      <header><div><p class="eyebrow">PUSAT KENDALI INTERNAL</p><h1>{{ page==='dashboard' ? 'Live Monitor' : page==='playback' ? 'Playback Rekaman' : 'Management' }}</h1></div><div class="user"><div class="avatar">{{ me.full_name.slice(0,2).toUpperCase() }}</div><div><b>{{ me.full_name }}</b><small>{{ me.role }}</small></div><button title="Keluar" @click="logout">↪</button></div></header>
      <div v-if="notice" class="toast success">{{ notice }}</div><div v-if="error" class="toast danger">{{ error }}</div>
      <template v-if="page==='dashboard'">
        <div class="toolbar" :class="{ 'in-fullscreen': isFullscreen }">
          <div class="search">⌕<input v-model="search" placeholder="Cari nama, lokasi, bidang…"></div>
          <select v-if="availableDepartments.length" v-model="selectedDepartment" class="filter-select" @change="offset = 0">
            <option value="">Semua Bidang</option>
            <option v-for="d in availableDepartments" :key="d" :value="d">{{d}}</option>
          </select>
          <div class="segmented"><button v-for="n in [1,4,9,16,32]" :class="{active:grid===n}" @click="setGrid(n)">{{n}}</button></div>
          <button class="ghost" @click="loadCameras">↻ Refresh</button>
          <div v-if="isFullscreen && pages > 1" class="fullscreen-page-controls">
            <button :disabled="currentPage===1" title="Halaman sebelumnya" @click="next(-1)">←</button>
            <span>{{currentPage}} / {{pages}}</span>
            <button :disabled="currentPage===pages" title="Halaman berikutnya" @click="next(1)">→</button>
          </div>
          <button
            type="button"
            class="fullscreen-btn"
            :class="{ active: isFullscreen }"
            :title="isFullscreen ? 'Keluar dari layar penuh (Esc / F11)' : 'Tampilkan hanya kamera di layar penuh (F11)'"
            @click="toggleFullscreen"
          >
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
      <template v-else-if="page==='playback'">
        <section class="panel playback-filter"><div><p class="eyebrow">ARSIP NVR</p><h2>Cari rekaman</h2></div><form @submit.prevent="findRecordings" class="playback-form"><label>Kamera<select v-model="playback.camera_id" required><option value="" disabled>Pilih kamera</option><option v-for="c in cameras" :key="c.id" :value="c.id">{{c.name}}{{c.nvr_channel ? ` · CH ${c.nvr_channel}` : ' · belum dipetakan'}}</option></select></label><label>Mulai<input v-model="playback.start" type="datetime-local" required></label><label>Selesai<input v-model="playback.end" type="datetime-local" required></label><button class="primary" :disabled="playback.loading">{{playback.loading?'Memproses…':'⌕ Cari rekaman'}}</button></form></section>
        <div class="playback-layout">
          <section class="panel playback-viewer"><div v-if="playback.player_url" class="archive-feed"><iframe :key="playback.player_url" :src="playback.player_url" allow="autoplay; fullscreen"></iframe></div><div v-else class="playback-placeholder"><span>▶</span><b>Pilih segmen rekaman</b><small>Hasil pencarian akan tampil di sebelah kanan.</small></div><div v-if="playback.active" class="playing-info"><div><b>{{cameras.find(c=>String(c.id)===String(playback.camera_id))?.name}}</b><small>{{dateLabel(playback.active.start_time)}} — {{dateLabel(playback.active.end_time)}}</small></div><a :href="playback.player_url" target="_blank">Buka penuh ⛶</a></div></section>
          <section class="panel recording-list"><div class="panel-title"><div><p class="eyebrow">HASIL PENCARIAN</p><h2>{{playback.recordings.length}} segmen</h2></div></div><div v-if="!playback.recordings.length" class="recording-empty">Atur kamera dan rentang waktu, lalu tekan <b>Cari rekaman</b>.</div><button v-for="item in playback.recordings" :key="item.id" class="recording-item" :class="{active:playback.active?.id===item.id}" @click="playRecording(item)"><span class="record-icon">▶</span><span><b>{{dateLabel(item.start_time)}}</b><small>s.d. {{dateLabel(item.end_time)}} · {{durationLabel(item)}}</small></span><em>{{item.codec}}</em></button></section>
        </div>
      </template>
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
              <span v-for="d in catalog.departments" :key="d.id" class="source-status managed" style="background:#0c1e2e;border:1px solid #1c3d52;padding:6px 12px;border-radius:6px;font-size:12px;color:#dce7f5">
                <b>{{d.name}}</b><span v-if="d.description" style="color:var(--muted);margin-left:6px">· {{d.description}}</span>
              </span>
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
                <span class="nvr-stat-pill" :title="`${nvrConnectedCount} dari ${catalog.cameras.length} kamera sudah terhubung ke NVR untuk playback`">
                  <i class="nvr-dot" :class="nvrConnectedCount > 0 ? 'online' : 'offline'"></i>
                  <span>{{ nvrConnectedCount }} / {{ catalog.cameras.length }} NVR Terhubung</span>
                </span>
                <button v-if="me.can_manage_cameras" class="ghost compact" type="button" @click="syncNvrChannels">↻ Cocokkan IP dari NVR</button>
              </div>
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Nama</th>
                    <th>Path</th>
                    <th>NVR Playback</th>
                    <th>Sumber</th>
                    <th>Lokasi</th>
                    <th>Bidang</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="c in catalog.cameras" :key="c.id">
                    <td><b>{{c.name}}</b><small>{{c.brand||'Generic'}}</small></td>
                    <td><code>{{c.stream_path}}</code></td>
                    <td>
                      <span
                        v-if="c.nvr_channel"
                        class="nvr-status connected"
                        :title="`Terhubung ke NVR InputProxy CH ${c.nvr_channel} untuk playback rekaman. Klik untuk buka playback.`"
                        @click="openCameraPlayback(c.id)"
                      >
                        <i class="nvr-dot online"></i>
                        <b>CH {{c.nvr_channel}}</b>
                        <small>Terhubung</small>
                      </span>
                      <span
                        v-else
                        class="nvr-status unmapped"
                        title="Belum terhubung ke NVR. Edit kamera untuk mengisi Channel NVR (1–128) atau klik 'Cocokkan IP dari NVR'"
                      >
                        <i class="nvr-dot offline"></i>
                        <small>Belum terhubung</small>
                      </span>
                    </td>
                    <td><span class="source-status" :class="{managed:c.rtsp_configured}">{{c.rtsp_configured?'Database':'YAML / eksternal'}}</span></td>
                    <td>{{c.location||'—'}}</td>
                    <td>{{c.department||'Umum'}}</td>
                    <td>
                      <div v-if="me.can_manage_cameras" class="row-actions">
                        <button class="edit-text" @click="editCamera(c)">Edit</button>
                        <button class="danger-text" @click="removeCamera(c.id)">Hapus</button>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </template>
    </section>
  </div>
</template>
<script setup>
import { computed, onMounted, reactive, ref } from 'vue'

const me = ref(null), cameras = ref([]), catalog = reactive({ cameras: [], users: [], roles: [], departments: [] })
const loading = ref(true), notice = ref(''), error = ref(''), page = ref('dashboard'), grid = ref(9), offset = ref(0), search = ref('')
const credentials = reactive({ username: 'admin', password: '' })
const cameraForm = reactive({ name: '', location: '', brand: '', stream_path: '', department_id: '' })
const userForm = reactive({ username: '', full_name: '', password: '', role_id: '', department_id: '' })
const permissionRole = ref(''), permissionIds = ref([])

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
const isAdmin = computed(() => me.value?.can_manage_users || me.value?.can_manage_cameras)
const filtered = computed(() => { const q=search.value.toLowerCase(); return cameras.value.filter(c => [c.name,c.location,c.department,c.brand].some(v=>String(v||'').toLowerCase().includes(q))) })
const visible = computed(() => filtered.value.slice(offset.value, offset.value + grid.value))
const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / grid.value)))
const currentPage = computed(() => Math.floor(offset.value / grid.value) + 1)
function setGrid(value) { grid.value = value; offset.value = 0 }
function next(delta) { offset.value = Math.min(Math.max(0, offset.value + delta * grid.value), Math.max(0, (pages.value - 1) * grid.value)) }

async function addCamera() {
  try { await request('/api/admin/cameras', { method:'POST', body:JSON.stringify(cameraForm) }); Object.keys(cameraForm).forEach(k=>cameraForm[k]=''); await Promise.all([loadCatalog(),loadCameras()]); flash('Kamera berhasil ditambahkan') }
  catch(e) { flash(e.message,true) }
}
async function removeCamera(id) {
  if (!confirm('Hapus kamera ini?')) return
  try { await request(`/api/admin/cameras/${id}`,{method:'DELETE'}); await Promise.all([loadCatalog(),loadCameras()]); flash('Kamera dihapus') } catch(e){ flash(e.message,true) }
}
async function addUser() {
  try { await request('/api/admin/users',{method:'POST',body:JSON.stringify(userForm)}); Object.keys(userForm).forEach(k=>userForm[k]=''); await loadCatalog(); flash('User berhasil dibuat') } catch(e){ flash(e.message,true) }
}
async function loadPermissions() {
  if (!permissionRole.value) return permissionIds.value=[]
  try { permissionIds.value=await request(`/api/admin/roles/${permissionRole.value}/cameras`) } catch(e){ flash(e.message,true) }
}
async function savePermissions() {
  try { await request(`/api/admin/roles/${permissionRole.value}/cameras`,{method:'PUT',body:JSON.stringify({camera_ids:permissionIds.value})}); flash('Pembagian kamera tersimpan') } catch(e){ flash(e.message,true) }
}
onMounted(bootstrap)
</script>

<template>
  <div v-if="loading" class="center"><div class="spinner"></div><p>Menyiapkan pusat kendali…</p></div>
  <main v-else-if="!me" class="login-shell">
    <section class="login-brand"><div class="logo large">SC</div><p class="eyebrow">INTEGRATED SURVEILLANCE</p><h1>Satu pandangan.<br><span>Kontrol menyeluruh.</span></h1><p>Kelola akses kamera lintas brand dan bidang dari satu pusat kendali internal.</p><div class="feature-row"><span>● LAN ONLY</span><span>● ROLE BASED</span><span>● LOW LATENCY</span></div></section>
    <form class="login-card" @submit.prevent="login"><p class="eyebrow">AKSES TERBATAS</p><h2>Masuk ke dashboard</h2><p>Gunakan akun bidang yang telah diberikan administrator.</p><label>Username<input v-model="credentials.username" autocomplete="username" required></label><label>Password<input v-model="credentials.password" type="password" autocomplete="current-password" required autofocus></label><button class="primary">Masuk <span>→</span></button><small>Default awal: admin / password dari environment server</small></form>
  </main>
  <div v-else class="app-shell">
    <aside><div class="brand"><div class="logo">SC</div><div><b>SENTRA</b><small>CCTV CONTROL</small></div></div><nav><button :class="{active:page==='dashboard'}" @click="page='dashboard'">▦ <span>Live Monitor</span></button><button v-if="isAdmin" :class="{active:page==='admin'}" @click="page='admin';loadCatalog()">⚙ <span>Management</span></button></nav><div class="aside-status"><i></i><div><b>System Online</b><small>{{ cameras.length }} kamera tersedia</small></div></div></aside>
    <section class="workspace">
      <header><div><p class="eyebrow">PUSAT KENDALI INTERNAL</p><h1>{{ page==='dashboard'?'Live Monitor':'Management' }}</h1></div><div class="user"><div class="avatar">{{ me.full_name.slice(0,2).toUpperCase() }}</div><div><b>{{ me.full_name }}</b><small>{{ me.role }}</small></div><button title="Keluar" @click="logout">↪</button></div></header>
      <div v-if="notice" class="toast success">{{ notice }}</div><div v-if="error" class="toast danger">{{ error }}</div>
      <template v-if="page==='dashboard'">
        <div class="toolbar"><div class="search">⌕<input v-model="search" placeholder="Cari nama, lokasi, bidang…"></div><div class="segmented"><button v-for="n in [1,4,9,16]" :class="{active:grid===n}" @click="setGrid(n)">{{n}}</button></div><button class="ghost" @click="loadCameras">↻ Refresh</button></div>
        <div v-if="!visible.length" class="empty"><b>Belum ada kamera untuk akun ini</b><p>Administrator perlu menambahkan kamera dan memberikan akses ke role Anda.</p></div>
        <div v-else class="camera-grid" :class="`grid-${grid}`">
          <article v-for="camera in visible" :key="camera.id"><div class="feed"><iframe :src="camera.player_url" allow="autoplay; fullscreen" loading="lazy"></iframe><span class="live">● LIVE</span><a :href="camera.player_url" target="_blank" title="Buka layar penuh">⛶</a></div><footer><div><b>{{camera.name}}</b><small>{{camera.location||'Lokasi belum diatur'}} · {{camera.brand||'Generic'}}</small></div><span>{{camera.department||'Umum'}}</span></footer></article>
        </div>
        <div class="pagination"><button :disabled="currentPage===1" @click="next(-1)">← Sebelumnya</button><span>{{currentPage}} / {{pages}} · {{filtered.length}} kamera</span><button :disabled="currentPage===pages" @click="next(1)">Berikutnya →</button></div>
      </template>
      <template v-else>
        <div class="stats"><div><span>◉</span><p><b>{{catalog.cameras.length}}</b><small>Total kamera</small></p></div><div><span>♙</span><p><b>{{catalog.users.length}}</b><small>Account aktif</small></p></div><div><span>⌘</span><p><b>{{catalog.roles.length}}</b><small>Role tersedia</small></p></div></div>
        <div class="admin-grid">
          <section v-if="me.can_manage_cameras" class="panel"><div class="panel-title"><div><p class="eyebrow">INVENTARIS</p><h2>Tambah kamera</h2></div></div><form @submit.prevent="addCamera" class="form-grid"><label>Nama<input v-model="cameraForm.name" required placeholder="Gerbang Utama"></label><label>Stream path<input v-model="cameraForm.stream_path" required placeholder="gerbang-utama"></label><label>Lokasi<input v-model="cameraForm.location" placeholder="Gedung A"></label><label>Brand<input v-model="cameraForm.brand" placeholder="Hikvision"></label><label>Bidang<select v-model="cameraForm.department_id"><option value="">Umum</option><option v-for="d in catalog.departments" :value="d.id">{{d.name}}</option></select></label><button class="primary">+ Tambah kamera</button></form></section>
          <section v-if="me.can_manage_users" class="panel"><p class="eyebrow">IDENTITAS</p><h2>Buat account</h2><form @submit.prevent="addUser" class="form-grid"><label>Username<input v-model="userForm.username" required></label><label>Nama lengkap<input v-model="userForm.full_name" required></label><label>Password<input v-model="userForm.password" type="password" minlength="8" required></label><label>Role<select v-model="userForm.role_id" required><option value="" disabled>Pilih role</option><option v-for="r in catalog.roles" :value="r.id">{{r.name}}</option></select></label><label>Bidang<select v-model="userForm.department_id"><option value="">Tanpa bidang</option><option v-for="d in catalog.departments" :value="d.id">{{d.name}}</option></select></label><button class="primary">+ Buat account</button></form></section>
          <section v-if="me.can_manage_users" class="panel wide"><p class="eyebrow">OTORISASI</p><h2>Pembagian kamera per role</h2><div class="permission-head"><select v-model="permissionRole" @change="loadPermissions"><option value="">Pilih role</option><option v-for="r in catalog.roles.filter(x=>!x.can_view_all)" :value="r.id">{{r.name}}</option></select><button class="primary" :disabled="!permissionRole" @click="savePermissions">Simpan akses</button></div><div v-if="permissionRole" class="checks"><label v-for="c in catalog.cameras"><input v-model="permissionIds" type="checkbox" :value="c.id"><span><b>{{c.name}}</b><small>{{c.location||'Tanpa lokasi'}}</small></span></label></div><p v-else class="muted">Pilih role non-administrator untuk mengatur kamera yang dapat dilihat.</p></section>
          <section class="panel wide"><p class="eyebrow">DAFTAR ASET</p><h2>Kamera terdaftar</h2><div class="table-wrap"><table><thead><tr><th>Nama</th><th>Path</th><th>Lokasi</th><th>Bidang</th><th></th></tr></thead><tbody><tr v-for="c in catalog.cameras"><td><b>{{c.name}}</b><small>{{c.brand||'Generic'}}</small></td><td><code>{{c.stream_path}}</code></td><td>{{c.location||'—'}}</td><td>{{c.department||'Umum'}}</td><td><button v-if="me.can_manage_cameras" class="danger-text" @click="removeCamera(c.id)">Hapus</button></td></tr></tbody></table></div></section>
        </div>
      </template>
    </section>
  </div>
</template>
// yoinks-web client. Five panels, one visible at a time: paste → pick →
// download → done/error. Deliberately no framework — the whole UI is ~200 lines.

const $ = id => document.getElementById(id)

const panels = {
  paste: $('paste-form'),
  pick: $('pick-panel'),
  progress: $('progress-panel'),
  done: $('done-panel'),
  sessions: $('sessions-panel'),
  error: $('error-panel'),
}

let current = {url: '', title: '', jobId: null, pollTimer: null, spotify: null}
let retentionOptions = [{hours: 4, label: '4 hours'}]
let defaultRetention = 4

function show(name) {
  for (const [key, el] of Object.entries(panels)) el.hidden = key !== name
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  const ss = String(sec).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: {'content-type': 'application/json'},
    ...options,
  })
  let body
  try {
    body = await res.json()
  } catch {
    body = {}
  }
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status}).`)
  return body
}

function showError(message) {
  stopPolling()
  $('error-message').textContent = message
  show('error')
}

function probeError(message) {
  const el = $('paste-error')
  el.textContent = message
  el.hidden = false
}

// ---------- paste ----------

$('paste-form').addEventListener('submit', async event => {
  event.preventDefault()
  const url = $('url').value.trim()
  $('paste-error').hidden = true
  if (!url) return probeError('Paste a link first.')

  const button = $('probe-btn')
  button.disabled = true
  button.textContent = 'yoinking…'
  try {
    const info = await api('/api/info', {method: 'POST', body: JSON.stringify({url})})
    current.url = url
    current.title = info.title || 'Untitled'
    current.spotify = info.spotify || null

    $('video-title').textContent = current.title
    $('video-meta').textContent =
      [`▸ ${info.extractor || new URL(url).hostname}`, formatDuration(info.duration), info.uploader]
        .filter(Boolean)
        .join(' · ')

    const thumb = $('thumb')
    if (info.thumbnail) {
      thumb.src = info.thumbnail
      thumb.hidden = false
    } else {
      thumb.hidden = true
      thumb.removeAttribute('src')
    }

    const list = $('formats')
    list.replaceChildren(
      ...info.choices.map(choice => {
        const row = document.createElement('button')
        row.type = 'button'
        row.className = 'format'
        row.dataset.kind = choice.kind
        row.setAttribute('role', 'radio')
        const label = document.createElement('span')
        label.textContent = `${choice.kind === 'audio' ? '♪' : '▶'}  ${choice.label}`
        const go = document.createElement('span')
        go.className = 'go'
        go.textContent = 'yoink →'
        row.append(label, go)
        row.addEventListener('click', () => startDownload(choice.index))
        return row
      }),
    )

    show('pick')
  } catch (error) {
    probeError(error.message)
  } finally {
    button.disabled = false
    button.textContent = 'yoink'
  }
})

$('back-btn').addEventListener('click', () => {
  show('paste')
  $('url').select()
})

// ---------- download ----------

async function startDownload(index) {
  try {
    const {job} = await api('/api/download', {
      method: 'POST',
      body: JSON.stringify({
        url: current.url,
        choice: index,
        retentionHours: Number($('retention').value),
        ...(current.spotify ? {title: current.spotify.name, artist: current.spotify.artist} : {}),
      }),
    })
    current.jobId = job.id
    $('progress-title').textContent = current.title
    $('bar').classList.add('indeterminate')
    $('bar-fill').style.width = '0%'
    ;['stat-percent', 'stat-size', 'stat-speed', 'stat-eta'].forEach(id => {
      $(id).textContent = id === 'stat-percent' ? '0%' : '—'
    })
    show('progress')
    poll()
  } catch (error) {
    showError(error.message)
  }
}

function stopPolling() {
  if (current.pollTimer) clearTimeout(current.pollTimer)
  current.pollTimer = null
}

async function poll() {
  if (!current.jobId) return
  try {
    const job = await api(`/api/jobs/${current.jobId}`)
    renderProgress(job)
  } catch (error) {
    showError(error.message)
  }
}

function renderProgress(job) {
  if (job.status === 'done') {
    stopPolling()
    $('done-title').textContent = job.title
    $('done-meta').textContent = [job.label, formatBytes(job.size)].filter(Boolean).join(' · ')

    const link = `${location.origin}/api/jobs/${job.id}/file`
    $('done-link').value = link
    if (job.expiresAt) {
      const left = job.expiresAt - Date.now()
      const hours = Math.max(0, Math.round(left / 3600000))
      const when = new Date(job.expiresAt).toLocaleString()
      $('done-expiry').textContent = `link works for ${hours >= 24 ? `${Math.round(hours / 24)} day(s)` : `${hours} hour(s)`} — until ${when}`
    } else {
      $('done-expiry').textContent = ''
    }
    show('done')
    return
  }
  if (job.status === 'error' || job.status === 'cancelled') {
    showError(job.error || 'Download failed.')
    return
  }

  const processing = job.status === 'processing'
  // Prefer bytes actually on disk: HLS downloads report per-fragment counts, so
  // the raw yt-dlp numbers can drift past the real file size.
  const done = job.bytesOnDisk || job.downloadedBytes || 0
  const total = job.totalBytes || 0
  const known = total > 0 && done > 0 && !processing
  const ratio = known ? Math.min(1, done / total) : 0
  const bar = $('bar')

  bar.classList.toggle('indeterminate', !known)
  if (known) $('bar-fill').style.width = `${(ratio * 100).toFixed(1)}%`
  bar.setAttribute('aria-valuenow', known ? String(Math.round(ratio * 100)) : '0')

  $('stat-percent').textContent = processing ? 'merging…' : known ? `${Math.floor(ratio * 100)}%` : 'starting…'
  $('stat-size').textContent = formatBytes(Math.min(done, total || done)) || '—'
  $('stat-speed').textContent = formatBytes(job.speed) ? `${formatBytes(job.speed)}/s` : '—'
  $('stat-eta').textContent = processing ? '—' : formatDuration(job.eta) || '—'

  const part = job.totalParts > 1 ? `part ${job.part + 1}/${job.totalParts} · ` : ''
  $('progress-title').textContent = `${part}${current.title}`

  current.pollTimer = setTimeout(poll, 700)
}

$('cancel-btn').addEventListener('click', async () => {
  stopPolling()
  if (current.jobId) {
    try {
      await fetch(`/api/jobs/${current.jobId}`, {method: 'DELETE'})
    } catch {
      // the job is gone either way; the UI just moves on
    }
  }
  current.jobId = null
  show('paste')
})

// ---------- done ----------

$('save-btn').addEventListener('click', () => {
  if (current.jobId) location.href = `/api/jobs/${current.jobId}/file`
})

$('copy-btn').addEventListener('click', async () => {
  const button = $('copy-btn')
  try {
    await navigator.clipboard.writeText($('done-link').value)
    button.textContent = 'copied ✓'
  } catch {
    // clipboard may be blocked on http or without permission — fall back to select
    $('done-link').select()
    button.textContent = 'press ⌘/ctrl+c'
  }
  setTimeout(() => (button.textContent = 'copy link'), 1800)
})

$('again-btn').addEventListener('click', () => {
  current.jobId = null
  current.spotify = null
  $('url').value = ''
  show('paste')
  async function loadConfig() {
  try {
    const cfg = await api('/api/config')
    retentionOptions = cfg.retention.options
    defaultRetention = cfg.retention.defaultHours
  } catch {
    // keep the built-in 4 hour default
  }
  const select = $('retention')
  select.replaceChildren(
    ...retentionOptions.map(option => {
      const el = document.createElement('option')
      el.value = String(option.hours)
      el.textContent = option.label
      return el
    }),
  )
  select.value = String(defaultRetention)
}

void loadConfig()

$('url').focus()
})

$('error-back-btn').addEventListener('click', () => {
  show('paste')
  $('url').select()
})

// ---------- signed-in sites ----------

let sessionsLoaded = false

/** Domain to synthesise when the pasted data has no domain of its own. */
const SITE_DOMAIN = {
  youtube: '.youtube.com',
  x: '.x.com',
  instagram: '.instagram.com',
  tiktok: '.tiktok.com',
  reddit: '.reddit.com',
  vimeo: '.vimeo.com',
  facebook: '.facebook.com',
  twitch: '.twitch.tv',
  threads: '.threads.net',
}

async function loadSessions() {
  const data = await api('/api/cookies')
  const stored = new Map(data.stored.map(entry => [entry.key, entry]))

  const select = $('cookie-site')
  if (!select.options.length) {
    select.replaceChildren(
      ...data.sites.map(site => {
        const option = document.createElement('option')
        option.value = site.key
        option.textContent = site.label
        return option
      }),
    )
  }

  const list = $('sessions-list')
  list.replaceChildren(
    ...data.sites.map(site => {
      const entry = stored.get(site.key)
      const row = document.createElement('div')
      row.className = 'session'

      const left = document.createElement('div')
      const name = document.createElement('div')
      name.className = 'session-name'
      name.textContent = site.label
      const meta = document.createElement('div')
      meta.className = 'session-meta'
      meta.textContent = entry
        ? `${entry.cookies} cookies · saved ${new Date(entry.savedAt).toLocaleDateString()}`
        : site.domains.slice(0, 2).join(', ')
      left.append(name, meta)

      const right = document.createElement('div')
      right.style.display = 'flex'
      right.style.alignItems = 'center'
      right.style.gap = '8px'

      const state = document.createElement('span')
      state.className = `session-state${entry ? ' on' : ''}`
      state.textContent = entry ? 'signed in' : 'no session'
      right.append(state)

      if (entry) {
        const remove = document.createElement('button')
        remove.type = 'button'
        remove.className = 'btn btn-ghost btn-sm'
        remove.textContent = 'remove'
        remove.addEventListener('click', async () => {
          remove.disabled = true
          await fetch(`/api/cookies/${site.key}`, {method: 'DELETE'})
          await loadSessions()
        })
        right.append(remove)
      }

      row.append(left, right)
      return row
    }),
  )
}

async function openSessions() {
  $('cookie-error').hidden = true
  show('sessions')
  try {
    await loadSessions()
    sessionsLoaded = true
  } catch (error) {
    $('cookie-error').textContent = error.message
    $('cookie-error').hidden = false
  }
}

$('sessions-open').addEventListener('click', openSessions)
$('sessions-back').addEventListener('click', () => show('paste'))

function selectTab(which) {
  const paste = which === 'paste'
  $('tab-paste').classList.toggle('active', paste)
  $('tab-file').classList.toggle('active', !paste)
  $('tab-paste').setAttribute('aria-selected', String(paste))
  $('tab-file').setAttribute('aria-selected', String(!paste))
  $('pane-paste').hidden = !paste
  $('pane-file').hidden = paste
}

$('tab-paste').addEventListener('click', () => selectTab('paste'))
$('tab-file').addEventListener('click', () => selectTab('file'))

/**
 * The extension offers JSON, Header String and Netscape. Only Netscape is what
 * yt-dlp reads, but a user pasting the other two (or the raw "name=value; …"
 * header) should still get a working session rather than a dead end.
 */
function normalisePastedCookies(text, hostHint) {
  const trimmed = text.trim()
  if (!trimmed) return ''

  if (trimmed.startsWith('# Netscape HTTP Cookie File')) return trimmed
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed)
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.cookies) ? parsed.cookies : null
      if (list) {
        const lines = list
          .filter(c => c && c.name)
          .map(c => {
            const domain = c.domain || hostHint || ''
            const hostOnly = !String(domain).startsWith('.')
            const expires = c.expirationDate ? Math.floor(c.expirationDate) : Math.floor(Date.now() / 1000) + 86400 * 180
            return [domain, hostOnly ? 'FALSE' : 'TRUE', c.path || '/', 'TRUE', expires, c.name, c.value ?? ''].join('\t')
          })
        if (lines.length) return ['# Netscape HTTP Cookie File', ...lines].join('\n')
      }
    } catch {
      // not JSON after all
    }
  }

  // Cookie header string: "auth_token=…; ct0=…"
  if (trimmed.includes('=') && !trimmed.includes('\t')) {
    const host = hostHint || '.x.com'
    const lines = trimmed
      .split(';')
      .map(pair => pair.trim())
      .filter(Boolean)
      .map(pair => {
        const index = pair.indexOf('=')
        if (index < 1) return null
        const name = pair.slice(0, index).trim()
        const value = pair.slice(index + 1).trim()
        const expires = Math.floor(Date.now() / 1000) + 86400 * 180
        return [host.startsWith('.') ? host : `.${host}`, 'TRUE', '/', 'TRUE', expires, name, value].join('\t')
      })
      .filter(Boolean)
    if (lines.length) return ['# Netscape HTTP Cookie File', ...lines].join('\n')
  }

  return trimmed
}

// A long paste leaves the caret at the end; scroll back so the user can see
// that the "# Netscape HTTP Cookie File" line is really there.
$('cookie-text').addEventListener('input', event => {
  if (event.target.selectionStart === event.target.value.length) event.target.scrollTop = 0
})

$('cookie-save').addEventListener('click', async () => {
  const err = $('cookie-error')
  err.hidden = true
  const site = $('cookie-site').value
  const usingPaste = !$('pane-paste').hidden

  let text = ''
  if (usingPaste) {
    text = $('cookie-text').value
  } else {
    const file = $('cookie-file').files && $('cookie-file').files[0]
    if (!file) {
      err.textContent = 'Choose a cookies.txt file first, or switch to paste.'
      err.hidden = false
      return
    }
    text = await file.text()
  }

  if (!text.trim()) {
    err.textContent = usingPaste ? 'Paste the exported cookies first.' : 'That file is empty.'
    err.hidden = false
    return
  }

  text = normalisePastedCookies(text, SITE_DOMAIN[site] || null)

  const button = $('cookie-save')
  button.disabled = true
  try {
    await api(`/api/cookies/${site}`, {
      method: 'PUT',
      headers: {'content-type': 'text/plain'},
      body: text,
    })
    $('cookie-text').value = ''
    $('cookie-file').value = ''
    await loadSessions()
    $('cookie-note').textContent = 'Saved on this server — it will be used from every device.'
  } catch (error) {
    err.textContent = error.message
    err.hidden = false
  } finally {
    button.disabled = false
  }
})

// ---------- boot ----------

async function loadConfig() {
  try {
    const cfg = await api('/api/config')
    retentionOptions = cfg.retention.options
    defaultRetention = cfg.retention.defaultHours
  } catch {
    // keep the built-in 4 hour default
  }
  const select = $('retention')
  select.replaceChildren(
    ...retentionOptions.map(option => {
      const el = document.createElement('option')
      el.value = String(option.hours)
      el.textContent = option.label
      return el
    }),
  )
  select.value = String(defaultRetention)
}

void loadConfig()

$('url').focus()

fetch('/healthz')
  .then(res => res.json())
  .then(data => {
    $('engine-status').textContent = data.ytdlp ? 'powered by yt-dlp' : 'yt-dlp is starting…'
  })
  .catch(() => {
    $('engine-status').textContent = 'engine offline'
  })

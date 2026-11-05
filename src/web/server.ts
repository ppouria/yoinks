/**
 * yoinks-web — an HTTP wrapper around the same yt-dlp plumbing the TUI uses.
 *
 * The terminal app and this server share src/lib/ytdlp.ts for probing and
 * downloading; the only new pieces here are a job queue (so a browser can
 * poll progress instead of owning the yt-dlp pipe), a capped disk budget,
 * and static file serving for src/web/public.
 *
 * Runtime contract (Rebecca's Node.js external-app unit relies on it):
 *   listen on process.env.PORT at process.env.HOST, entry `npm run start`.
 */
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http'
import {createReadStream} from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {buildChoices, download, ensureYtDlp, findFfmpeg, probe, type DownloadChoice} from '../lib/ytdlp.js'
import {isProbablyUrl} from '../lib/platforms.js'
import {CookieStore, KNOWN_SITES, siteForUrl} from './cookies.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(HERE, 'public')

const HOST = process.env.HOST || '127.0.0.1'
const PORT = Number(process.env.PORT || 3000)
/**
 * Downloads live next to the deployed app rather than in the OS temp dir:
 * Rebecca runs external apps with PrivateTmp=yes, so /tmp is private *and*
 * wiped on restart — a job that survived a redeploy would lose its file.
 */
const WORK_DIR = process.env.YOINKS_WORK_DIR || path.resolve('downloads')
/** Downloads are deleted after this long; nothing here is meant to be an archive. */
const FILE_TTL_MS = Number(process.env.YOINKS_FILE_TTL_MS || 60 * 60 * 1000)
/** Hard cap on everything sitting in WORK_DIR (files + in-progress downloads). */
const DIR_BUDGET_BYTES = Number(process.env.YOINKS_DIR_BUDGET_BYTES || 8 * 1024 ** 3)
/** Concurrent yt-dlp downloads. Hetzner box is small; 2 keeps things civil. */
const MAX_ACTIVE = Number(process.env.YOINKS_MAX_ACTIVE || 2)
/** A probe that hangs holds a request slot; don't let it. */
const PROBE_TIMEOUT_MS = Number(process.env.YOINKS_PROBE_TIMEOUT_MS || 90_000)
/**
 * Per-site cookie jars, one file per platform. yt-dlp never logs in for us —
 * these jars are what carry a session for YouTube, X, Instagram and friends.
 */
const COOKIE_DIR = process.env.YOINKS_COOKIE_DIR || path.resolve('cookies')
const cookies = new CookieStore(COOKIE_DIR)
/**
 * Painful escape hatch for a single jar covering everything (the old
 * behaviour). Applied only when no per-site jar matches the URL.
 */
const LEGACY_COOKIES_FILE = process.env.YOINKS_COOKIES_FILE || ''

/**
 * Which cookie file (if any) applies to a download of this URL.
 * Settings-only sites are validated per-site so one site's session is never
 * presented to another.
 */
async function cookiesFor(url: string): Promise<string | undefined> {
  return (await cookies.jarForUrl(url)) || LEGACY_COOKIES_FILE || undefined
}

type JobStatus = 'queued' | 'downloading' | 'processing' | 'done' | 'error' | 'cancelled'

type Job = {
  id: string
  url: string
  choice: DownloadChoice
  title: string
  status: JobStatus
  downloadedBytes: number
  totalBytes?: number
  speed?: number
  eta?: number
  part: number
  totalParts: number
  /** Latest measured size of everything yt-dlp has written for this job. */
  bytesOnDisk: number
  filepath?: string
  filename?: string
  size?: number
  error?: string
  createdAt: number
  expiresAt?: number
  abort: AbortController
}

const jobs = new Map<string, Job>()
let ytdlpPath = ''
let ffmpegLocation: string | undefined

// ---------- helpers ----------

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function readJson(req: IncomingMessage, limit = 16 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new HttpError(413, 'Request body too large.')
    chunks.push(chunk as Buffer)
  }
  if (size === 0) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return parsed as Record<string, unknown>
  } catch {
    throw new HttpError(400, 'Body must be a JSON object.')
  }
}

/**
 * Accepts either a raw Netscape file in the body, or JSON {cookies: "..."}.
 * Uploading a real file with curl is far more comfortable than escaping it.
 */
async function readCookieUpload(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 2 * 1024 * 1024) throw new HttpError(413, 'Cookies file is too large (2 MB max).')
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  const type = (req.headers['content-type'] || '').toLowerCase()
  if (type.includes('application/json')) {
    try {
      const parsed = JSON.parse(text) as {cookies?: unknown}
      if (typeof parsed.cookies === 'string') return parsed.cookies
    } catch {
      // fall through — maybe it really is a jar
    }
  }
  return text
}

function assertUrl(value: unknown): string {
  const url = typeof value === 'string' ? value.trim() : ''
  if (!url || !isProbablyUrl(url)) throw new HttpError(400, "That doesn’t look like a link — paste a full http(s) URL.")
  return url
}

function makeId(): string {
  return Array.from({length: 10}, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('')
}

/** Never let a page-supplied title-ish string escape out of WORK_DIR. */
function safeFilename(filepath: string, fallbackExt: string): string {
  const base = path.basename(filepath).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim()
  const named = base && base !== '.' && base !== '..' ? base : `yoink-${Date.now()}${fallbackExt}`
  return named.slice(0, 120)
}

async function dirSize(dir: string): Promise<number> {
  let total = 0
  let entries
  try {
    entries = await fs.readdir(dir, {withFileTypes: true})
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    try {
      const stat = await fs.stat(full)
      if (stat.isFile()) total += stat.size
    } catch {
      // raced with cleanup — fine
    }
  }
  return total
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Probe throws raw yt-dlp text; make the common walls say something actionable. */
function friendlyError(message: string): string {
  const text = message.replace(/^ERROR:\s*/i, '').trim()
  const raw = text.slice(0, 300)
  if (/sign in to confirm you.?re not a bot/i.test(text)) {
    return 'YouTube is asking this server to sign in first (IP-level bot check). YouTube links mostly fail here; other sites work.'
  }
  if (/impersonat/i.test(text)) {
    return 'That site wants a browser-impersonating downloader, which this server does not have.'
  }
  if (/unsupported url|no suitable extractor/i.test(text)) return 'That site isn’t supported by yt-dlp.'
  if (/private video|video unavailable|has been removed|does not exist/i.test(text)) return 'That video isn’t available.'
  if (/http error 429|too many requests/i.test(text)) return 'The site is rate-limiting this server. Try again in a minute.'
  if (/timed out|timeout/i.test(text)) return 'The site took too long to answer.'
  return raw || 'yt-dlp failed for an unknown reason.'
}

// ---------- job lifecycle ----------

function publicJob(job: Job) {
  return {
    id: job.id,
    status: job.status,
    title: job.title,
    label: job.choice.label,
    kind: job.choice.kind,
    downloadedBytes: job.downloadedBytes,
    totalBytes: job.totalBytes,
    bytesOnDisk: job.bytesOnDisk,
    speed: job.speed,
    eta: job.eta,
    part: job.part,
    totalParts: job.totalParts,
    filename: job.status === 'done' ? job.filename : undefined,
    size: job.status === 'done' ? job.size : undefined,
    error: job.error,
  }
}

function activeCount(): number {
  let count = 0
  for (const job of jobs.values()) {
    if (job.status === 'downloading' || job.status === 'processing' || job.status === 'queued') count++
  }
  return count
}

let sampling = new Set<string>()
/**
 * Serialized per job: HLS downloads report per-fragment byte counts, which are
 * nowhere near the size of the file yt-dlp eventually writes. Measuring the
 * output directory is the only honest progress figure for those.
 */
async function sampleBytesOnDisk(job: Job): Promise<void> {
  if (sampling.has(job.id)) return
  sampling.add(job.id)
  try {
    job.bytesOnDisk = Math.max(job.bytesOnDisk, await dirSize(path.join(WORK_DIR, job.id)))
  } finally {
    sampling.delete(job.id)
  }
}

function startJob(job: Job): void {
  void (async () => {
    try {
      job.status = 'downloading'
      const outDir = path.join(WORK_DIR, job.id)
      await fs.mkdir(outDir, {recursive: true})
      const filepath = await download(
        {
          ytdlp: ytdlpPath,
          ffmpegLocation,
          url: job.url,
          choice: job.choice,
          outDir,
          filenameTemplate: '%(title)s.%(ext)s',
          cookiesFile: await cookiesFor(job.url),
        },
        {
          onProgress: progress => {
            job.downloadedBytes = progress.downloadedBytes
            job.totalBytes = progress.totalBytes
            job.speed = progress.speed
            job.eta = progress.eta
            job.part = progress.part
            job.totalParts = progress.totalParts
            job.status = 'downloading'
            void sampleBytesOnDisk(job)
          },
          onProcessing: () => {
            job.status = 'processing'
          },
        },
        job.abort.signal,
      )
      const stat = await fs.stat(filepath)
      job.filepath = filepath
      job.filename = safeFilename(filepath, job.choice.kind === 'audio' ? '.mp3' : '.mp4')
      job.size = stat.size
      // The per-stream counters describe yt-dlp's transport, not the file it
      // wrote (a merged video+audio download reports only the last stream).
      job.bytesOnDisk = stat.size
      job.downloadedBytes = stat.size
      job.totalBytes = stat.size
      job.status = 'done'
      job.expiresAt = Date.now() + FILE_TTL_MS
    } catch (error) {
      const cancelled = job.abort.signal.aborted
      job.status = cancelled ? 'cancelled' : 'error'
      const raw = error instanceof Error ? error.message : String(error)
      if (!cancelled) console.error(`download ${job.id} failed:`, raw.slice(0, 300))
      job.error = cancelled ? 'Cancelled.' : friendlyError(raw)
      await fs.rm(path.join(WORK_DIR, job.id), {recursive: true, force: true})
    }
  })()
}

async function reapExpired(): Promise<void> {
  const now = Date.now()
  for (const [id, job] of jobs) {
    if (job.status === 'done' && job.expiresAt && job.expiresAt < now) {
      await fs.rm(path.join(WORK_DIR, id), {recursive: true, force: true})
      jobs.delete(id)
    } else if (job.status === 'error' || job.status === 'cancelled') {
      if (now - job.createdAt > FILE_TTL_MS) jobs.delete(id)
    }
  }
}

// ---------- routes ----------

async function handleProbe(body: Record<string, unknown>) {
  const url = assertUrl(body.url)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const {info} = await probe(ytdlpPath, url, {
      cookiesFile: await cookiesFor(url),
      saveInfo: false,
      signal: controller.signal,
    })
    return {
      title: info.title,
      uploader: info.uploader,
      duration: info.duration,
      thumbnail: info.thumbnail,
      extractor: info.extractor_key,
      choices: buildChoices(info).map((choice, index) => ({
        index,
        label: choice.label,
        kind: choice.kind,
      })),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`probe failed for ${url}:`, message.slice(0, 300))
    if (controller.signal.aborted) throw new HttpError(422, 'Timed out reading that link.')

    const friendly = friendlyError(message)
    // If this site can carry a session and we have none, say so — the most
    // common cause of "works in my browser, fails here" is simply no cookies.
    const site = siteForUrl(url)
    if (site && !(await cookiesFor(url)) && /sign in|login|log in|authentication|not available|no video/i.test(message)) {
      throw new HttpError(422, `${friendly} — ${site.label} can be signed in from “signed-in sites” below.`)
    }
    throw new HttpError(422, friendly)
  } finally {
    clearTimeout(timer)
  }
}

async function handleDownload(body: Record<string, unknown>) {
  const url = assertUrl(body.url)
  const index = Number(body.choice)
  if (!Number.isInteger(index) || index < 0) throw new HttpError(400, 'Pick a format first.')

  // Re-probe so the choice index can't be forged into arbitrary yt-dlp args.
  const {info} = await probe(ytdlpPath, url, {
    cookiesFile: await cookiesFor(url),
    saveInfo: false,
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  })
  const choices = buildChoices(info)
  const choice = choices[index]
  if (!choice) throw new HttpError(400, 'That format is no longer offered for this link.')

  const used = await dirSize(WORK_DIR)
  if (used > DIR_BUDGET_BYTES) {
    // drop the oldest finished files before refusing; transient cache should self-heal
    await reapExpired()
    const after = await dirSize(WORK_DIR)
    if (after > DIR_BUDGET_BYTES) throw new HttpError(507, 'The server’s download space is full right now. Try again shortly.')
  }

  const job: Job = {
    id: makeId(),
    url,
    choice,
    title: info.title ?? 'Untitled',
    status: 'queued',
    downloadedBytes: 0,
    bytesOnDisk: 0,
    part: 0,
    totalParts: 1,
    createdAt: Date.now(),
    abort: new AbortController(),
  }
  jobs.set(job.id, job)
  startJob(job)
  return {job: publicJob(job)}
}

async function waitForSlot(job: Job): Promise<void> {
  let guard = 0
  while (activeCount() > MAX_ACTIVE && jobs.get(job.id)?.status === 'queued' && guard++ < 600) await sleep(250)
}

async function handleFile(job: Job, req: IncomingMessage, res: ServerResponse) {
  if (job.status !== 'done' || !job.filepath || !job.filename) throw new HttpError(404, 'That download isn’t ready.')
  const stat = await fs.stat(job.filepath)
  const range = req.headers.range
  const headers: Record<string, string> = {
    'content-type': job.choice.kind === 'audio' ? 'audio/mpeg' : 'video/mp4',
    'content-disposition': `attachment; filename="${job.filename.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(job.filename)}`,
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=0',
  }

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (match) {
      const start = match[1] ? Number(match[1]) : 0
      const end = match[2] ? Number(match[2]) : stat.size - 1
      if (start >= stat.size || end >= stat.size || start > end) {
        res.writeHead(416, {'content-range': `bytes */${stat.size}`})
        res.end()
        return
      }
      res.writeHead(206, {...headers, 'content-range': `bytes ${start}-${end}/${stat.size}`, 'content-length': String(end - start + 1)})
      createReadStream(job.filepath, {start, end}).pipe(res)
      return
    }
  }

  res.writeHead(200, {...headers, 'content-length': String(stat.size)})
  createReadStream(job.filepath).pipe(res)
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<boolean> {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const file = path.join(PUBLIC_DIR, relative)
  // resolve both sides so `..` can never climb out of public/
  if (!path.resolve(file).startsWith(path.resolve(PUBLIC_DIR) + path.sep) && path.resolve(file) !== path.join(path.resolve(PUBLIC_DIR), 'index.html')) {
    return false
  }
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile()) return false
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'content-length': String(stat.size),
      'cache-control': 'no-cache',
    })
    createReadStream(file).pipe(res)
    return true
  } catch {
    return false
  }
}

const server = createServer((req, res) => {
  const startedAt = Date.now()
  const method = req.method ?? 'GET'
  void (async () => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const pathname = url.pathname
    res.on('finish', () => {
      // One line per request; systemd/journald is the only log sink on the server.
      console.log(`${method} ${pathname} ${res.statusCode} ${Date.now() - startedAt}ms`)
    })

    try {
      if (pathname === '/healthz') return json(res, 200, {ok: true, ytdlp: Boolean(ytdlpPath), active: activeCount()})

      // ---- cookies: which sites can carry a session, and which ones do ----
      if (pathname === '/api/cookies' && method === 'GET') {
        return json(res, 200, {sites: KNOWN_SITES, stored: await cookies.list()})
      }
      // Does this URL's site have a session we could use?
      if (pathname === '/api/cookies/lookup' && method === 'POST') {
        const {url} = await readJson(req)
        const site = typeof url === 'string' ? siteForUrl(url) : undefined
        const jar = site ? await cookies.jarForUrl(url as string) : undefined
        return json(res, 200, {site: site ?? null, hasCookies: Boolean(jar)})
      }

      const cookieSite = /^\/api\/cookies\/([a-z]+)$/.exec(pathname)
      if (cookieSite) {
        const key = cookieSite[1]!
        if (method === 'PUT' || method === 'POST') {
          let saved
          try {
            saved = await cookies.save(key, await readCookieUpload(req))
          } catch (error) {
            // a bad file is the caller's mistake, not a server fault
            throw new HttpError(400, error instanceof Error ? error.message : 'That cookies file was rejected.')
          }
          console.log(`cookies: stored jar for ${key} (${saved.cookies} entries)`)
          return json(res, 200, {stored: saved})
        }
        if (method === 'DELETE') {
          await cookies.remove(key)
          console.log(`cookies: removed jar for ${key}`)
          return json(res, 200, {ok: true})
        }
      }

      if (pathname === '/api/info' && method === 'POST') return json(res, 200, await handleProbe(await readJson(req)))
      if (pathname === '/api/download' && method === 'POST') {
        const result = await handleDownload(await readJson(req))
        return json(res, 202, result)
      }

      const jobMatch = /^\/api\/jobs\/([a-z0-9]{10})$/.exec(pathname)
      if (jobMatch) {
        const job = jobs.get(jobMatch[1]!)
        if (!job) throw new HttpError(404, 'Unknown download.')
        if (method === 'GET') return json(res, 200, publicJob(job))
        if (method === 'DELETE') {
          job.abort.abort()
          jobs.delete(job.id)
          await fs.rm(path.join(WORK_DIR, job.id), {recursive: true, force: true})
          return json(res, 200, {ok: true})
        }
      }

      const fileMatch = /^\/api\/jobs\/([a-z0-9]{10})\/file$/.exec(pathname)
      if (fileMatch && method === 'GET') {
        const job = jobs.get(fileMatch[1]!)
        if (!job) throw new HttpError(404, 'Unknown download.')
        return await handleFile(job, req, res)
      }

      if (method === 'GET' || method === 'HEAD') {
        if (await serveStatic(pathname, res)) return
      }

      json(res, 404, {error: 'Not found.'})
    } catch (error) {
      if (res.headersSent) {
        res.destroy()
        return
      }
      const status = error instanceof HttpError ? error.status : 500
      const message = error instanceof Error ? error.message : 'Something went wrong.'
      if (status >= 500) console.error(`${method} ${pathname} failed:`, message)
      json(res, status, {error: message})
    }
  })()
})

async function main(): Promise<void> {
  await fs.mkdir(WORK_DIR, {recursive: true})
  await cookies.init()
  // Start listening first so the panel's health check passes while yt-dlp resolves.
  server.on('error', error => {
    console.error(`[server] cannot listen on ${HOST}:${PORT}:`, error instanceof Error ? error.message : error)
    process.exit(1)
  })
  server.listen(PORT, HOST, () => {
    console.log(`yoinks-web listening on ${HOST}:${PORT} (work dir: ${WORK_DIR})`)
  })

  try {
    ytdlpPath = await ensureYtDlp(message => console.log(`[yt-dlp] ${message}`))
    ffmpegLocation = await findFfmpeg()
    console.log(`[yt-dlp] ${ytdlpPath}${ffmpegLocation ? `, ffmpeg ${ffmpegLocation}` : ', system ffmpeg'}`)
  } catch (error) {
    console.error('[yt-dlp] failed to prepare:', error instanceof Error ? error.message : error)
  }

  setInterval(() => void reapExpired(), 60_000).unref()
}

process.on('SIGTERM', () => {
  for (const job of jobs.values()) job.abort.abort()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
})

export {server, main}

if (process.env.NODE_ENV !== 'test' && !process.env.YOINKS_WEB_NO_AUTOSTART) void main()

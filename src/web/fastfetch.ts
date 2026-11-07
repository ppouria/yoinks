/**
 * Fast media fetching.
 *
 * Profiling a Spotify job on the server showed the download itself is never the
 * bottleneck: googlevideo serves the whole 3.3MB track in ~200ms when the byte
 * ranges are requested in parallel. The seconds were all yt-dlp overhead —
 * ~0.5s Python startup, then several serial round-trips (webpage, player API,
 * player JS, Deno JS-challenge) before a single byte moves.
 *
 * So this module splits the work in two:
 *   1. resolve()  — yt-dlp, but only for a signed stream URL, cached for the
 *                   life of that URL (googlevideo signs them for ~6 hours).
 *                   `player_client=visionos` is used because it needs no JS
 *                   challenge, which removes the slowest extractor step.
 *   2. fetch()    — plain HTTP range requests, in parallel, straight from the
 *                   CDN. No yt-dlp in the hot path at all.
 *
 * Anything this cannot handle (HLS/live, sites without a direct stream) falls
 * back to the normal yt-dlp download in server.ts.
 */
import {spawn} from 'node:child_process'
import fs from 'node:fs/promises'
import {createWriteStream} from 'node:fs'

/** googlevideo encodes the container in the URL (mime=audio%2Fwebm, itag=251…). */
function mimeFromUrl(streamUrl: string): string | undefined {
  try {
    const params = new URL(streamUrl).searchParams
    const mime = params.get('mime')
    if (mime) return mime.replace('/', '/')
    const itag = Number(params.get('itag'))
    // 140/141/251/252 are audio-only; 18/22 are progressive mp4.
    if ([140, 141, 251, 252].includes(itag)) return itag === 140 || itag === 141 ? 'audio/mp4' : 'audio/webm'
    if ([18, 22].includes(itag)) return 'video/mp4'
  } catch {
    // not a URL we can parse; the caller falls back to a generic extension
  }
  return undefined
}

export type ResolvedStream = {
  url: string
  /** True when the resolved stream carries video too and needs extraction. */
  needsExtract?: boolean
  /** Content length, when the CDN reports it. */
  size?: number
  mime?: string
  resolvedAt: number
}

/**
 * Extractors that hand out a single direct file. HLS/m3u8 and DASH manifests
 * are excluded: they need segmentation, which is exactly what yt-dlp is for.
 */
const DIRECT_HOSTS = ['youtube.com', 'youtu.be', 'soundcloud.com']

/** Deezer hands out a plain CDN file, so no resolve step is needed. */
export function isDirectFile(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host.endsWith('dzcdn.net') || host.endsWith('deezer.com') || host.endsWith('.deezer.com')
  } catch {
    return false
  }
}

export function supportsFastPath(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return DIRECT_HOSTS.some(h => host === h || host.endsWith(`.${h}`))
  } catch {
    return false
  }
}

const cache = new Map<string, ResolvedStream>()
/**
 * googlevideo signs URLs for hours but ties them to request parameters, and a
 * URL minted during a probe is frequently rejected by the time the download
 * starts ("stream url expired" → 403). Keep the cache short: long enough to
 * absorb a double-click, short enough to always be fresh.
 */
const RESOLVE_TTL_MS = 45 * 1000

function runYtDlp(ytdlp: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ytdlp, args, {signal: AbortSignal.timeout(timeoutMs)})
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk: Buffer) => (out += chunk))
    child.stderr.on('data', (chunk: Buffer) => (err += chunk))
    child.on('error', reject)
    child.on('close', code => {
      const first = out.split('\n').map(l => l.trim()).find(l => l.startsWith('http'))
      if (code === 0 && first) resolve(first)
      else reject(new Error(err.trim().split('\n').at(-1) || `yt-dlp exited with ${code}`))
    })
  })
}

/**
 * Drop a cached URL. Stream URLs are signed and short-lived, and googlevideo
 * starts answering 403 once one lapses — a stale entry must not poison every
 * later download of the same link.
 */
export function invalidateStream(url: string): void {
  for (const key of [...cache.keys()]) {
    if (key.endsWith(`:${url}`)) cache.delete(key)
  }
}

/** Memoise in-flight resolutions so two requests don't spawn yt-dlp twice. */
const inFlight = new Map<string, Promise<ResolvedStream>>()

/** A URL that is already the media itself — nothing to resolve. */
export function directStream(url: string): ResolvedStream {
  // Carry the type from the URL: without a mime the caller cannot tell an mp3
  // from a webm, and an audio job would be written with the wrong extension.
  let mime: string | undefined
  try {
    const pathname = new URL(url).pathname.toLowerCase()
    if (pathname.endsWith('.mp3')) mime = 'audio/mpeg'
    else if (pathname.endsWith('.flac')) mime = 'audio/flac'
    else if (pathname.endsWith('.m4a')) mime = 'audio/mp4'
    else if (pathname.endsWith('.webm')) mime = 'audio/webm'
  } catch {
    // not a parseable URL; the extension falls back to a default
  }
  return {url, mime, resolvedAt: Date.now()}
}

export async function resolveStream(
  ytdlp: string,
  url: string,
  opts: {cookiesFile?: string; preferAudio: boolean; height?: number},
): Promise<ResolvedStream> {
  const key = `${opts.preferAudio ? 'a' : 'v'}:${opts.height ?? ''}:${url}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.resolvedAt < RESOLVE_TTL_MS) return hit

  const pending = inFlight.get(key)
  if (pending) return pending

  const ticket = (async () => {
    // Audio: best audio. Video: the requested height, but only as a progressive
    // (already muxed) file — anything else needs ffmpeg, i.e. yt-dlp's job.
    // `ba/b` means "best audio, else muxed best". Some player clients expose
    // only one half and answer the combined spec with "Requested format is not
    // available" even though the other exists — so try several equivalent
    // specs per client instead of assuming one works everywhere.
    // For audio, only an audio-bearing stream is acceptable — `b` (muxed video)
    // would ship a 10MB video for a 3MB song. When no audio-only format exists
    // yt-dlp reports the failure and the caller falls back to its own download,
    // which merges/extracts with ffmpeg.
    const formats = opts.preferAudio
      ? ['ba', 'bestaudio', '140/140-drc/251']

      : opts.height
        ? [`b[height<=${opts.height}]`, `bv*[height<=${opts.height}]+ba/b[height<=${opts.height}]`, 'b']
        : ['b', 'bv*+ba/b']

    // Which player client works depends on whether we are signed in, and that
    // is not predictable per video:
    //   anonymous → visionos/tv_simply answer without a JS challenge
    //   signed in → those return storyboards only, and `web` is the one that
    //               yields a fetchable stream (mweb resolves but its URL 403s)
    // Each yt-dlp invocation costs ~0.5s of start-up plus network, so the list
    // is short and ordered for the session we actually have — trying every
    // combination turned a download into a minute of process spawns.
    const clients = opts.cookiesFile ? ['web', 'visionos'] : ['visionos', 'web']

    let streamUrl: string | undefined
    let lastError: unknown
    for (const format of formats) {
      for (const client of clients) {
        const args = [
          '-g',
          '-f',
          format,
          '--no-playlist',
          '--no-warnings',
          '--extractor-args',
          `youtube:player_client=${client}`,
        ]
        if (opts.cookiesFile) args.push('--cookies', opts.cookiesFile)
        args.push(url)
        try {
          const t0 = Date.now()
          const candidate = await runYtDlp(ytdlp, args, 20_000)
          // Only a direct file is usable; HLS needs yt-dlp's own downloader.
          if (candidate.includes('.m3u8')) {
            lastError = new Error('resolved to an HLS manifest')
            continue
          }
          console.log(`[fast] resolved via ${client} (${format}) in ${Date.now() - t0}ms`)
          streamUrl = candidate
          break
        } catch (error) {
          lastError = error
        }
      }
      if (streamUrl) break
    }

    // Some videos genuinely have no audio-only stream (only itag 18, a muxed
    // 240p file). Fetching that is still far faster than a full yt-dlp
    // download; the caller strips the video track with ffmpeg afterwards.
    let needsExtract = false
    if (!streamUrl && opts.preferAudio) {
      for (const client of clients) {
        const args = ['-g', '-f', 'b', '--no-playlist', '--no-warnings', '--extractor-args', `youtube:player_client=${client}`]
        if (opts.cookiesFile) args.push('--cookies', opts.cookiesFile)
        args.push(url)
        try {
          const candidate = await runYtDlp(ytdlp, args, 20_000)
          if (candidate.includes('.m3u8')) continue
          streamUrl = candidate
          needsExtract = true
          break
        } catch (error) {
          lastError = error
        }
      }
    }

    if (!streamUrl) throw lastError ?? new Error('no direct stream available')

    // Size and type come from curl for the same reason the download does:
    // Node's client is rejected by this CDN. Failure here is not fatal — the
    // fetch below will surface a real problem — so it never aborts the attempt.
    const [size, mime] = await Promise.all([
      contentLength(streamUrl).catch(() => undefined),
      (async () => {
        try {
          return await curlContentType(streamUrl)
        } catch {
          return undefined
        }
      })(),
    ])

    const resolved: ResolvedStream = {
      url: streamUrl,
      needsExtract,
      size,
      mime: mime ?? mimeFromUrl(streamUrl),
      resolvedAt: Date.now(),
    }
    cache.set(key, resolved)
    return resolved
  })()

  inFlight.set(key, ticket)
  try {
    return await ticket
  } finally {
    inFlight.delete(key)
  }
}

/** A signed URL that has lapsed answers 403/410; the caller should re-resolve. */
export class StreamExpiredError extends Error {
  constructor() {
    super('stream url expired')
  }
}

export type FetchOptions = {
  onProgress?: (downloaded: number, total: number) => void
  signal?: AbortSignal
  /** Parallel connections. 8 saturates this CDN without looking abusive. */
  connections?: number
}

/**
 * Fetch ranges with `curl`, not with Node's fetch.
 *
 * googlevideo answers curl with 206 and Node with 403 for the very same signed
 * URL: it fingerprints the client, and undici's TLS/HTTP profile is not one it
 * accepts. Header fiddling does not help (every combination still 403s), so the
 * request is made by the one client we know the CDN serves.
 */
function curlRange(url: string, range: string | undefined, outFile: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['-sS', '--fail', '--location', '--max-time', '120', '-o', outFile]
    if (range) args.push('--range', range)
    args.push(url)

    const child = spawn('curl', args, {signal})
    let err = ''
    child.stderr.on('data', (chunk: Buffer) => (err += chunk))
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) return resolve()
      // curl --fail reports the HTTP status in the message
      if (/\b(403|410)\b/.test(err)) return reject(new StreamExpiredError())
      reject(new Error(err.trim() || `curl exited with ${code}`))
    })
  })
}

/** Ask curl for the size, which is also a cheap liveness check. */
async function probeSize(url: string): Promise<number | undefined> {
  return new Promise(resolve => {
    const child = spawn('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code} %{size_download}', '--range', '0-0', '--max-time', '30', url])
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => (out += chunk))
    child.on('error', () => resolve(undefined))
    child.on('close', () => {
      const [code, size] = out.trim().split(' ')
      // A 206 for a 1-byte range doesn't reveal the total; a plain GET's
      // content-length does, so size is resolved separately below.
      resolve(code === '206' || code === '200' ? Number(size) : undefined)
    })
  })
}

/** Content-Type, read with curl so it is subject to the same client rules. */
function curlContentType(url: string): Promise<string | undefined> {
  return new Promise(resolve => {
    const child = spawn('curl', ['-sS', '-I', '--max-time', '20', url])
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => (out += chunk))
    child.on('error', () => resolve(undefined))
    child.on('close', () => {
      const match = /content-type:\s*([^\r\n]+)/i.exec(out)
      resolve(match?.[1]?.trim())
    })
  })
}

/** Total length via a HEAD, done by curl for the same fingerprinting reason. */
export async function contentLength(url: string): Promise<number | undefined> {
  return new Promise(resolve => {
    const child = spawn('curl', ['-sS', '-I', '--max-time', '20', url])
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => (out += chunk))
    child.on('error', () => resolve(undefined))
    child.on('close', () => {
      const match = /content-length:\s*(\d+)/i.exec(out)
      resolve(match ? Number(match[1]) : undefined)
    })
  })
}

/**
 * Pull the whole file with parallel range requests.
 *
 * A single sequential connection is throttled to ~100ms per 256KB chunk, which
 * is what made downloads feel slow; independent ranges run at full speed.
 */
export async function fetchParallel(streamUrl: string, outPath: string, opts: FetchOptions = {}): Promise<number> {
  const connections = Math.max(1, opts.connections ?? 8)
  const total = (await contentLength(streamUrl)) ?? (await probeSize(streamUrl))
  if (!total) return fetchWhole(streamUrl, outPath, opts)

  const chunk = Math.ceil(total / connections)
  const parts: string[] = []

  for (let index = 0; index < connections; index++) {
    const start = index * chunk
    if (start >= total) break
    const end = Math.min(start + chunk - 1, total - 1)
    const part = `${outPath}.part${index}`
    parts.push(part)
    await curlRange(streamUrl, `${start}-${end}`, part, opts.signal)
  }

  // Each range landed in its own file; joining them in order is the file.
  const handle = await fs.open(outPath, 'w')
  let written = 0
  try {
    for (const part of parts) {
      const buffer = await fs.readFile(part)
      await handle.write(buffer)
      written += buffer.length
      opts.onProgress?.(written, total)
      await fs.rm(part, {force: true})
    }
  } finally {
    await handle.close()
  }
  return written
}

/** One plain GET, for servers that don't support ranges. */
async function fetchWhole(streamUrl: string, outPath: string, opts: FetchOptions): Promise<number> {
  await curlRange(streamUrl, undefined, outPath, opts.signal)
  const {size} = await fs.stat(outPath)
  opts.onProgress?.(size, size)
  return size
}

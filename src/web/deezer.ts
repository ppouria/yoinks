/**
 * Deezer as the primary audio source.
 *
 * Why Deezer: it is the only source here that hands back a plain CDN file after
 * a single API call. No yt-dlp, no JS challenge, no manifest.
 *
 * The protocol work lives in deezer_bridge.py (deezer-py), which runs as a
 * long-lived worker. Spawning Python per request cost ~0.4s of start-up and a
 * re-login every time; the worker keeps the session warm and answers in ~0.3s.
 */
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** The script ships next to the bundle (see the tsup copy step). */
const BRIDGE = path.join(HERE, 'deezer_bridge.py')
const PYTHON = process.env.YOINKS_PYTHON || 'python3'

export type DeezerTrack = {
  id: string
  title: string
  artist: string
  album?: string
  duration?: number
}

export type DeezerResult = {track: DeezerTrack; url: string}

type BridgeReply = {
  id?: number
  ok: boolean
  error?: string
  track?: {id?: string; title?: string; artist?: string; album?: string; duration?: number}
  url?: string
}

type Pending = {resolve: (value: BridgeReply) => void; reject: (error: Error) => void; timer: NodeJS.Timeout}

/** One worker for the whole server; restarted if it dies. */
let worker: ChildProcessWithoutNullStreams | undefined
let buffer = ''
let nextId = 1
const pending = new Map<number, Pending>()

function startWorker(): ChildProcessWithoutNullStreams {
  const child = spawn(PYTHON, [BRIDGE], {stdio: ['pipe', 'pipe', 'pipe']})

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
      if (!line) continue
      try {
        const reply = JSON.parse(line) as BridgeReply
        const waiter = reply.id !== undefined ? pending.get(reply.id) : undefined
        if (waiter) {
          clearTimeout(waiter.timer)
          pending.delete(reply.id!)
          waiter.resolve(reply)
        }
      } catch {
        // a stray line from the worker; ignore rather than killing it
      }
    }
  })

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    const text = chunk.trim()
    if (text) console.log(`[deezer] ${text.slice(0, 200)}`)
  })

  const failAll = () => {
    for (const [, waiter] of pending) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('Deezer worker stopped'))
    }
    pending.clear()
    if (worker === child) worker = undefined
  }
  child.on('exit', failAll)
  child.on('error', failAll)

  return child
}

function callBridge(request: Record<string, unknown>, arl: string, timeoutMs = 25_000): Promise<BridgeReply> {
  if (!worker || worker.killed) worker = startWorker()
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('Deezer timed out'))
    }, timeoutMs)
    pending.set(id, {resolve, reject, timer})
    worker!.stdin.write(`${JSON.stringify({id, arl, ...request})}\n`)
  })
}

function normalise(reply: BridgeReply): DeezerResult {
  if (!reply.ok || !reply.url) throw new Error(reply.error || 'Deezer returned no track.')
  const track = reply.track ?? {}
  return {
    track: {
      id: String(track.id ?? ''),
      title: track.title ?? 'Unknown title',
      artist: track.artist ?? 'Unknown artist',
      album: track.album,
      // Deezer sends duration as a string; everything downstream does arithmetic.
      duration: Number(track.duration) || undefined,
    },
    url: reply.url,
  }
}

/** Should this URL be routed through Deezer at all? */
export function isDeezerUrl(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase()
    return host === 'deezer.com' || host.endsWith('.deezer.com') || host === 'deezer.page.link'
  } catch {
    return false
  }
}

/** deezer.com/[xx/]track/123456 */
export function deezerTrackId(rawUrl: string): string | undefined {
  try {
    const {pathname} = new URL(rawUrl)
    return /\/track\/(\d+)/.exec(pathname)?.[1]
  } catch {
    return undefined
  }
}

export async function searchDeezer(query: string, arl: string): Promise<DeezerResult> {
  if (!arl) throw new Error('No Deezer session configured.')
  return normalise(await callBridge({op: 'search', query}, arl))
}

/**
 * Download a track's audio, decrypted, straight to `outPath`.
 *
 * Deezer's CDN bytes are BF_CBC_STRIPE-encrypted, so the URL itself is useless
 * to a player: fetching it directly yields a file that looks like an mp3 and
 * decodes to nothing. The worker fetches and decrypts in one step.
 */
export async function downloadDeezerAudio(
  trackId: string,
  arl: string,
  outPath: string,
): Promise<{track: DeezerTrack; path: string; bytes: number}> {
  if (!arl) throw new Error('No Deezer session configured.')
  const reply = (await callBridge({op: 'download', trackId, outPath}, arl, 90_000)) as BridgeReply & {
    path?: string
    bytes?: number
  }
  if (!reply.ok || !reply.path) throw new Error(reply.error || 'Deezer download failed.')
  return {
    track: normalise({...reply, url: reply.path}).track,
    path: reply.path,
    bytes: reply.bytes ?? 0,
  }
}

export async function deezerTrackMedia(trackId: string, arl: string): Promise<DeezerResult> {
  if (!arl) throw new Error('No Deezer session configured.')
  return normalise(await callBridge({op: 'media', trackId}, arl))
}

/** Is the bridge runnable at all? Used by /healthz so the UI can hide the hint. */
export async function deezerAvailable(): Promise<boolean> {
  try {
    await fs.access(BRIDGE)
    return true
  } catch {
    return false
  }
}

/** Stop the worker on shutdown so no orphan Python is left behind. */
export function stopDeezer(): void {
  worker?.kill()
  worker = undefined
}

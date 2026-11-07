/**
 * Deezer as the primary audio source.
 *
 * Why Deezer: it is the only source here that hands back a plain CDN file after
 * a single API call. No yt-dlp, no JS challenge, no manifest — which is what
 * makes a download take ~1s instead of ~20s. The protocol work lives in
 * deezer_bridge.py (deezer-py); this file just runs it and normalises results.
 *
 * A free Deezer account is enough (128 kbps mp3). Without a session Deezer only
 * serves 30-second previews, which are never treated as a usable match — the
 * caller falls back to the YouTube path in that case.
 */
import {execFile} from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** The script ships next to the bundle (see the tsup copy step). */
const BRIDGE = path.join(HERE, 'deezer_bridge.py')
const PYTHON = process.env.YOINKS_PYTHON || 'python3'
/** Read from the cookie store, injected by the server per request. */
const ARL_ENV = 'DEEZER_ARL'

export type DeezerTrack = {
  id: string
  title: string
  artist: string
  album?: string
  duration?: number
}

export type DeezerResult = {track: DeezerTrack; url: string}

type BridgeReply = {
  ok: boolean
  error?: string
  track?: {id?: string; title?: string; artist?: string; album?: string; duration?: number}
  url?: string
}

function callBridge(request: unknown, arl: string, timeoutMs = 30_000): Promise<BridgeReply> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      PYTHON,
      [BRIDGE],
      {timeout: timeoutMs, env: {...process.env, [ARL_ENV]: arl}},
      (error, stdout, stderr) => {
        // The bridge always prints JSON, even on failure.
        try {
          resolve(JSON.parse(stdout) as BridgeReply)
        } catch {
          reject(new Error(stderr.trim() || error?.message || 'Deezer bridge failed'))
        }
      },
    )
    child.stdin?.end(JSON.stringify(request))
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
      duration: track.duration,
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

/** "Artist - Title" for a Spotify track, so Deezer can be tried first. */
export async function searchDeezer(query: string, arl: string): Promise<DeezerResult> {
  if (!arl) throw new Error('No Deezer session configured.')
  return normalise(await callBridge({op: 'search', query}, arl))
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

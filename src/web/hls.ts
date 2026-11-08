/**
 * Parallel HLS downloader.
 *
 * Sites whose extractor only offers HLS (Dailymotion, SoundCloud, Twitch, many
 * CDNs) hand yt-dlp a manifest and a list of segments, which native-HLS
 * downloads one at a time. On this hardware a segment round-trip is ~100ms and
 * there are dozens of them, so the transfer is dominated by latency rather than
 * bandwidth — fetching them concurrently is roughly 4x faster.
 *
 * This module only *fetches and concatenates* segments. Remuxing to mp4 is still
 * ffmpeg's job (called by the server), and encryption (AES-128 / SAMPLE-AES) is
 * deliberately not attempted: if a playlist uses it we bail out and let yt-dlp
 * do the whole download, which handles keys and byte ranges correctly.
 */
import {spawn} from 'node:child_process'
import fs from 'node:fs/promises'

export type HlsSegment = {
  /** Absolute URL of the segment. */
  uri: string
  /** Byte range within the resource, when the playlist declares one. */
  range?: {start: number; length: number}
  /** Optional per-segment key URI (encrypted playlists are rejected earlier). */
  key?: string
}

export type HlsPlaylist = {
  segments: HlsSegment[]
  /** Absolute URL of a fMP4 init segment, if any. */
  initSegment?: string
  encrypted: boolean
  /** True when the playlist is a master playlist pointing at variants. */
  isMaster: boolean
  variants?: string[]
}

/** Resolve a possibly relative URI against the playlist's own URL. */
function resolveUri(base: string, uri: string): string {
  try {
    return new URL(uri, base).toString()
  } catch {
    return uri
  }
}

/** Minimal but correct-enough m3u8 reader for VOD and live-style media lists. */
export function parsePlaylist(text: string, baseUrl: string): HlsPlaylist {
  const lines = text.split(/\r?\n/).map(line => line.trim())
  const segments: HlsSegment[] = []
  const variants: string[] = []
  let initSegment: string | undefined
  let encrypted = false
  let isMaster = false
  let rangeStarted = false
  let pendingRange: {start: number; length: number} | undefined

  for (const line of lines) {
    if (!line) continue

    if (line.startsWith('#EXT-X-STREAM-INF')) {
      // A master playlist: the next URI line is a variant, not a segment.
      isMaster = true
      rangeStarted = true
      continue
    }

    if (line.startsWith('#EXT-X-KEY')) {
      // METHOD=NONE is the only unencrypted form; anything else needs keys.
      if (!/METHOD=NONE/i.test(line)) encrypted = true
      continue
    }

    if (line.startsWith('#EXT-X-MAP')) {
      const uri = /URI="([^"]+)"/.exec(line)?.[1]
      if (uri) initSegment = resolveUri(baseUrl, uri)
      continue
    }

    if (line.startsWith('#EXT-X-BYTERANGE')) {
      const match = /(\d+)(?:@(\d+))?/.exec(line)
      if (match) {
        pendingRange = {length: Number(match[1]), start: Number(match[2] ?? 0)}
      }
      continue
    }

    if (line.startsWith('#')) continue

    const uri = resolveUri(baseUrl, line)
    if (rangeStarted && isMaster) {
      variants.push(uri)
      rangeStarted = false
      continue
    }
    segments.push({uri, range: pendingRange})
    pendingRange = undefined
  }

  return {segments, initSegment, encrypted, isMaster, variants}
}

/** Fetch a URL with curl; returns the bytes. */
function curlBytes(url: string, range?: {start: number; length: number}, signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = ['-sS', '--fail', '--location', '--max-time', '60']
    if (range) args.push('--range', `${range.start}-${range.start + range.length - 1}`)
    args.push(url)

    const child = spawn('curl', args, {signal})
    const chunks: Buffer[] = []
    let err = ''
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => (err += chunk))
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve(Buffer.concat(chunks))
      else reject(new Error(err.trim() || `curl exited with ${code}`))
    })
  })
}

export type HlsFetchOptions = {
  /** How many segments to fetch at once. */
  connections?: number
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
}

/**
 * Download every segment of a media playlist and concatenate them.
 * Returns the number of bytes written.
 */
export async function downloadHls(
  playlistUrl: string,
  outPath: string,
  opts: HlsFetchOptions = {},
): Promise<number> {
  const connections = Math.max(1, opts.connections ?? 6)
  const playlistText = (await curlBytes(playlistUrl, undefined, opts.signal)).toString('utf8')
  const playlist = parsePlaylist(playlistText, playlistUrl)

  if (playlist.isMaster && playlist.variants?.length) {
    // Pick the first variant; the caller has already chosen a quality, so the
    // master is only reached if that wasn't possible.
    return downloadHls(playlist.variants[0]!, outPath, opts)
  }
  if (playlist.encrypted) throw new Error('playlist is encrypted; yt-dlp must handle it')
  if (playlist.segments.length === 0) throw new Error('playlist has no segments')

  const total = playlist.segments.length
  const parts: Buffer[] = new Array(total)
  let done = 0
  let next = 0

  const worker = async () => {
    for (;;) {
      const index = next++
      if (index >= total) return
      const segment = playlist.segments[index]!
      parts[index] = await curlBytes(segment.uri, segment.range, opts.signal)
      done++
      opts.onProgress?.(done, total)
    }
  }

  await Promise.all(Array.from({length: Math.min(connections, total)}, worker))

  const handle = await fs.open(outPath, 'w')
  try {
    if (playlist.initSegment) {
      await handle.write(await curlBytes(playlist.initSegment, undefined, opts.signal))
    }
    for (const part of parts) await handle.write(part)
  } finally {
    await handle.close()
  }

  const stat = await fs.stat(outPath)
  return stat.size
}

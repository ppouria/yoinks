/**
 * Spotify support, via spotDL (https://github.com/spotDL/spotify-downloader).
 *
 * Spotify itself serves DRM-protected streams, so nothing can legally pull the
 * audio out of it. spotDL takes a different route: it reads the *metadata* from
 * Spotify (title, artist, cover, ISRC) and then sources the audio from an
 * ordinary public site — YouTube, SoundCloud or Bandcamp — through yt-dlp.
 *
 * That split is exactly what we want here: we ask spotDL only for metadata
 * (`spotdl save`, which never downloads), then feed the resulting query into
 * the same yt-dlp pipeline every other site already uses. Downloads therefore
 * inherit our cookie jars, progress reporting and retention rules for free.
 */
import {spawn} from 'node:child_process'

/** Only tracks are handled. Playlists/albums would turn one URL into N jobs. */
export type SpotifyTrack = {
  id: string
  name: string
  artist: string
  album?: string
  duration?: number
  cover?: string
  year?: number
  url: string
}

export function isSpotifyUrl(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase()
    return host === 'open.spotify.com' || host === 'play.spotify.com'
  } catch {
    return false
  }
}

/** open.spotify.com/track/<id> or a /intl-xx/ prefixed variant. */
export function spotifyTrackId(rawUrl: string): string | undefined {
  try {
    const {pathname} = new URL(rawUrl)
    const match = /\/track\/([A-Za-z0-9]{10,})/.exec(pathname)
    return match?.[1]
  } catch {
    return undefined
  }
}

const SPOTDL = process.env.YOINKS_SPOTDL_BIN || 'spotdl'

function run(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(SPOTDL, args, {stdio: ['ignore', 'pipe', 'pipe']})
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('Spotify lookup timed out.'))
    }, timeoutMs)

    child.stdout.on('data', chunk => (out += chunk))
    child.stderr.on('data', chunk => (err += chunk))
    child.on('error', error => {
      clearTimeout(timer)
      reject(new Error(`spotdl is not available (${error.message}).`))
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(err.trim().split('\n').at(-1) || `spotdl exited with ${code}.`))
    })
  })
}

/**
 * Metadata only — `spotdl save` writes a .spotdl JSON file and downloads no
 * audio, which keeps this fast and independent of the audio provider being up.
 */
export async function lookupSpotify(url: string, tmpDir: string): Promise<SpotifyTrack> {
  const id = spotifyTrackId(url)
  if (!id) throw new Error('That looks like a Spotify link, but not a single track. Track links only.')

  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  await fs.mkdir(tmpDir, {recursive: true})
  const outFile = path.join(tmpDir, `spotify-${Date.now()}.spotdl`)

  try {
    await run(['save', url, '--save-file', outFile], 60_000)
    const parsed = JSON.parse(await fs.readFile(outFile, 'utf8')) as unknown
    const songs = Array.isArray(parsed)
      ? parsed
      : ((parsed as {songs?: unknown[]}).songs ?? [])
    const song = songs[0] as Record<string, unknown> | undefined
    if (!song || typeof song.name !== 'string') throw new Error('Spotify returned no track for that link.')

    return {
      id,
      name: song.name,
      artist: typeof song.artist === 'string' ? song.artist : 'Unknown artist',
      album: typeof song.album_name === 'string' ? song.album_name : undefined,
      duration: typeof song.duration === 'number' ? song.duration : undefined,
      cover: typeof song.cover_url === 'string' ? song.cover_url : undefined,
      year: typeof song.year === 'number' ? song.year : undefined,
      url: typeof song.url === 'string' ? song.url : url,
    }
  } finally {
    await fs.rm(outFile, {force: true})
  }
}

/**
 * yt-dlp's pseudo-URL for "search and take the first hit". Using a real URL
 * scheme (rather than a bare query) means the normal probe/download path,
 * cookie jars and progress reporting all keep working unchanged.
 */
export function spotifySearchUrl(track: SpotifyTrack): string {
  const query = `${track.artist} - ${track.name}`.replace(/^(ytsearch\d*:)/i, '')
  return `ytsearch1:${query}`
}

/** Does spotDL exist on this machine? Reported on /healthz so the UI can hide the hint. */
export async function spotdlAvailable(): Promise<boolean> {
  try {
    await run(['--version'], 10_000)
    return true
  } catch {
    return false
  }
}

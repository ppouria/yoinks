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
  artists?: string[]
  album?: string
  albumArtist?: string
  duration?: number
  cover?: string
  year?: number
  trackNumber?: number
  url: string
}

/**
 * `spotdl save` spawns Python and takes ~24s. Cached so a probe followed by a
 * download does not pay for it twice, and a retry of the same link is instant.
 */
const CACHE_TTL_MS = 6 * 3600_000
const cache = new Map<string, {at: number; track: SpotifyTrack}>()

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

  const hit = cache.get(id)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.track

  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  await fs.mkdir(tmpDir, {recursive: true})
  const outFile = path.join(tmpDir, `spotify-${Date.now()}.spotdl`)

  try {
    // Fast path first: Spotify's embed page carries the track's public JSON and
    // answers in ~200ms, where `spotdl save` spends ~24s starting Python.
    // spotDL stays as the fallback for whatever the embed page cannot describe.
    const fast = await lookupViaEmbed(id).catch(() => undefined)
    if (fast) {
      cache.set(id, {at: Date.now(), track: fast})
      return fast
    }

    await run(['save', url, '--save-file', outFile], 60_000)
    const parsed = JSON.parse(await fs.readFile(outFile, 'utf8')) as unknown
    const songs = Array.isArray(parsed)
      ? parsed
      : ((parsed as {songs?: unknown[]}).songs ?? [])
    const song = songs[0] as Record<string, unknown> | undefined
    if (!song || typeof song.name !== 'string') throw new Error('Spotify returned no track for that link.')

    const artists = Array.isArray(song.artists)
      ? (song.artists as unknown[]).filter((a): a is string => typeof a === 'string')
      : []
    const track: SpotifyTrack = {
      id,
      name: song.name,
      artist: typeof song.artist === 'string' ? song.artist : 'Unknown artist',
      artists: artists.length ? artists : undefined,
      album: typeof song.album_name === 'string' ? song.album_name : undefined,
      albumArtist: typeof song.album_artist === 'string' ? song.album_artist : undefined,
      duration: typeof song.duration === 'number' ? song.duration : undefined,
      cover: typeof song.cover_url === 'string' ? song.cover_url : undefined,
      year: typeof song.year === 'number' ? song.year : undefined,
      trackNumber: typeof song.track_number === 'number' ? song.track_number : undefined,
      url: typeof song.url === 'string' ? song.url : url,
    }
    cache.set(id, {at: Date.now(), track})
    return track
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

type EmbedEntity = {
  name?: string
  title?: string
  artists?: Array<{name?: string}>
  duration?: number
  releaseDate?: {isoString?: string}
  visualIdentity?: {image?: Array<{url?: string; maxWidth?: number; maxHeight?: number}>}
  isPlayable?: boolean
}

/** Reads the same public JSON that the Spotify embed player uses. */
async function lookupViaEmbed(id: string): Promise<SpotifyTrack | undefined> {
  const response = await fetch(`https://open.spotify.com/embed/track/${id}`, {
    headers: {'user-agent': 'Mozilla/5.0'},
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) return undefined
  const html = await response.text()
  const match = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html)
  if (!match) return undefined

  const data = JSON.parse(match[1]!) as {
    props?: {pageProps?: {state?: {data?: {entity?: EmbedEntity}}}}
  }
  const entity = data.props?.pageProps?.state?.data?.entity
  if (!entity) return undefined

  const name = entity.name ?? entity.title
  if (!name) return undefined

  const artists = (entity.artists ?? [])
    .map(artist => artist?.name)
    .filter((artistName): artistName is string => Boolean(artistName))
  if (artists.length === 0) return undefined

  // Covers are listed largest-last; take the biggest one available.
  const images = entity.visualIdentity?.image ?? []
  const cover = [...images]
    .sort((a, b) => (b.maxWidth ?? 0) - (a.maxWidth ?? 0))
    .find(image => image.url)?.url

  const year = entity.releaseDate?.isoString ? Number(entity.releaseDate.isoString.slice(0, 4)) : undefined

  return {
    id,
    name,
    artist: artists[0]!,
    artists,
    duration: entity.duration ? Math.round(entity.duration / 1000) : undefined,
    cover,
    year: Number.isFinite(year) ? year : undefined,
    url: `https://open.spotify.com/track/${id}`,
  }
}

/**
 * Album name / track number are not in the embed payload. They come from
 * `spotdl save`, which costs ~24s — far too slow to block a probe on, so this
 * runs at download time where the wait overlaps with the actual download.
 */
export async function enrichAlbumFields(track: SpotifyTrack, tmpDir: string): Promise<SpotifyTrack> {
  if (track.album) return track
  const id = track.id || spotifyTrackId(track.url) || ''
  if (!id) return track

  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  await fs.mkdir(tmpDir, {recursive: true})
  const outFile = path.join(tmpDir, `spotify-album-${Date.now()}.spotdl`)
  try {
    await run(['save', `https://open.spotify.com/track/${id}`, '--save-file', outFile], 60_000)
    const parsed = JSON.parse(await fs.readFile(outFile, 'utf8')) as unknown
    const songs = Array.isArray(parsed) ? parsed : ((parsed as {songs?: unknown[]}).songs ?? [])
    const song = songs[0] as Record<string, unknown> | undefined
    if (!song) return track
    const enriched: SpotifyTrack = {
      ...track,
      album: typeof song.album_name === 'string' ? song.album_name : track.album,
      albumArtist: typeof song.album_artist === 'string' ? song.album_artist : track.albumArtist,
      trackNumber: typeof song.track_number === 'number' ? song.track_number : track.trackNumber,
    }
    cache.set(id, {at: Date.now(), track: enriched})
    return enriched
  } catch {
    return track
  } finally {
    await fs.rm(outFile, {force: true})
  }
}

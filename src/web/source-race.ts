/**
 * Audio source racing.
 *
 * Several providers can hold the same track, and which one is fastest depends
 * on the track, the CDN and how busy YouTube feels at that moment. Instead of
 * trying them in a fixed order and living with the slow one, every provider is
 * asked *in parallel* and the first one that returns a usable, full-length
 * audio URL wins. Deezer is started first because it is by far the fastest when
 * it has the track, but it no longer holds up the others.
 *
 * A provider must satisfy two rules to win:
 *   1. it returns a direct, fetchable media URL (not a page, not a manifest)
 *   2. its duration matches the requested track to within 10% (no previews)
 */
import {searchDeezer} from './deezer.js'
import {resolveAudioSource} from './audio-sources.js'

export type SourceHit = {
  /** Which provider won. */
  provider: string
  /** Playable media URL (for Deezer this is encrypted; use deezerTrackId). */
  url: string
  duration?: number
  /** Set when Deezer won, so the download can fetch and decrypt by id. */
  deezerTrackId?: string
}

export type SourceContext = {
  /** "Artist - Title", when known. */
  query: string
  /** Expected track length in seconds, when known. */
  duration?: number
  ytdlp: string
  deezerArl?: string
  youtubeCookies?: string
  signal?: AbortSignal
}

/** A candidate whose duration is clearly not the requested track. */
function wrongLength(actual: number | undefined, expected: number | undefined): boolean {
  if (!expected || expected <= 0 || !actual) return false
  const ratio = actual / expected
  return ratio < 0.9 || ratio > 1.1
}

/**
 * Ask every provider concurrently and take the first good answer.
 * Rejects only when every provider has failed.
 */
export async function raceAudioSources(ctx: SourceContext): Promise<SourceHit> {
  const attempts: Array<{name: string; run: () => Promise<SourceHit>}> = []

  // Deezer: one API call, a plain CDN file. Fastest when the track is there.
  if (ctx.deezerArl && ctx.query) {
    attempts.push({
      name: 'Deezer',
      run: async () => {
        const hit = await searchDeezer(ctx.query, ctx.deezerArl!)
        if (wrongLength(hit.track.duration, ctx.duration)) {
          throw new Error(`Deezer matched a ${hit.track.duration}s version`)
        }
        return {provider: 'Deezer', url: hit.url, duration: hit.track.duration, deezerTrackId: hit.track.id}
      },
    })
  }

  // YouTube / SoundCloud via yt-dlp, which already validates duration itself.
  if (ctx.query) {
    attempts.push({
      name: 'yt-dlp',
      run: async () => {
        const source = await resolveAudioSource(ctx.query, {
          ytdlp: ctx.ytdlp,
          cookiesFile: ctx.youtubeCookies,
          signal: ctx.signal,
          expectedSeconds: ctx.duration,
        })
        return {
          provider: source.label,
          url: source.url,
          duration: typeof source.info.duration === 'number' ? source.info.duration : undefined,
        }
      },
    })
  }

  if (attempts.length === 0) throw new Error('Nothing to search for.')

  return Promise.any(attempts.map(attempt => attempt.run()))
}

/**
 * Where the audio for a Spotify track actually comes from.
 *
 * Spotify is never the source: it serves DRM. Spotify gives us metadata only,
 * and the audio is fetched from an ordinary public site. YouTube is the usual
 * answer, but its bot check blocks individual videos from datacenter IPs, so a
 * single search result is not reliable enough to hand a user.
 *
 * This module tries several candidates in order and returns the first one that
 * really yields an audio stream. Each candidate is validated by probing it, so
 * "found a search result" never means "download will work".
 */
import {probe} from '../lib/ytdlp.js'
import type {VideoInfo} from '../lib/ytdlp.js'

export type AudioSource = {
  /** The URL (or yt-dlp pseudo-URL) that actually resolved. */
  url: string
  /** Human label for the UI / logs. */
  label: string
  /** Extractor report from yt-dlp. */
  extractor: string
  info: VideoInfo
}

/** YouTube always leads, since its catalogue matches Spotify's the closest. */
const PROVIDERS = [
  {id: 'youtube', label: 'YouTube', build: (q: string) => `ytsearch1:${q}`},
  // "topic" / full-album uploads are separate videos; asking again with the
  // word "audio" frequently lands on one that is not on the block list.
  {id: 'youtube', label: 'YouTube (audio)', build: (q: string) => `ytsearch1:${q} audio`},
  {id: 'soundcloud', label: 'SoundCloud', build: (q: string) => `scsearch1:${q}`},
] as const

/** yt-dlp returns a search as a playlist; unwrap the first entry. */
function firstEntry(info: VideoInfo): VideoInfo {
  const entries = (info as {entries?: VideoInfo[]}).entries
  if (Array.isArray(entries) && entries.length > 0) return entries[0]!
  return info
}

/** SoundCloud search happily returns 30-second teasers; those are not the song. */
const MIN_TRACK_SECONDS = 60

function hasAudio(info: VideoInfo): boolean {
  if ((info as {entries?: unknown}).entries) return false
  const formats = info.formats ?? []
  return formats.some(f => f.acodec && f.acodec !== 'none')
}

/**
 * A candidate is only usable if it is the actual track, not a clip. Spotify's
 * own duration is the reference: allow 20% plus a few seconds of slack.
 */
function matchesDuration(info: VideoInfo, expectedSeconds?: number): {ok: boolean; reason?: string} {
  const actual = typeof info.duration === 'number' ? info.duration : undefined
  if (actual === undefined) return {ok: true}
  if (actual < MIN_TRACK_SECONDS) return {ok: false, reason: `only ${Math.round(actual)}s (clip)`}
  if (expectedSeconds && expectedSeconds > 0) {
    const ratio = actual / expectedSeconds
    if (ratio < 0.8 || ratio > 1.2) {
      return {ok: false, reason: `${Math.round(actual)}s vs ${Math.round(expectedSeconds)}s expected`}
    }
  }
  return {ok: true}
}

/**
 * Resolve an audio source for a search query.
 * Tries each provider until one produces a genuinely playable result.
 */
export async function resolveAudioSource(
  query: string,
  opts: {ytdlp: string; cookiesFile?: string; signal?: AbortSignal; expectedSeconds?: number},
): Promise<AudioSource> {
  const failures: string[] = []

  for (const provider of PROVIDERS) {
    const url = provider.build(query)
    try {
      const {info} = await probe(opts.ytdlp, url, {
        cookiesFile: opts.cookiesFile,
        saveInfo: false,
        signal: opts.signal,
      })
      const entry = firstEntry(info)
      if (!hasAudio(entry)) {
        failures.push(`${provider.label}: no audio stream`)
        continue
      }
      const durationCheck = matchesDuration(entry, opts.expectedSeconds)
      if (!durationCheck.ok) {
        failures.push(`${provider.label}: ${durationCheck.reason}`)
        continue
      }
      // A search pseudo-URL needs to resolve to the concrete page, otherwise the
      // download re-runs the search and can match a different (blocked) video.
      const resolved = (entry as {webpage_url?: string}).webpage_url || (entry as {id?: string}).id || url
      return {
        url: resolved.startsWith('http') ? resolved : url,
        label: provider.label,
        extractor: entry.extractor_key ?? provider.label,
        info: entry,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push(`${provider.label}: ${message.split('\n')[0]?.slice(0, 120)}`)
    }
  }

  throw new Error(
    `Could not find the real track “${query}” on an audio source — no full-length match. ` +
      `Add a YouTube session under “signed-in sites” to widen the search. (${failures.join('; ')})`,
  )
}

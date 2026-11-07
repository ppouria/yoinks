/**
 * Write real ID3 tags (and cover art) onto a downloaded Spotify track.
 *
 * The audio comes from a public source, whose own metadata describes *that*
 * upload — "Artist - Title (Official Video) (4K Remaster)" with no album and
 * no artwork. What the user asked for was the Spotify track, so the tags are
 * rewritten from Spotify's metadata after the download finishes.
 *
 * This uses mutagen via a small python helper because Node has no dependable
 * in-process tag writer for mp3 at this size. If mutagen is missing we log and
 * keep the file: bad tags are not a reason to fail a finished download.
 */
import {execFile} from 'node:child_process'
import fs from 'node:fs/promises'

export type TrackTags = {
  title: string
  artists: string[]
  album?: string
  albumArtist?: string
  year?: number
  trackNumber?: number
  coverUrl?: string
  isrc?: string
  /** Service the track came from, written to the comment frame. */
  source?: string
}

const PYTHON = process.env.YOINKS_PYTHON || 'python3'

/** Written to a temp file and run once, so the tags never pass through a shell. */
const SCRIPT = String.raw`
import json, sys, urllib.request
from mutagen.id3 import ID3, TIT2, TPE1, TALB, TPE2, TDRC, TRCK, APIC, TSRC, COMM, ID3NoHeaderError
from mutagen.mp3 import MP3

spec = json.load(open(sys.argv[1], encoding='utf-8'))
path = spec['path']

try:
    tags = ID3(path)
except ID3NoHeaderError:
    tags = ID3()

def set_frame(frame):
    tags.delall(frame.FrameID)
    tags.add(frame)

set_frame(TIT2(encoding=3, text=spec.get('title') or ''))
artists = spec.get('artists') or []
if artists:
    set_frame(TPE1(encoding=3, text=artists))
if spec.get('album'):
    set_frame(TALB(encoding=3, text=spec['album']))
if spec.get('albumArtist'):
    set_frame(TPE2(encoding=3, text=spec['albumArtist']))
if spec.get('year'):
    set_frame(TDRC(encoding=3, text=str(spec['year'])))
if spec.get('trackNumber'):
    set_frame(TRCK(encoding=3, text=str(spec['trackNumber'])))
if spec.get('isrc'):
    set_frame(TSRC(encoding=3, text=spec['isrc']))
if spec.get('source'):
    set_frame(COMM(encoding=3, lang='eng', desc='', text='via yoinks-web, source: ' + spec['source']))

cover_url = spec.get('coverUrl')
if cover_url:
    try:
        req = urllib.request.Request(cover_url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=20) as res:
            image = res.read()
            mime = res.headers.get('Content-Type', 'image/jpeg').split(';')[0]
        if image:
            tags.delall('APIC')
            tags.add(APIC(encoding=3, mime=mime, type=3, desc='Cover', data=image))
    except Exception as exc:
        print('cover download failed:', exc, file=sys.stderr)

tags.save(path)
audio = MP3(path)
print(json.dumps({'duration': audio.info.length, 'tags': len(tags)}))
`

export type TagResult = {ok: boolean; reason?: string}

export async function applyTags(filePath: string, tags: TrackTags, tmpDir: string): Promise<TagResult> {
  await fs.mkdir(tmpDir, {recursive: true})
  const specPath = `${tmpDir}/tags-${process.pid}-${Date.now()}.json`
  const scriptPath = `${tmpDir}/tagger-${process.pid}.py`

  await fs.writeFile(
    specPath,
    JSON.stringify({
      path: filePath,
      title: tags.title,
      artists: tags.artists,
      album: tags.album,
      albumArtist: tags.albumArtist,
      year: tags.year,
      trackNumber: tags.trackNumber,
      coverUrl: tags.coverUrl,
      isrc: tags.isrc,
      source: tags.source,
    }),
  )
  await fs.writeFile(scriptPath, SCRIPT)

  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(PYTHON, [scriptPath, specPath], {timeout: 45_000}, (error, out, stderr) => {
        if (error) reject(new Error(`${error.message}${stderr ? ` | ${stderr.trim()}` : ''}`))
        else resolve(out)
      })
    })
    console.log(`tagging: ok ${filePath.split('/').pop()} ${stdout.trim()}`)
    return {ok: true}
  } catch (error) {
    return {ok: false, reason: error instanceof Error ? error.message : String(error)}
  } finally {
    await fs.rm(specPath, {force: true})
    await fs.rm(scriptPath, {force: true})
  }
}

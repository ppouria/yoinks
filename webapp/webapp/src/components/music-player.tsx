/**
 * The player card.
 *
 * It plays from the same URL the download button saves, so what you hear is
 * exactly the file you get. Two sources are possible:
 *   - a finished server download  (/api/jobs/:id/file) — always available for
 *     audio, and the reason the player can exist at all
 *   - the source site's own stream, used while the server copy is still
 *     downloading so there is something to listen to immediately
 */
import { useEffect, useRef, useState } from "react"
import {
  ArrowDownToLine,
  Copy,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { formatDuration } from "@/lib/api"

export type PlayerTrack = {
  title: string
  artist?: string
  album?: string
  cover?: string
  /** Ready-to-play source URL, once we have one. */
  src?: string
  /** True when src is the finished server file (as opposed to a preview). */
  isFinal?: boolean
  /** Show the download action only when a saved file exists. */
  downloadHref?: string
  downloadName?: string
  sizeLabel?: string
  /** e.g. "link works for 4 hours". */
  retentionLabel?: string
  badge?: string
}

export function MusicPlayer({
  track,
  loadingLabel,
  onCopyLink,
}: {
  track: PlayerTrack
  loadingLabel?: string
  onCopyLink?: () => void
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)
  const [muted, setMuted] = useState(false)
  const [failed, setFailed] = useState(false)

  // A new source means a new song: reset rather than keep stale position.
  useEffect(() => {
    setPlaying(false)
    setCurrent(0)
    setDuration(0)
    setFailed(false)
  }, [track.src])

  const toggle = async () => {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) {
      try {
        await audio.play()
        setPlaying(true)
      } catch {
        setFailed(true)
        setPlaying(false)
      }
    } else {
      audio.pause()
      setPlaying(false)
    }
  }

  const seekBy = (seconds: number) => {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = Math.max(0, Math.min(audio.duration || 0, audio.currentTime + seconds))
  }

  const scrubbable = Number.isFinite(duration) && duration > 0
  const progress = scrubbable ? (current / duration) * 100 : 0

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <div className="flex items-start gap-4">
          <Cover cover={track.cover} title={track.title} playing={playing} />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <CardTitle className="truncate text-base">{track.title}</CardTitle>
            <p className="truncate text-sm text-muted-foreground">
              {[track.artist, track.album].filter(Boolean).join(" · ") || "Unknown artist"}
            </p>
            {track.badge ? (
              <Badge variant="secondary" className="mt-1 w-fit">
                {track.badge}
              </Badge>
            ) : null}
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        {loadingLabel ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> {loadingLabel}
          </div>
        ) : null}

        {failed ? (
          <p className="text-sm text-destructive">
            This browser could not play the file directly. Use download instead.
          </p>
        ) : null}

        <audio
          ref={audioRef}
          src={track.src}
          preload="metadata"
          onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)}
          onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
          onEnded={() => setPlaying(false)}
          onPause={() => setPlaying(false)}
          onPlay={() => setPlaying(true)}
          onError={() => setFailed(true)}
        />

        {/* Seek bar: a native range input keeps keyboard and touch behaviour
            correct without re-implementing a slider's accessibility. */}
        <input
          type="range"
          min={0}
          max={scrubbable ? duration : 0}
          step={0.1}
          value={current}
          disabled={!scrubbable}
          aria-label="Seek"
          onChange={(event) => {
            const audio = audioRef.current
            if (!audio) return
            audio.currentTime = Number(event.target.value)
            setCurrent(Number(event.target.value))
          }}
          className={cn(
            "h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
          style={{
            background: `linear-gradient(to right, var(--primary) ${progress}%, var(--muted) ${progress}%)`,
          }}
        />

        <div className="flex items-center justify-between text-xs tabular-nums text-muted-foreground">
          <span>{formatDuration(current) || "0:00"}</span>
          <span>{scrubbable ? formatDuration(duration) : "--:--"}</span>
        </div>

        <div className="flex items-center justify-center gap-2">
          <Button size="icon" variant="ghost" onClick={() => seekBy(-10)} aria-label="Back 10 seconds">
            <RotateCcw />
          </Button>
          <Button size="icon" onClick={toggle} aria-label={playing ? "Pause" : "Play"}>
            {playing ? <Pause /> : <Play />}
          </Button>
          <Button size="icon" variant="ghost" onClick={() => seekBy(10)} aria-label="Forward 10 seconds">
            <RotateCw />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label={muted ? "Unmute" : "Mute"}
            onClick={() => {
              const audio = audioRef.current
              if (!audio) return
              audio.muted = !audio.muted
              setMuted(audio.muted)
            }}
          >
            {muted ? <VolumeX /> : <Volume2 />}
          </Button>
        </div>
      </CardContent>

      {track.downloadHref ? (
        <>
          <Separator />
          <CardFooter className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-sm font-medium">{track.downloadName ?? track.title}</span>
              <span className="text-xs text-muted-foreground">
                {[track.sizeLabel, track.retentionLabel].filter(Boolean).join(" · ")}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {onCopyLink ? (
                <Button variant="outline" size="sm" onClick={onCopyLink}>
                  <Copy data-icon="inline-start" />
                  Copy link
                </Button>
              ) : null}
              <Button size="sm" render={<a href={track.downloadHref} download />}>
                <ArrowDownToLine data-icon="inline-start" />
                Download
              </Button>
            </div>
          </CardFooter>
        </>
      ) : null}
    </Card>
  )
}

function Cover({ cover, title, playing }: { cover?: string; title: string; playing: boolean }) {
  const [broken, setBroken] = useState(false)
  const showImage = cover && !broken

  return (
    <div className="relative size-20 shrink-0 overflow-hidden rounded-lg bg-muted">
      {showImage ? (
        <img
          src={cover}
          alt=""
          className="size-full object-cover"
          loading="lazy"
          onError={() => setBroken(true)}
        />
      ) : (
        <div className="flex size-full items-center justify-center text-lg font-semibold text-muted-foreground">
          {title.slice(0, 2).toUpperCase()}
        </div>
      )}
      {playing ? (
        <span className="absolute inset-x-0 bottom-0 flex h-5 items-end justify-center gap-0.5 bg-background/70 pb-1">
          <Bar delay="0ms" />
          <Bar delay="120ms" />
          <Bar delay="240ms" />
          <Bar delay="80ms" />
        </span>
      ) : null}
    </div>
  )
}

function Bar({ delay }: { delay: string }) {
  return (
    <span
      className="w-0.5 animate-[eq_900ms_ease-in-out_infinite] bg-primary"
      style={{ height: "40%", animationDelay: delay }}
    />
  )
}

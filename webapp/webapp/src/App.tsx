/**
 * yoinks — paste a link, listen to it, keep it.
 *
 * Three states, with the player as the centre of all of them:
 *   idle   → a single paste field
 *   ready  → player + quality / retention controls
 *   saving → the same player, with live progress; the download button appears
 *            the moment the server file is ready
 */
import { useCallback, useEffect, useState } from "react"
import { Link2, Lock, Search, X } from "lucide-react"
import { toast } from "sonner"

import { MusicPlayer, type PlayerTrack } from "@/components/music-player"
import { SessionsDialog } from "@/components/sessions-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import {
  api,
  formatBytes,
  formatDuration,
  type AppConfig,
  type Job,
  type ProbeResult,
  type RetentionOption,
} from "@/lib/api"

const FALLBACK_RETENTION: RetentionOption[] = [
  { hours: 4, label: "4 hours" },
  { hours: 12, label: "12 hours" },
  { hours: 24, label: "1 day" },
  { hours: 72, label: "3 days" },
  { hours: 168, label: "1 week" },
]

export function App() {
  const [url, setUrl] = useState("")
  const [probing, setProbing] = useState(false)
  const [probeError, setProbeError] = useState<string | null>(null)
  const [info, setInfo] = useState<ProbeResult | null>(null)
  const [choice, setChoice] = useState(0)
  const [retention, setRetention] = useState(4)
  const [options, setOptions] = useState<RetentionOption[]>(FALLBACK_RETENTION)
  const [job, setJob] = useState<Job | null>(null)
  const [sessionsOpen, setSessionsOpen] = useState(false)

  useEffect(() => {
    api
      .config()
      .then((config: AppConfig) => {
        setOptions(config.retention.options)
        setRetention(config.retention.defaultHours)
      })
      .catch(() => {
        // keep the built-in options; the server may still be starting up
      })
  }, [])

  // Poll only while a job is in flight.
  useEffect(() => {
    if (!job) return
    const finished = job.status === "done" || job.status === "error" || job.status === "cancelled"
    if (finished) return

    const timer = window.setTimeout(async () => {
      try {
        setJob(await api.job(job.id))
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Lost track of that download.")
      }
    }, 800)
    return () => window.clearTimeout(timer)
  }, [job])

  const reset = useCallback(() => {
    setInfo(null)
    setJob(null)
    setProbeError(null)
    setChoice(0)
    setUrl("")
  }, [])

  /**
   * Paste and go: one request resolves the link *and* starts the download, so
   * the transfer begins immediately instead of waiting for a second click.
   * The format picker stays available afterwards for re-downloads.
   */
  const probe = async (event?: React.FormEvent) => {
    event?.preventDefault()
    const trimmed = url.trim()
    if (!trimmed) return
    setProbing(true)
    setProbeError(null)
    setJob(null)
    try {
      const { job: started, info: result } = await api.grab({ url: trimmed, retentionHours: retention })
      const audioIndex = result.choices.findIndex((c) => c.kind === "audio")
      setInfo(result)
      setChoice(audioIndex >= 0 ? audioIndex : 0)
      setJob(started)
    } catch (error) {
      setInfo(null)
      setProbeError(error instanceof Error ? error.message : "That link could not be read.")
    } finally {
      setProbing(false)
    }
  }

  const startDownload = async () => {
    if (!info) return
    try {
      const { job: created } = await api.download({
        url: url.trim(),
        choice,
        retentionHours: retention,
        title: info.spotify?.name,
        artist: info.spotify?.artist,
        audioUrl: info.audioUrl,
        previewUrl: info.previewUrl,
        deezerTrackId: info.deezerTrackId,
      })
      setJob(created)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not start the download.")
    }
  }

  const cancel = async () => {
    if (job) {
      try {
        await api.cancel(job.id)
      } catch {
        // the file may already be gone; the UI moves on regardless
      }
    }
    reset()
  }

  const copyLink = async () => {
    if (!job) return
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${api.fileUrl(job.id)}`)
      toast.success("Link copied")
    } catch {
      toast.error("Could not copy the link.")
    }
  }

  const isAudio = info?.source === "spotify" || info?.choices[choice]?.kind === "audio"
  const track = buildTrack({ info, job, isAudio, retentionHours: retention })
  const saving = job && (job.status === "downloading" || job.status === "queued" || job.status === "processing")

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-6 px-4 py-10">
      <header className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">yoinks</h1>
          <p className="text-sm text-muted-foreground">paste. listen. keep.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setSessionsOpen(true)}>
          <Lock data-icon="inline-start" />
          Sessions
        </Button>
      </header>

      <form onSubmit={probe}>
        <FieldGroup>
          <Field data-invalid={Boolean(probeError)}>
            <FieldLabel htmlFor="url" className="sr-only">
              Video or track link
            </FieldLabel>
            <div className="flex gap-2">
              <Input
                id="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="Paste a Spotify, YouTube, X or SoundCloud link"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={Boolean(probeError)}
                className="h-10"
              />
              <Button type="submit" className="h-10 shrink-0" disabled={probing || !url.trim()}>
                <Search data-icon="inline-start" />
                {probing ? "Reading…" : "Load"}
              </Button>
            </div>
            <FieldErrorWithAction error={probeError} onSignIn={() => setSessionsOpen(true)} />
          </Field>
        </FieldGroup>
      </form>

      {!info && !probing ? (
        <Empty className="flex-none border border-dashed py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Link2 />
            </EmptyMedia>
            <EmptyTitle>Nothing loaded yet</EmptyTitle>
            <EmptyDescription>
              Paste a link above. Spotify tracks open straight in the player; anything else lets you
              choose a quality first.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}

      {probing ? <ProbeSkeleton /> : null}

      {info && !probing ? (
        <>
          <MusicPlayer
            track={track}
            loadingLabel={
              saving
                ? job.status === "processing"
                  ? "tagging cover and metadata…"
                  : `saving a copy · ${formatBytes(job.bytesOnDisk || job.downloadedBytes) || "starting"}`
                : undefined
            }
            onCopyLink={job?.status === "done" ? copyLink : undefined}
          />

          {saving ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Saving to the server</CardTitle>
                <CardDescription className="line-clamp-1">{job.label}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <Progress value={progressPercent(job)} />
                <div className="flex justify-between text-xs tabular-nums text-muted-foreground">
                  <span>{progressPercent(job)}%</span>
                  <span>
                    {[
                      formatBytes(job.speed) ? `${formatBytes(job.speed)}/s` : "",
                      formatDuration(job.eta) ? `${formatDuration(job.eta)} left` : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
                <Button variant="outline" size="sm" className="w-fit" onClick={cancel}>
                  Cancel
                </Button>
              </CardContent>
            </Card>
          ) : null}

          {!saving && (!job || job.status === "error") ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Download</CardTitle>
                <CardDescription>
                  {info.source === "spotify"
                    ? "Spotify metadata, audio from a public source, tagged as mp3."
                    : "Pick a quality, then choose how long the link should keep working."}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="quality">Quality</FieldLabel>
                    <Select
                      value={String(choice)}
                      onValueChange={(value) => setChoice(Number(value))}
                      items={info.choices.map((c) => ({ value: String(c.index), label: c.label }))}
                    >
                      <SelectTrigger id="quality" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {info.choices.map((c) => (
                            <SelectItem key={c.index} value={String(c.index)}>
                              {c.kind === "audio" ? "♪ " : "▶ "}
                              {c.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="retention">Keep file for</FieldLabel>
                    <Select
                      value={String(retention)}
                      onValueChange={(value) => setRetention(Number(value))}
                      items={options.map((o) => ({ value: String(o.hours), label: o.label }))}
                    >
                      <SelectTrigger id="retention" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {options.map((option) => (
                            <SelectItem key={option.hours} value={String(option.hours)}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                </FieldGroup>
                <Button className="w-full" onClick={startDownload}>
                  Save {isAudio ? "track" : "video"} to server
                </Button>
              </CardContent>
            </Card>
          ) : null}
        </>
      ) : null}

      <Separator />
      <footer className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>downloads run on the server · links expire automatically</span>
        <div className="flex items-center gap-2">
          {isAudio ? <Badge variant="secondary">audio</Badge> : null}
          <Badge variant="outline">yt-dlp</Badge>
        </div>
      </footer>

      <SessionsDialog open={sessionsOpen} onOpenChange={setSessionsOpen} />
    </div>
  )
}

function FieldErrorWithAction({ error, onSignIn }: { error: string | null; onSignIn: () => void }) {
  if (!error) return null
  return (
    <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
      <X className="mt-0.5 size-4 shrink-0" />
      <span className="flex-1">{error}</span>
      <Button type="button" variant="ghost" size="xs" onClick={onSignIn}>
        Sign in
      </Button>
    </div>
  )
}

function ProbeSkeleton() {
  return (
    <Card>
      <CardContent className="flex items-center gap-4">
        <div className="size-20 animate-pulse rounded-lg bg-muted" />
        <div className="flex flex-1 flex-col gap-2">
          <div className="h-4 w-40 animate-pulse rounded bg-muted" />
          <div className="h-3 w-24 animate-pulse rounded bg-muted" />
        </div>
      </CardContent>
    </Card>
  )
}

function progressPercent(job: Job): number {
  const total = job.totalBytes ?? 0
  const done = job.bytesOnDisk || job.downloadedBytes || 0
  if (!total || !done) return 0
  return Math.min(99, Math.round((done / total) * 100))
}

function buildTrack({
  info,
  job,
  isAudio,
  retentionHours,
}: {
  info: ProbeResult | null
  job: Job | null
  isAudio: boolean
  retentionHours: number
}): PlayerTrack {
  const done = job?.status === "done"
  const fileUrl = done && job ? `${window.location.origin}${api.fileUrl(job.id)}` : undefined
  const retentionLabel =
    done && job?.expiresAt
      ? `link works until ${new Date(job.expiresAt).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })}`
      : `link works for ${job?.retentionHours ?? retentionHours} hours`

  return {
    title: info?.title ?? job?.title ?? "",
    artist: info?.spotify?.artist ?? info?.uploader,
    album: info?.spotify?.album,
    cover: info?.thumbnail,
    // Prefer the finished server file; fall back to a direct preview so the
    // player is usable as soon as a link is loaded.
    // The finished server file plays directly; before that, use the proxied
    // stream (a raw YouTube URL is a web page, not playable media).
    src: fileUrl ?? info?.previewUrl,
    downloadHref: fileUrl,
    downloadName: job?.filename,
    sizeLabel: formatBytes(job?.size),
    retentionLabel,
    badge: isAudio ? "audio" : undefined,
  }
}

export default App

/**
 * Thin client for the yoinks-web server.
 *
 * Every download happens server-side; the browser only ever holds a job id and
 * polls it. Keeping that split explicit here means the UI never has to know
 * about yt-dlp, cookies or ffmpeg.
 */

export type Choice = {
  index: number
  label: string
  kind: "video" | "audio"
}

export type ProbeResult = {
  title: string
  uploader?: string
  duration?: number
  thumbnail?: string
  extractor?: string
  source?: "spotify"
  audioUrl?: string
  /** Same-origin, browser-playable stream for the player. */
  previewUrl?: string
  spotify?: {
    name: string
    artist: string
    album?: string
    cover?: string
  }
  choices: Choice[]
}

export type JobStatus = "queued" | "downloading" | "processing" | "done" | "error" | "cancelled"

export type Job = {
  id: string
  status: JobStatus
  title: string
  label: string
  kind: "video" | "audio"
  downloadedBytes: number
  bytesOnDisk: number
  totalBytes?: number
  speed?: number
  eta?: number
  part: number
  totalParts: number
  filename?: string
  size?: number
  error?: string
  expiresAt?: number
  retentionHours?: number
}

export type RetentionOption = { hours: number; label: string }

export type AppConfig = {
  retention: { options: RetentionOption[]; defaultHours: number; maxHours: number }
}

export type StoredCookie = {
  key: string
  savedAt: string
  cookies: number
  domains: string[]
}

export type CookieSite = { key: string; label: string; domains: string[] }

/** Where the API lives. `vite dev` proxies /api, so same-origin works in both. */
const BASE = ""

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  })
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    // empty or non-JSON body
  }
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `Request failed (${response.status}).`
    throw new Error(message)
  }
  return body as T
}

export const api = {
  config: () => request<AppConfig>("/api/config"),

  probe: (url: string) =>
    request<ProbeResult>("/api/info", { method: "POST", body: JSON.stringify({ url }) }),

  download: (params: {
    url: string
    choice: number
    /** The label shown to the user; parsed server-side into fixed yt-dlp args. */
    choiceLabel?: string
    retentionHours: number
    title?: string
    artist?: string
    audioUrl?: string
    /** Same-origin (or direct CDN) stream the probe already validated. */
    previewUrl?: string
  }) => request<{ job: Job }>("/api/download", { method: "POST", body: JSON.stringify(params) }),

  job: (id: string) => request<Job>(`/api/jobs/${id}`),

  /** Resolve a link and start downloading it in one round-trip. */
  grab: (params: {url: string; retentionHours: number; choice?: number; choiceLabel?: string}) =>
    request<{job: Job; info: ProbeResult}>("/api/grab", {
      method: "POST",
      body: JSON.stringify(params),
    }),

  cancel: (id: string) => request<{ ok: true }>(`/api/jobs/${id}`, { method: "DELETE" }),

  fileUrl: (id: string) => `${BASE}/api/jobs/${id}/file`,

  /** Server-proxied preview stream for a source page URL. */
  previewUrl: (sourceUrl: string) => `${BASE}/api/preview?url=${encodeURIComponent(sourceUrl)}`,

  cookies: () => request<{ sites: CookieSite[]; stored: StoredCookie[] }>("/api/cookies"),

  saveCookies: async (key: string, text: string) => {
    const response = await fetch(`${BASE}/api/cookies/${key}`, {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: text,
    })
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    if (!response.ok) throw new Error(body?.error ?? "Could not save that session.")
    return body
  },

  removeCookies: (key: string) => request<{ ok: true }>(`/api/cookies/${key}`, { method: "DELETE" }),
}

/** Human-readable bytes, matching what the server reports. */
export function formatBytes(bytes?: number): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return ""
  const units = ["B", "KB", "MB", "GB"]
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

export function formatDuration(seconds?: number): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return ""
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes)
  return hours > 0 ? `${hours}:${mm}:${String(secs).padStart(2, "0")}` : `${mm}:${String(secs).padStart(2, "0")}`
}

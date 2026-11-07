/**
 * Sign-in management, one cookie jar per site.
 *
 * yt-dlp never logs in for us — it reads a Netscape cookies.txt — so "signing
 * in" means pasting an export from a browser that is already logged in. The
 * jar is stored server-side, which is what makes a session work from every
 * device.
 */
import { useCallback, useEffect, useState } from "react"
import { Trash2 } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { api, type CookieSite, type StoredCookie } from "@/lib/api"

const NETSCAPE_MARKER = "# Netscape HTTP Cookie File"

/** Domain used when pasted data carries none of its own. */
const SITE_DOMAIN: Record<string, string> = {
  youtube: ".youtube.com",
  deezer: ".deezer.com",
  x: ".x.com",
  instagram: ".instagram.com",
  tiktok: ".tiktok.com",
  reddit: ".reddit.com",
  vimeo: ".vimeo.com",
  facebook: ".facebook.com",
  twitch: ".twitch.tv",
  threads: ".threads.net",
}

/**
 * Accepts what people actually have: the Netscape export, Chrome's JSON
 * export, or a raw "name=value; name=value" cookie header.
 */
export function normaliseCookies(text: string, hostSuffix: string): string {
  const trimmed = text.trim()
  if (!trimmed || trimmed.startsWith(NETSCAPE_MARKER)) return trimmed

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { cookies?: unknown[] }).cookies)
          ? (parsed as { cookies: unknown[] }).cookies
          : null
      if (list) {
        const expiry = Math.floor(Date.now() / 1000) + 86400 * 180
        const rows = list
          .map((raw) => raw as { domain?: string; name?: string; value?: string; path?: string; expirationDate?: number })
          .filter((cookie) => cookie.name)
          .map((cookie) => {
            const domain = cookie.domain || hostSuffix
            return [
              domain,
              domain.startsWith(".") ? "TRUE" : "FALSE",
              cookie.path || "/",
              "TRUE",
              cookie.expirationDate ? Math.floor(cookie.expirationDate) : expiry,
              cookie.name,
              cookie.value ?? "",
            ].join("\t")
          })
        if (rows.length) return [NETSCAPE_MARKER, ...rows].join("\n")
      }
    } catch {
      // not JSON after all
    }
  }

  if (trimmed.includes("=") && !trimmed.includes("\t")) {
    const expiry = Math.floor(Date.now() / 1000) + 86400 * 180
    const domain = hostSuffix.startsWith(".") ? hostSuffix : `.${hostSuffix}`
    const rows = trimmed
      .split(";")
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const at = pair.indexOf("=")
        if (at < 1) return ""
        return [domain, "TRUE", "/", "TRUE", expiry, pair.slice(0, at).trim(), pair.slice(at + 1).trim()].join("\t")
      })
      .filter(Boolean)
    if (rows.length) return [NETSCAPE_MARKER, ...rows].join("\n")
  }

  return trimmed
}

export function SessionsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [sites, setSites] = useState<CookieSite[]>([])
  const [stored, setStored] = useState<StoredCookie[]>([])
  const [site, setSite] = useState("spotify")
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const data = await api.cookies()
      setSites(data.sites)
      setStored(data.stored)
      if (!data.sites.some((s) => s.key === site)) setSite(data.sites[0]?.key ?? "youtube")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load sessions.")
    }
  }, [site])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  const save = async () => {
    if (!text.trim()) {
      toast.error("Paste the exported cookies first.")
      return
    }
    setBusy(true)
    try {
      const normalised = normaliseCookies(text, SITE_DOMAIN[site] ?? "")
      await api.saveCookies(site, normalised)
      toast.success("Session saved")
      setText("")
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "That cookies file was rejected.")
    } finally {
      setBusy(false)
    }
  }

  const remove = async (key: string) => {
    setBusy(true)
    try {
      await api.removeCookies(key)
      toast.success("Session removed")
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove that session.")
    } finally {
      setBusy(false)
    }
  }

  const byKey = new Map(stored.map((entry) => [entry.key, entry]))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Signed-in sites</DialogTitle>
          <DialogDescription>
            Some sites only release media to a logged-in browser. Export cookies from a browser you are
            already logged into, then paste them here.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          {sites.map((entry) => {
            const saved = byKey.get(entry.key)
            return (
              <div
                key={entry.key}
                className="flex items-center justify-between gap-3 rounded-lg border p-3"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="text-sm font-medium">{entry.label}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {saved
                      ? `${saved.cookies} cookies · saved ${new Date(saved.savedAt).toLocaleDateString()}`
                      : entry.domains.slice(0, 2).join(", ")}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant={saved ? "default" : "secondary"}>
                    {saved ? "signed in" : "no session"}
                  </Badge>
                  {saved ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${entry.label} session`}
                      disabled={busy}
                      onClick={() => void remove(entry.key)}
                    >
                      <Trash2 />
                    </Button>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>

        <Separator />

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="cookie-site">Site</FieldLabel>
            <Select
              value={site}
              onValueChange={(value) => setSite(String(value))}
              items={sites.map((s) => ({ value: s.key, label: s.label }))}
            >
              <SelectTrigger id="cookie-site" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {sites.map((entry) => (
                    <SelectItem key={entry.key} value={entry.key}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor="cookie-text">Paste cookies</FieldLabel>
            <Textarea
              id="cookie-text"
              value={text}
              onChange={(event) => setText(event.target.value)}
              spellCheck={false}
              dir="ltr"
              rows={7}
              className="font-mono text-xs"
              placeholder={`${NETSCAPE_MARKER}\n.x.com\tTRUE\t/\tTRUE\t1830000000\tauth_token\t…`}
            />
            <FieldDescription>
              {site === "deezer" ? (
                <>
                  Deezer needs one cookie, <code>arl</code>. Log in at deezer.com, open DevTools →
                  Application → Cookies, and paste the <code>arl</code> value — a free account is
                  enough, and it makes downloads much faster.
                </>
              ) : (
                <>
                  In Cookie-Editor choose Export → Netscape and paste the whole thing. Chrome&apos;s
                  JSON export and a plain “name=value; …” header are converted automatically.
                </>
              )}
            </FieldDescription>
          </Field>
        </FieldGroup>

        <Button onClick={save} disabled={busy || !text.trim()}>
          {busy ? <Spinner data-icon="inline-start" /> : null}
          Save session
        </Button>
      </DialogContent>
    </Dialog>
  )
}

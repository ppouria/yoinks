/**
 * Per-site cookie jars for the web app.
 *
 * yt-dlp itself never logs in on our behalf: for the sites that need a session
 * (YouTube, X, Instagram, TikTok, Reddit, Vimeo) it reads a Netscape
 * cookies.txt. So "logging in" here means: a browser exports that file once,
 * we validate it, store it owner-only, and hand the right file to the right
 * yt-dlp invocation based on the URL's host.
 *
 * One jar per site key. Keeping them separate is deliberate: X's auth_token
 * must never be offered to youtube.com, and a corrupt jar for one site must
 * not break downloads for the others.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

/** hostname suffix → jar name, most specific first. */
const SITE_RULES: Array<{key: string; label: string; domains: string[]}> = [
  {key: 'youtube', label: 'YouTube', domains: ['youtube.com', 'youtu.be', 'youtube-nocookie.com', 'music.youtube.com']},
  {key: 'x', label: 'X / Twitter', domains: ['x.com', 'twitter.com', 't.co']},
  {key: 'instagram', label: 'Instagram', domains: ['instagram.com']},
  {key: 'tiktok', label: 'TikTok', domains: ['tiktok.com']},
  {key: 'reddit', label: 'Reddit', domains: ['reddit.com', 'redd.it']},
  {key: 'vimeo', label: 'Vimeo', domains: ['vimeo.com']},
  {key: 'facebook', label: 'Facebook', domains: ['facebook.com', 'fb.watch']},
  {key: 'twitch', label: 'Twitch', domains: ['twitch.tv']},
  {key: 'threads', label: 'Threads', domains: ['threads.net', 'threads.com']},
]

export const KNOWN_SITES = SITE_RULES.map(({key, label, domains}) => ({key, label, domains}))

export type StoredCookie = {
  key: string
  savedAt: string
  /** How many cookie lines the jar holds (not accounts — just state). */
  cookies: number
  /** Domains present in the jar, for a sanity check in the UI. */
  domains: string[]
}

/** Which jar (if any) applies to this URL. */
export function siteForUrl(rawUrl: string): {key: string; label: string} | undefined {
  let host: string
  try {
    host = new URL(rawUrl).hostname.toLowerCase()
  } catch {
    return undefined
  }
  for (const rule of SITE_RULES) {
    if (rule.domains.some(d => host === d || host.endsWith(`.${d}`))) {
      return {key: rule.key, label: rule.label}
    }
  }
  return undefined
}

/**
 * Two kinds of rejection here:
 *  - not a cookies.txt at all → the caller made a mistake, tell them
 *  - a cookies.txt for the *wrong site* → refuse to store it under this key,
 *    or the user silently gets unauthorised downloads for a site they never
 *    meant to touch.
 */
function parseNetscapeJar(text: string): {cookies: number; domains: string[]} {
  const domains = new Set<string>()
  let cookies = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#HttpOnly_')) {
      // still a real cookie line, just flagged
    } else if (line.startsWith('#')) {
      continue
    }
    const fields = line.split('\t')
    if (fields.length < 7) continue
    const domain = fields[0]!.replace(/^#HttpOnly_/, '').replace(/^\./, '').toLowerCase()
    if (!domain) continue
    domains.add(domain)
    cookies++
  }
  return {cookies, domains: [...domains]}
}

const NETSCAPE_MARKER = '# Netscape HTTP Cookie File'

function ensureNetscapeHeader(content: string): string {
  const trimmed = content.replace(/^\uFEFF/, '')
  const first = trimmed.split(/\r?\n/, 1)[0] ?? ''
  if (first.trim() === NETSCAPE_MARKER) return trimmed
  // keep any existing "# ..." comment but guarantee the marker is present
  return `${NETSCAPE_MARKER}\n${trimmed}`
}

export class CookieStore {
  constructor(private readonly dir: string) {}

  private jarPath(key: string): string {
    return path.join(this.dir, `${key}.txt`)
  }

  private metaPath(key: string): string {
    return path.join(this.dir, `${key}.json`)
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dir, {recursive: true, mode: 0o700})
    await fs.chmod(this.dir, 0o700).catch(() => {})
  }

  async list(): Promise<StoredCookie[]> {
    const out: StoredCookie[] = []
    for (const site of KNOWN_SITES) {
      const meta = await this.readMeta(site.key)
      if (meta) out.push(meta)
    }
    return out
  }

  private async readMeta(key: string): Promise<StoredCookie | undefined> {
    try {
      // the jar is the source of truth — a stale meta without a jar is a lie
      await fs.access(this.jarPath(key))
      const raw = JSON.parse(await fs.readFile(this.metaPath(key), 'utf8')) as StoredCookie
      return {...raw, key}
    } catch {
      return undefined
    }
  }

  async save(key: string, content: string): Promise<StoredCookie> {
    const site = SITE_RULES.find(s => s.key === key)
    if (!site) throw new Error('Unknown site.')

    const parsed = parseNetscapeJar(content)
  const {cookies, domains} = parsed
    if (cookies === 0) {
      throw new Error('That file is not a Netscape cookies.txt — export cookies with a browser extension.')
    }
    // The jar must actually belong to this site, otherwise a user could paste
    // their YouTube cookies under "x" and never notice.
    const belongs = domains.some(d => site.domains.some(allowed => d === allowed || d.endsWith(`.${allowed}`)))
    if (!belongs) {
      throw new Error(`Those cookies are for ${domains.slice(0, 3).join(', ')} — not ${site.label}.`)
    }

    await this.init()
    const tmp = `${this.jarPath(key)}.${process.pid}.tmp`
    // yt-dlp refuses a file without the Netscape marker line ("does not look
    // like a Netscape format cookies file"), so normalise it on the way in
    // rather than letting an upload succeed and silently do nothing.
    await fs.writeFile(tmp, ensureNetscapeHeader(content), {mode: 0o600})
    await fs.rename(tmp, this.jarPath(key))
    await fs.chmod(this.jarPath(key), 0o600).catch(() => {})

    const meta: StoredCookie = {
      key,
      savedAt: new Date().toISOString(),
      cookies,
      domains: domains.slice(0, 8),
    }
    await fs.writeFile(this.metaPath(key), JSON.stringify(meta), {mode: 0o600})
    return meta
  }

  async remove(key: string): Promise<void> {
    await fs.rm(this.jarPath(key), {force: true})
    await fs.rm(this.metaPath(key), {force: true})
  }

  /** The jar to pass to yt-dlp for this URL, if the site has one. */
  async jarForUrl(url: string): Promise<string | undefined> {
    const site = siteForUrl(url)
    if (!site) return undefined
    const file = this.jarPath(site.key)
    try {
      await fs.access(file)
      return file
    } catch {
      return undefined
    }
  }
}

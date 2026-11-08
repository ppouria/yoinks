# yoinks

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
  <img src="assets/logo-light.svg" alt="yoinks" width="288">
</picture>

yoink any video. paste. yoink. done.

Download videos from YouTube, X/Twitter, Instagram, Threads, TikTok and
1,800+ other sites — right from your terminal. Paste a url, pick a
resolution (or audio-only mp3), done. No popups, no fake download buttons,
no sketchy redirects.

<img src="assets/home.png" alt="yoinks home screen — paste a link and hit yoink" width="100%">

## Install

```sh
npm install -g yoinks
```

Or try it without installing anything:

```sh
npx yoinks
```

Requires Node 18+. Everything else (yt-dlp, ffmpeg) is fetched or bundled
automatically.

## Usage

```sh
$ yoinks https://youtu.be/dQw4w9WgXcQ    # straight to the format picker
$ yoinks                                 # prompts for a url
$ yoinks --theme light                   # force the light palette
```

yoinks takes over the terminal (full-screen, centered — and restores your
scrollback on exit). Pick a format with ↑/↓ (or j/k, or number keys) and
hit enter. `esc` goes back, `^c` quits. Or just use the mouse — the yoink
button, the format list and the footer hints are all clickable, and
clicking the logo takes you back home. Files are saved to `~/Downloads`,
and the file path is printed to your terminal when you're done.

The default `auto` theme uses your terminal's own foreground and background,
so it follows light and dark terminal themes without guessing. Press `^t` or
click the theme control in the footer to cycle through `auto`, `light`, and
`dark` for the current session. Use `--theme auto`, `--theme light`, or
`--theme dark` to choose the starting theme for one launch.

<img src="assets/download-options.png" alt="yoinks format picker — resolutions with estimated file sizes, plus audio-only mp3" width="100%">

## How it works

- Powered by [yt-dlp](https://github.com/yt-dlp/yt-dlp). On first run,
  yoinks downloads the standalone yt-dlp binary to `~/.yoinks/bin` —
  no Python required. If you already have yt-dlp installed, it uses yours.
- ffmpeg (needed for merging high-res streams and mp3 extraction) is found
  on your PATH, with `ffmpeg-static` as a bundled fallback.
- The UI is [Ink](https://github.com/vadimdemedes/ink) — React for the
  terminal.

## Development

```sh
npm install
npm run build        # bundle to dist/ with tsup
npm run dev          # rebuild on change
node dist/cli.js <url>
npm run typecheck
```

To try it as a global command without publishing: `npm link`, then run
`yoinks` anywhere.

## Roadmap

- [ ] `--best` / `--mp3` flags to skip the picker (scriptable mode)
- [ ] `-o <dir>` to choose the output folder
- [ ] Playlist / thread-with-multiple-videos support
- [ ] Clipboard detection: launch bare and auto-suggest the url you copied
- [ ] Self-update for the bundled yt-dlp binary (`yt-dlp -U`)
- [x] Publish to npm (`npm i -g yoinks` / `npx yoinks`)
- [ ] `curl yoinks.sh | sh` installer

## Web app

This fork adds a small HTTP server + web UI (`src/web/`) that reuses the same
`src/lib/ytdlp.ts` probe/download plumbing as the TUI. Paste a link, pick a
format, get the file. No framework, no build step beyond the server bundle.

```sh
npm run build
PORT=3000 npm run web      # http://127.0.0.1:3000
```

Run locally it uses your own `yt-dlp`/`ffmpeg`, so it behaves like the CLI.
It listens only on `HOST` (default `127.0.0.1`) — put it behind a proxy or a
panel that terminates TLS.

### API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/info` | `{url}` → title, uploader, thumbnail, `choices[]` |
| `POST` | `/api/download` | `{url, choice}` → `{job}` (the job starts immediately) |
| `GET` | `/api/jobs/:id` | progress: `status`, `bytesOnDisk`, `totalBytes`, `speed`, `eta` |
| `DELETE` | `/api/jobs/:id` | cancel and delete the partial file |
| `GET` | `/api/jobs/:id/file` | stream the finished file (supports `Range`) |
| `GET` | `/healthz` | `{ok, ytdlp, active}` |

A download never blocks a request: the client polls the job. Finished files
are served from disk and deleted an hour after they complete.

### Frontend

The UI is a shadcn/ui (Base UI + Tailwind v4) SPA in `webapp/webapp`, built into
`dist/web/public` so the Node server serves it:

```sh
npm install
cd webapp/webapp && npm install && cd ../..

npm run build       # tsup + vite  → dist/web/server.js + dist/web/public
npm run web         # http://127.0.0.1:3000
npm run dev:web     # Vite dev server; proxies /api to YOINKS_API (default :3017)
```

Paste a link and the player appears: cover, title, artist, seek bar, ±10s,
volume. Play it while the server copy is being made, then the download button
and shareable link appear underneath when it is ready.

Playing needs a browser-reachable stream, and a source *page* URL (YouTube,
Spotify) is not playable media. `GET /api/preview?url=…` resolves the signed
stream with `yt-dlp -g` and proxies it same-origin, so the `<audio>` element
gets real bytes and Range requests keep seeking working.

### Paste and go

Pasting a link starts the download immediately — one `POST /api/grab` resolves
the link and creates the job, so there is no "load, then save" round trip. The
player appears as soon as metadata is known (~0.5s) and the finished file with
its download button lands a couple of seconds later.

`POST /api/info` + `POST /api/download` remain available separately for clients
that want to show a format picker before committing.

### Telegram bot

Send the bot a link and it replies with the file. It is a long-polling bot (no
webhook, no extra public port) and it calls the **same** probe/download code as
the web UI, so source racing, cookie jars and Deezer decryption all apply.

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token.
2. Put it on the server:

```sh
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
# optional: comma-separated chat ids; set this, or anyone who finds the bot
# downloads on your Deezer session
TELEGRAM_ALLOWED_CHATS=123456789
```

3. Restart. The log shows `[telegram] bot @yourbot polling`.

Telegram rejects bot uploads over 50 MB, so a larger file is answered with the
`/api/jobs/<id>/file` link instead (set `YOINKS_PUBLIC_URL` so the link is
absolute). Find your chat id by messaging the bot and reading the update, or
with `@userinfobot`.

### X / Twitter

Twitter publishes both HLS variants and progressive MP4s (`http-*`). The fast
path requests the progressive one, so the file is a single range-fetch instead of
yt-dlp reassembling HLS segments: **~28s → ~3s** for a 30-second video.

### Audio sources

Providers are asked **in parallel** and the first full-length answer wins
(`src/web/source-race.ts`). A fixed order meant always paying for whichever
provider happened to be slow; racing means a slow YouTube does not hold up a
fast Deezer result.

| Source | Needs | Notes |
| --- | --- | --- |
| Deezer | `arl` cookie (free account) | Fastest: one API call, ~1s |
| YouTube / SoundCloud | — | via yt-dlp; benefits from a YouTube session |

A candidate only wins if it returns playable media **and** its duration matches
the requested track to within 10% — that is what stops a 30-second preview from
being served as the song.

Note on Deezer: its CDN serves BF_CBC_STRIPE-encrypted audio, so the URL alone
is useless to a player and to ffprobe. The bridge fetches and decrypts it
(key derived from the track id, every third 2048-byte block) before the file is
written, which is why the container looks like a normal mp3 only after that step.

### Deezer (fastest audio source)

Deezer is the only source that returns a plain CDN file after a single API call
— no yt-dlp, no JS challenge, no manifest — so it is tried **first** for every
Spotify track and used directly for `deezer.com/track/…` links.

Add an `arl` cookie under **Sessions → Deezer** (DevTools → Application →
Cookies → `arl`). A free account is enough (128 kbps mp3); a premium one gets
320/flac. Without a session Deezer only serves 30-second previews, which are
never accepted as a match — the YouTube path takes over instead.

The protocol lives in `src/web/deezer_bridge.py` (one JSON request in, one JSON
answer out) and needs `pip install deezer-py` next to yt-dlp.

### Download speed

Profiling showed the transfer was never the bottleneck — googlevideo serves a
3.3 MB track in about 200 ms when byte ranges are requested in parallel. The
seconds were yt-dlp overhead: ~0.5 s Python start-up, then several serial
round-trips before a single byte moved.

`src/web/fastfetch.ts` splits the work:

1. **resolve** — yt-dlp, but only to obtain a signed stream URL, cached briefly.
   `player_client=visionos` avoids the slow JS-challenge step.
2. **fetch** — parallel range requests straight from the CDN, made with `curl`
   rather than Node's `fetch`: googlevideo answers Node with 403 for the same
   signed URL that curl fetches with 206, so the request is made by a client the
   CDN actually serves.

Everything else (HLS/live streams, video that needs muxing, any failure) falls
back to the normal yt-dlp download.

Measured on the deployment: the first download of a link varies with YouTube's
answers, but subsequent ones complete in **~1.4 s**.

### Retention and the download link

Downloads run on the server; the browser gets a link, not a file stream it has
to babysit. Pick how long the link lives — **4 hours** (default), 12 hours,
1 day, 3 days or 1 week — on the format picker. The server enforces a ceiling
(`YOINKS_MAX_RETENTION_HOURS`, default 168), so a forged value cannot live
longer than a week. Expired files are removed by a sweep that runs every minute,
and their links start returning 404.

The finished link (`/api/jobs/:id/file`) is shareable: open it from any device
before it expires to download the file again.

### Spotify

Spotify serves DRM-protected audio, so nothing can pull the stream out of it.
Instead this app uses [spotDL](https://github.com/spotDL/spotify-downloader) for
**metadata only** (`spotdl save`, which downloads nothing), then sources the
audio from a public provider through the same yt-dlp path as everything else —
so retention, progress and cookie jars all apply unchanged.

```sh
pip install spotdl            # or set YOINKS_SPOTDL_BIN to its path
```

Paste an `open.spotify.com/track/...` link; it resolves to "Artist - Title" and
downloads as mp3. Track links only — a playlist is N tracks and is not built.

Audio is resolved at *probe* time across several sources (YouTube, a YouTube
audio search, SoundCloud), and each candidate is validated before it is offered:
it must have an audio stream and its duration must match Spotify's to within
20%. That last check matters — SoundCloud search returns 30-second teasers, and
shipping one of those as "your song" is worse than an honest error.

If no source can be reached, the UI says so up front instead of failing after a
download. The usual cause is YouTube's IP-level bot check on datacenter hosts;
a YouTube session under **signed-in sites** is the only reliable fix.

**Tagging.** The audio arrives carrying the *source upload's* metadata, so after
the download the ID3 tags are rewritten from Spotify's data: title, artists,
album, album artist, year, track number and an embedded cover. Metadata comes
from Spotify's public embed JSON (~200 ms); `spotdl save` (~24 s) is only used
for the album fields, and runs *alongside* the download so it costs no extra
wall time.

### Signed-in sites (cookies)

Some sites only release media to a signed-in browser — X in particular returns
an empty `TweetTombstone` for age-restricted accounts, and YouTube applies an
IP-level bot check to datacenter hosts. yt-dlp never logs in on our behalf; it
reads a Netscape `cookies.txt`, so "signing in" here means exporting one from a
browser that is already logged in.

Open **signed-in sites** in the footer, pick the platform, and either paste the
exported cookies or upload the file. Paste accepts the Cookie-Editor **Netscape**
export, a Chrome DevTools **JSON** export, and a raw `name=value; name=value`
header string — the other two are converted on the client before upload.

Jars live on the server, not in the browser, so a session saved from one device
is used by every device that opens this page.
Each platform gets its own jar, and a jar is only ever handed to yt-dlp for URLs
belonging to that platform — X's `auth_token` is never offered to `youtube.com`.

```sh
# or from the command line
curl -X PUT --data-binary @cookies.txt http://127.0.0.1:3000/api/cookies/x
curl http://127.0.0.1:3000/api/cookies        # what is stored, and for which site
curl -X DELETE http://127.0.0.1:3000/api/cookies/x
```

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/cookies` | supported sites + stored jars |
| `PUT`/`POST` | `/api/cookies/:site` | store a `cookies.txt` (raw body or `{cookies}`) |
| `DELETE` | `/api/cookies/:site` | forget that session |
| `POST` | `/api/cookies/lookup` | `{url}` → which site it maps to, and whether a jar exists |

Jars live in `YOINKS_COOKIE_DIR` as `0600` files inside a `0700` directory.
Treat them like passwords: they grant account access, they expire, and an
export made on a different IP can make the site flag you for a re-login.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `3000` | listen address |
| `YOINKS_WORK_DIR` | `./downloads` | where finished/in-progress files live |
| `YOINKS_DIR_BUDGET_BYTES` | 8 GiB | refuse new downloads past this |
| `YOINKS_RETENTION_HOURS` | 4 | default lifetime of a finished file |
| `YOINKS_MAX_RETENTION_HOURS` | 168 | hard ceiling (1 week) |
| `YOINKS_SPOTDL_BIN` | `spotdl` | path to spotDL for Spotify metadata |
| `YOINKS_MAX_ACTIVE` | 2 | concurrent downloads |
| `YOINKS_PROBE_TIMEOUT_MS` | 90 s | probe timeout |
| `YOINKS_COOKIE_DIR` | `./cookies` | per-site cookie jars |
| `YOINKS_COOKIES_FILE` | — | one fallback jar used when no per-site jar matches |

### A note on YouTube from a server

YouTube applies an **IP-level** bot check. From a home connection the web app
works like the CLI; from a datacenter/VPS IP most YouTube links fail with
*"Sign in to confirm you're not a bot"* while every other site keeps working.
That is YouTube's decision, not something the app can fix — PO tokens, WARP,
IPv6 and client spoofing were all tested and none of them get past it.
If you need YouTube on a server, point `YOINKS_COOKIES_FILE` at a
`cookies.txt` exported from a **logged-in** browser session:

```sh
# export with the "Get cookies.txt LOCALLY" extension while signed in,
# then:
YOINKS_COOKIES_FILE=/etc/yoinks/cookies.txt npm run web
```

Treat that file like a password. A shared/throwaway account is safer than
your main one.

## Deploying as a Rebecca external app

The server runs unmodified as a Node.js external app (`HOST`/`PORT` come from
the panel's unit). Package the built output with the entry at the archive root:

```sh
npm run build
mkdir -p /tmp/pkg && cp -r dist/web/. /tmp/pkg/
cp /tmp/pkg/server.js /tmp/pkg/ ; # entry must be server.js at the root
(cd /tmp/pkg && zip -qr ../downloader.zip .)
```

Then install it with a `package.json` whose `start` script runs `node server.js`.
Set `YOINKS_WORK_DIR` to a path inside the app directory — the panel runs
external apps with a private, ephemeral `/tmp`.

## A note on fair use

yoinks is a personal-archiving tool. Downloading content may violate a
platform's terms of service — only download what you have the right to
keep, and be excellent to creators.

## License

[MIT](LICENSE)

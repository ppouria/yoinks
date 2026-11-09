/**
 * Telegram bot: send a link, get the result back.
 *
 * A long-polling bot (no webhook, no public port) that reuses the exact same
 * pipeline as the web UI — grab the link, wait for the job, send the file. That
 * means one place to fix behaviour, and the bot inherits source racing, cookie
 * jars and Deezer decryption for free.
 *
 * Configure with TELEGRAM_BOT_TOKEN. Optionally TELEGRAM_ALLOWED_CHATS (comma
 * separated chat ids) to restrict who can use it — a public bot will otherwise
 * download on the owner's Deezer session for anyone who finds it.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import {storageConfigured, uploadToStorage, userUploadConfigured} from './large-file.js'

const API = (token: string, method: string) => `https://api.telegram.org/bot${token}/${method}`

export type BotDeps = {
  /** Resolve a link and start a job; returns the job id and what it will be. */
  startJob: (url: string) => Promise<{jobId: string; title: string; isAudio: boolean}>
  /**
   * Delete a job's files once they have reached the user. Telegram keeps its own
   * copy, so the server copy is dead weight — and keeping it is what bloated the
   * panel's backups.
   */
  releaseJob?: (jobId: string) => Promise<void>
  /** Poll a job until it finishes. */
  waitForJob: (jobId: string, timeoutMs: number) => Promise<{
    status: string
    filepath?: string
    filename?: string
    error?: string
    expiresAt?: number
  }>
}

type TelegramFile = {
  file_id: string
  file_name?: string
  file_size?: number
}

type Update = {
  update_id: number
  message?: {
    message_id: number
    chat: {id: number; type: string}
    from?: {id: number; username?: string}
    text?: string
    /** The user sent a file — this is what gets copied back. */
    document?: TelegramFile
    video?: TelegramFile
    audio?: TelegramFile
  }
}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
const ALLOWED = (process.env.TELEGRAM_ALLOWED_CHATS || '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean)
/** Telegram refuses uploads beyond this; ask for the sendDocument limit. */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
/** How long a single link may take before the bot gives up waiting. */
const JOB_TIMEOUT_MS = Number(process.env.TELEGRAM_JOB_TIMEOUT_MS || 180_000)

let running = false
let offset = 0

async function call(method: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(API(TOKEN, method), {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(body),
  })
  const payload = (await response.json().catch(() => ({}))) as {ok?: boolean; description?: string}
  if (!payload.ok) throw new Error(payload.description || `Telegram ${method} failed`)
  return payload
}

async function sendMessage(chatId: number, text: string): Promise<void> {
  await call('sendMessage', {chat_id: chatId, text, disable_web_page_preview: true}).catch(() => {})
}

/**
 * Upload the finished file. Telegram caps bot uploads at 50MB, so anything
 * larger is answered with the link instead — better than a silent failure.
 */
async function sendFile(chatId: number, filepath: string, filename: string, caption: string): Promise<boolean> {
  const stat = await fs.stat(filepath).catch(() => undefined)
  if (!stat) return false
  if (stat.size > MAX_UPLOAD_BYTES) return false

  const form = new FormData()
  form.set('chat_id', String(chatId))
  form.set('caption', caption)
  const bytes = await fs.readFile(filepath)
  form.set('document', new Blob([bytes]), filename)

  const response = await fetch(API(TOKEN, 'sendDocument'), {method: 'POST', body: form})
  const payload = (await response.json().catch(() => ({}))) as {ok?: boolean}
  return Boolean(payload.ok)
}

const URL_PATTERN = /https?:\/\/\S+/i

async function handleMessage(update: Update, deps: BotDeps): Promise<void> {
  const message = update.message
  if (!message) return
  const chatId = message.chat.id

  if (ALLOWED.length > 0 && !ALLOWED.includes(String(chatId))) {
    await sendMessage(chatId, 'This bot is private.')
    return
  }

  // A file the user sent us: copy it straight back. This is the delivery path
  // for anything above the bot's 50MB upload limit — the bytes are already on
  // Telegram's servers, so copying costs nothing instead of a second upload.
  const file = message.document ?? message.video ?? message.audio
  if (file) {
    const label = file.file_name ?? 'file'
    const copied = await copyMessageTo(chatId, chatId, message.message_id)
    await sendMessage(
      chatId,
      copied
        ? `${label} (${formatBytes(file.file_size ?? 0)}) copied back to you.`
        : `Could not copy ${label}.`,
    )
    return
  }

  if (!message.text) return
  const text = message.text.trim()

  if (text === '/start' || text === '/help') {
    await sendMessage(
      chatId,
      'Send me a link — Spotify, YouTube, X, SoundCloud, Deezer — and I will send the file back.\n\n' +
        'Files up to 50MB come straight from me. Anything bigger: I give you a link, and if you\n' +
        'send that file to me as a document I will copy it straight back — no re-upload.\n\n' +
        'I keep finished files for a few hours.',
    )
    return
  }

  const match = URL_PATTERN.exec(text)
  if (!match) {
    await sendMessage(chatId, 'That does not look like a link. Paste a full http(s) URL.')
    return
  }
  const url = match[0]

  const started = Date.now()

  let jobId: string
  let title: string
  try {
    const begun = await deps.startJob(url)
    jobId = begun.jobId
    title = begun.title
    await sendMessage(chatId, `Fetching: ${title.slice(0, 120)}`)
  } catch (error) {
    await sendMessage(chatId, `Could not read that link: ${(error as Error).message}`)
    return
  }

  const job = await deps.waitForJob(jobId, JOB_TIMEOUT_MS)
  if (job.status !== 'done' || !job.filepath) {
    await sendMessage(chatId, `Download failed: ${job.error ?? job.status}`)
    return
  }

  const filename = job.filename ?? path.basename(job.filepath)
  const seconds = Math.round((Date.now() - started) / 1000)
  const caption = `${title}\n${formatBytes(await fs.stat(job.filepath).then(s => s.size).catch(() => 0))} · ${seconds}s`

  const size = await fs.stat(job.filepath).then(stat => stat.size).catch(() => 0)
  const botLimit = size <= MAX_UPLOAD_BYTES

  // The bot uploads directly while the file fits in its 50MB budget.
  if (botLimit && (await sendFile(chatId, job.filepath, filename, caption).catch(() => false))) {
    await deps.releaseJob?.(jobId).catch(() => {})
    return
  }

  // Over the Bot API limit. The user account can upload up to 2GB, so it parks
  // the file in a private channel and the bot copies it out of there — one
  // upload, then a copy, instead of pushing the same bytes twice.
  if (userUploadConfigured() && storageConfigured()) {
    await sendMessage(chatId, `Large file (${formatBytes(size)}) — uploading from the user account…`)
    const stored = await uploadToStorage(job.filepath, caption).catch(error => {
      console.error('[telegram] storage upload failed:', (error as Error).message)
      return undefined
    })
    if (stored) {
      const delivered = await copyStoredFile(chatId, stored.chatId, stored.messageId).catch(() => false)
      if (delivered) {
        // The bytes now live in Telegram (the storage channel); nothing on this
        // server needs to keep them.
        await deps.releaseJob?.(jobId).catch(() => {})
        return
      }
    }
  }

  if (userUploadConfigured()) {
    // Storage channel not configured, or the copy failed: ask the user to send
    // the file in, which the bot can copy back without any upload.
    await sendMessage(
      chatId,
      `Could not send ${formatBytes(size)} as a document.\n\n` +
        `Send the file to me and I will copy it back instantly.\n` +
        `Or grab it here: ${publicUrl ?? ''}/api/jobs/${jobId}/file`,
    )
    return
  }

  // Nothing could deliver the file: hand over the link rather than nothing.
  await sendMessage(chatId, `${title}\nCould not send the file (${formatBytes(size)}), but it is here: ${publicUrl ?? ''}/api/jobs/${jobId}/file`)
}

/**
 * Copy a message out of the storage channel into the requester's chat.
 * `from_chat_id` accepts the channel's numeric id or @username.
 */
async function copyStoredFile(chatId: number, fromChat: string, messageId: number): Promise<boolean> {
  try {
    await call('copyMessage', {
      chat_id: chatId,
      from_chat_id: fromChat,
      message_id: messageId,
    })
    return true
  } catch (error) {
    console.error('[telegram] copy from storage failed:', (error as Error).message)
    return false
  }
}

/**
 * Copy a message the user sent to us back to them.
 *
 * `copyMessage` has no size limit beyond whatever Telegram already accepted from
 * the sender, so a 2GB file the user uploaded arrives back instantly — the bytes
 * are already on Telegram's servers and are only re-pointed.
 */
async function copyMessageTo(toChatId: number, fromChatId: number, messageId: number, caption?: string): Promise<boolean> {
  try {
    await call('copyMessage', {
      chat_id: toChatId,
      from_chat_id: fromChatId,
      message_id: messageId,
      ...(caption ? {caption} : {}),
    })
    return true
  } catch (error) {
    console.error('[telegram] copyMessage failed:', (error as Error).message)
    return false
  }
}

function formatBytes(bytes: number): string {
  if (!bytes) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** Filled in by the server so oversized files can be linked instead. */
let publicUrl: string | undefined

export function telegramConfigured(): boolean {
  return Boolean(TOKEN)
}

/** Long-poll loop; started by the server when a token is present. */
export async function startTelegramBot(deps: BotDeps, baseUrl?: string): Promise<void> {
  if (!TOKEN || running) return
  running = true
  publicUrl = baseUrl

  const me = (await call('getMe', {}).catch(error => {
    console.error('[telegram] getMe failed:', (error as Error).message)
    return undefined
  })) as {result?: {username?: string}} | undefined
  if (!me) {
    running = false
    return
  }
  console.log(`[telegram] bot @${me.result?.username} polling`)

  // Long polling rather than a webhook: no extra public port, and nothing to
  // reconfigure when the domain changes.
  for (;;) {
    try {
      const response = (await call('getUpdates', {
        offset,
        timeout: 30,
        allowed_updates: ['message'],
      })) as {result?: Update[]}

      for (const update of response.result ?? []) {
        offset = update.update_id + 1
        // Never let one bad message kill the loop.
        void handleMessage(update, deps).catch(error =>
          console.error('[telegram] handler failed:', (error as Error).message),
        )
      }
    } catch (error) {
      console.error('[telegram] polling error:', (error as Error).message)
      await new Promise(resolve => setTimeout(resolve, 5000))
    }
  }
}

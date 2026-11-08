/**
 * Large-file delivery through a user account (MTProto).
 *
 * The Bot API caps uploads at 50MB. A user account has no such limit — 2GB, or
 * 4GB with Premium — so for anything bigger we log in as a real account over
 * MTProto and send the file from there. The bot then replies in the chat with a
 * pointer to what arrived.
 *
 * Auth is a one-time interactive login ("Telegram Desktop" style): the first
 * run asks for the phone number, the code Telegram sends, and the 2FA password
 * if the account has one. The resulting session string is reused afterwards, so
 * the server never needs the password again.
 *
 * Non-negotiable: the session string is a full login to that account. It is read
 * from the environment only, never written to a tracked file.
 */
import {spawn} from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

type TeleprotoModule = typeof import('teleproto')

let client: InstanceType<TeleprotoModule['TelegramClient']> | undefined
let connecting: Promise<InstanceType<TeleprotoModule['TelegramClient']>> | undefined

/** MTProto allows 2GB per upload on a normal account, 4GB with Premium. */
export const USER_UPLOAD_LIMIT_BYTES = 2 * 1024 ** 3

const SESSION = process.env.TELEGRAM_USER_SESSION || ''
const API_ID = Number(process.env.TELEGRAM_API_ID || 0)
const API_HASH = process.env.TELEGRAM_API_HASH || ''

export function userUploadConfigured(): boolean {
  return Boolean(SESSION && API_ID && API_HASH)
}

/**
 * teleproto is CJS. Bundled to ESM its exports land on `.default`, while a dev
 * run (unbundled) exposes them as named exports — this bit us twice, first with
 * StringSession and then with TelegramClient. One resolver for both shapes.
 */
function pickExport<T>(mod: unknown, name: string): T {
  const asRecord = mod as Record<string, unknown>
  const fromDefault = (asRecord.default as Record<string, unknown> | undefined)?.[name]
  const candidate = asRecord[name] ?? fromDefault
  if (!candidate) throw new Error(`teleproto: ${name} is unavailable`)
  return candidate as T
}

type StringSessionCtor = new (value: string) => import('teleproto/sessions').StringSession
type TelegramClientCtor = typeof import('teleproto').TelegramClient

async function loadStringSession(): Promise<StringSessionCtor> {
  return pickExport<StringSessionCtor>(await import('teleproto/sessions'), 'StringSession')
}

async function loadTelegramClient(): Promise<TelegramClientCtor> {
  return pickExport<TelegramClientCtor>(await import('teleproto'), 'TelegramClient')
}

async function getClient(): Promise<InstanceType<TeleprotoModule['TelegramClient']>> {
  if (client) return client
  if (connecting) return connecting

  connecting = (async () => {
    const TelegramClient = await loadTelegramClient()
    const StringSession = await loadStringSession()

    const instance = new TelegramClient(new StringSession(SESSION), API_ID, API_HASH, {
      connectionRetries: 3,
    })
    await instance.connect()
    if (!(await instance.checkAuthorization())) {
      throw new Error(
        'The Telegram user session is not authorised. Re-run the login helper (npm run telegram:login).',
      )
    }
    client = instance
    return instance
  })()

  try {
    return await connecting
  } finally {
    connecting = undefined
  }
}

/**
 * Where the user account parks files: a private channel the bot also belongs to.
 *
 * The upload happens once, from the user account (2GB limit), into this channel.
 * The bot then copies the message out of it — copying an existing Telegram
 * message has no size limit, so a 2GB file reaches the requester without a
 * second byte of upload.
 */
const STORAGE_CHAT = process.env.TELEGRAM_STORAGE_CHAT || ''

export function storageConfigured(): boolean {
  return Boolean(STORAGE_CHAT)
}

/**
 * Upload a file from the user account into the storage channel.
 * Returns the resulting message id, which the bot copies from.
 */
export async function uploadToStorage(
  filepath: string,
  caption: string,
): Promise<{chatId: string; messageId: number} | undefined> {
  if (!userUploadConfigured() || !STORAGE_CHAT) return undefined

  const stat = await fs.stat(filepath).catch(() => undefined)
  if (!stat) return undefined
  if (stat.size > USER_UPLOAD_LIMIT_BYTES) {
    throw new Error(`file is ${formatMb(stat.size)}, over the 2GB account limit`)
  }

  const instance = await getClient()
  const entity = await instance.getInputEntity(STORAGE_CHAT)

  // Send media as media: `forceDocument` made every video arrive as a file,
  // which is not what a user expects from a video download. Telegram needs a
  // few attributes to render a playable video/audio message.
  const kind = mediaKind(filepath)
  const options: Record<string, unknown> = {
    file: filepath,
    caption,
    // A few parallel connections keep large uploads from stalling.
    workers: 4,
  }
  if (kind === 'video') {
    const {width, height, duration} = await probeMedia(filepath)
    options.attributes = [
      new (await loadApi()).DocumentAttributeVideo({
        duration,
        w: width,
        h: height,
        supportsStreaming: true,
      }),
    ]
    options.forceDocument = false
  } else if (kind === 'audio') {
    options.attributes = [
      new (await loadApi()).DocumentAttributeAudio({
        duration: await probeAudioDuration(filepath),
        title: caption.split('\n')[0] ?? '',
      }),
    ]
    options.forceDocument = false
  } else {
    options.forceDocument = true
  }

  const result = await instance.sendFile(entity, options as never)
  if (!result?.id) throw new Error('upload produced no message id')
  return {chatId: STORAGE_CHAT, messageId: result.id}
}

async function loadApi(): Promise<typeof import('teleproto').Api> {
  return pickExport<typeof import('teleproto').Api>(await import('teleproto'), 'Api')
}

/** How should this file be presented in Telegram? */
function mediaKind(filepath: string): 'video' | 'audio' | 'file' {
  const ext = path.extname(filepath).toLowerCase()
  if (['.mp4', '.webm', '.mkv', '.mov'].includes(ext)) return 'video'
  if (['.mp3', '.m4a', '.ogg', '.opus', '.flac'].includes(ext)) return 'audio'
  return 'file'
}

/** ffprobe for real dimensions/duration; Telegram shows garbage otherwise. */
async function probeMedia(filepath: string): Promise<{width: number; height: number; duration: number}> {
  return new Promise(resolve => {
    const child = spawn('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-show_entries', 'format=duration',
      '-of', 'json', filepath,
    ])
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => (out += chunk))
    child.on('error', () => resolve({width: 0, height: 0, duration: 0}))
    child.on('close', () => {
      try {
        const parsed = JSON.parse(out) as {streams?: Array<{width?: number; height?: number}>; format?: {duration?: string}}
        const stream = parsed.streams?.[0]
        resolve({
          width: stream?.width ?? 0,
          height: stream?.height ?? 0,
          duration: Math.round(Number(parsed.format?.duration ?? 0)) || 0,
        })
      } catch {
        resolve({width: 0, height: 0, duration: 0})
      }
    })
  })
}

async function probeAudioDuration(filepath: string): Promise<number> {
  return (await probeMedia(filepath)).duration
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Close the MTProto connection on shutdown. */
export async function stopUserUploader(): Promise<void> {
  await client?.disconnect().catch(() => {})
  client = undefined
}

/**
 * Interactive one-time login helper, run outside the server:
 *   npm run telegram:login
 * Prints a session string to paste into TELEGRAM_USER_SESSION.
 */
export async function interactiveLogin(): Promise<void> {
  const TelegramClient = await loadTelegramClient()
  const StringSession = await loadStringSession()
  const readline = await import('node:readline/promises')

  if (!API_ID || !API_HASH) {
    console.error('Set TELEGRAM_API_ID and TELEGRAM_API_HASH first (https://my.telegram.org/apps).')
    process.exit(1)
  }

  const rl = readline.createInterface({input: process.stdin, output: process.stdout})
  const instance = new TelegramClient(new StringSession(''), API_ID, API_HASH, {connectionRetries: 3})

  await instance.start({
    phoneNumber: async () => rl.question('Phone (international format, e.g. +9891...): '),
    password: async () => rl.question('2FA password (blank if none): '),
    phoneCode: async () => rl.question('Code Telegram sent you: '),
    // Returning false aborts the flow; true retries, which is what we want for
    // a mistyped code while setting the account up.
    onError: async (error: Error) => {
      console.error('Login error:', error.message)
      return true
    },
  })

  console.log('\nLogged in. Add this to the server .env (keep it secret):\n')
  console.log(`TELEGRAM_USER_SESSION=${instance.session.save()}\n`)
  await instance.disconnect()
  rl.close()
}

/** Resolve the file's mime type so Telegram renders a sensible preview. */
export async function guessMime(filepath: string): Promise<string> {
  const ext = path.extname(filepath).toLowerCase()
  if (ext === '.mp4') return 'video/mp4'
  if (ext === '.mp3') return 'audio/mpeg'
  if (ext === '.webm') return 'video/webm'
  if (ext === '.m4a') return 'audio/mp4'
  return 'application/octet-stream'
}

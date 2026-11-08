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
 * `teleproto/sessions` is CJS; bundling to ESM puts its exports on `.default`
 * while a dev run exposes them as named exports. Accept both.
 */
type StringSessionCtor = new (value: string) => import('teleproto/sessions').StringSession
async function loadStringSession(): Promise<StringSessionCtor> {
  const mod = (await import('teleproto/sessions')) as unknown as {
    StringSession?: unknown
    default?: {StringSession?: unknown}
  }
  const candidate = mod.StringSession ?? mod.default?.StringSession
  if (!candidate) throw new Error('teleproto sessions module is unavailable')
  // The runtime object is a teleproto Session; the cast keeps the call sites
  // typed without re-declaring its interface here.
  return candidate as unknown as StringSessionCtor
}

async function getClient(): Promise<InstanceType<TeleprotoModule['TelegramClient']>> {
  if (client) return client
  if (connecting) return connecting

  connecting = (async () => {
    const {TelegramClient} = await import('teleproto')
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
 * Send a file from the user account into `chatId`.
 * Returns the sent message's id, or undefined when it could not be sent.
 */
export async function sendLargeFileAsUser(
  chatId: number,
  filepath: string,
  caption: string,
): Promise<number | undefined> {
  if (!userUploadConfigured()) return undefined

  const stat = await fs.stat(filepath).catch(() => undefined)
  if (!stat || stat.size > USER_UPLOAD_LIMIT_BYTES) return undefined

  const instance = await getClient()
  const result = await instance.sendFile(
    // The bot's chat id for a private chat *is* the user id, which MTProto can
    // resolve directly.
    chatId as unknown as import('teleproto').Api.User,
    {
      file: filepath,
      forceDocument: true,
      caption,
      // Uploading resumes on its own; this just keeps big files moving.
      workers: 4,
    },
  )
  return result?.id
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
  const {TelegramClient} = await import('teleproto')
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

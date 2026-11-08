/**
 * Step-wise MTProto login.
 *
 * The stock helper reads everything from one interactive stdin, which cannot be
 * driven across separate tool calls. This one keeps the auth state on disk so
 * the flow can be split: request a code now, submit the code (and 2FA) later.
 *
 *   node --experimental-strip-types scripts/telegram-login-step.ts <step> [arg]
 *
 *   step = send        → asks Telegram to send the login code
 *   step = code <c>    → submits the code
 *   step = password <p>→ submits the 2FA password, prints the session
 *
 * Session/auth state lives in /tmp/tglogin (mode 600) and is deleted at the end.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

const STATE_DIR = process.env.TG_LOGIN_DIR || '/tmp/tglogin'
const STATE_FILE = path.join(STATE_DIR, 'state.json')

const API_ID = Number(process.env.TELEGRAM_API_ID || 0)
const API_HASH = process.env.TELEGRAM_API_HASH || ''
const PHONE = process.env.TELEGRAM_PHONE || ''

type SavedState = {
  session: string
  phone: string
  phoneCodeHash?: string
}

async function load(): Promise<SavedState | undefined> {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, 'utf8')) as SavedState
  } catch {
    return undefined
  }
}

async function save(state: SavedState): Promise<void> {
  await fs.mkdir(STATE_DIR, {recursive: true, mode: 0o700})
  await fs.writeFile(STATE_FILE, JSON.stringify(state), {mode: 0o600})
}

/** Telegram wants the password to stay in memory only; never print it. */
async function main(): Promise<void> {
  const [step, arg] = process.argv.slice(2)
  const {TelegramClient} = await import('teleproto')
  const {StringSession} = await import('teleproto/sessions')
  const {Api} = await import('teleproto')

  if (!API_ID || !API_HASH) {
    console.error('TELEGRAM_API_ID / TELEGRAM_API_HASH missing')
    process.exit(1)
  }

  const previous = await load()
  const client = new TelegramClient(new StringSession(previous?.session ?? ''), API_ID, API_HASH, {
    connectionRetries: 3,
  })
  await client.connect()

  try {
    if (step === 'send') {
      if (!PHONE) {
        console.error('TELEGRAM_PHONE missing')
        process.exit(1)
      }
      const result = await client.invoke(
        new Api.auth.SendCode({
          phoneNumber: PHONE,
          apiId: API_ID,
          apiHash: API_HASH,
          settings: new Api.CodeSettings({}),
        }),
      )
      // A code can arrive via another logged-in app instead of SMS.
      await save({
        session: client.session.save() as unknown as string,
        phone: PHONE,
        phoneCodeHash: result.phoneCodeHash,
      })
      console.log(`code requested for ${PHONE} (type: ${result.phoneCodeHash ? 'sent' : 'unknown'})`)
      return
    }

    if (step === 'resend-sms') {
      if (!previous?.phoneCodeHash) throw new Error('run "send" first')
      await client.invoke(
        new Api.auth.ResendCode({phoneNumber: previous.phone, phoneCodeHash: previous.phoneCodeHash}),
      )
      console.log('code resend requested (SMS)')
      return
    }

    if (step === 'code') {
      if (!previous?.phoneCodeHash) throw new Error('run "send" first')
      if (!arg) throw new Error('missing code')
      try {
        await client.invoke(
          new Api.auth.SignIn({
            phoneNumber: previous.phone,
            phoneCodeHash: previous.phoneCodeHash,
            phoneCode: arg,
          }),
        )
        await save({...previous, session: client.session.save() as unknown as string})
        console.log('signed in')
      } catch (error) {
        // SESSION_PASSWORD_NEEDED means the account has 2FA enabled.
        const text = String(error)
        if (text.includes('SESSION_PASSWORD_NEEDED')) {
          await save({...previous, session: client.session.save() as unknown as string})
          console.log('2FA password required')
          return
        }
        throw error
      }
      await printSession(client, previous)
      return
    }

    if (step === 'password') {
      if (!arg) throw new Error('missing password')
      // Signature: signInWithPassword(apiCredentials, authParams). A wrong
      // password must stop the flow rather than loop, since there is no stdin
      // to retype it in this step.
      await client.signInWithPassword(
        {apiId: API_ID, apiHash: API_HASH},
        {password: async () => arg, onError: async () => false},
      )
      await save({...previous, session: client.session.save() as unknown as string})
      console.log('signed in with 2FA')
      await printSession(client, previous)
      return
    }

    console.error('usage: <send|resend-sms|code <code>|password <pw>>')
    process.exit(1)
  } finally {
    await client.disconnect().catch(() => {})
  }
}

async function printSession(client: {session: {save(): unknown}}, _previous: SavedState | undefined) {
  const session = client.session.save() as unknown as string
  // The session is a full login to the account: written for the operator to
  // paste into the server .env, and never logged anywhere else.
  const out = path.join(STATE_DIR, 'session.txt')
  await fs.writeFile(out, `TELEGRAM_USER_SESSION=${session}\n`, {mode: 0o600})
  console.log(`session written to ${out} (${session.length} chars)`)
}

await main()

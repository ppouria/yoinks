/**
 * One-time interactive login for the large-file uploader.
 *
 *   TELEGRAM_API_ID=... TELEGRAM_API_HASH=... npm run telegram:login
 *
 * Prints a session string to put in TELEGRAM_USER_SESSION. That string is a
 * full login to the account — treat it like a password, and never commit it.
 */
import {interactiveLogin} from '../src/web/large-file.ts'

await interactiveLogin()

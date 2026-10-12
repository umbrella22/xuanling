// Only the explicitly authorized DSH child loads this module. The collector
// passes a locator, never opens the credential or inherits ambient credentials.
import { readFileSync, lstatSync } from 'node:fs'
import { isAbsolute } from 'node:path'

if (process.env.BP_CONVERSATION_CREDENTIAL_CHILD === '1') {
  const path = process.env.BP_CONVERSATION_KEY_FILE
  try {
    if (!isAbsolute(path ?? '') || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error()
    const key = readFileSync(path, 'utf8').trim()
    if (!key || key.includes('\r') || key.includes('\n') || key.includes('\0') || /^(?:placeholder|synthetic|fake[-_]|test[-_])/i.test(key)) throw new Error()
    process.env.BP_LIVE_PROVIDER_KEY = key
    delete process.env.BP_CONVERSATION_KEY_FILE
    delete process.env.BP_CONVERSATION_CREDENTIAL_CHILD
  } catch {
    // No raw error, credential bytes, stack or OS message crosses this boundary.
    process.stderr.write('PROVIDER_CREDENTIAL_FILE_INVALID\n')
    process.exit(1)
  }
}

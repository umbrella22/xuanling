import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { transformWithOxc } from 'vite'

/** Only JSX-bearing TypeScript needs a transform. Native Node handles .ts. */
export async function load(url, context, nextLoad) {
  if (!url.startsWith('file:') || !new URL(url).pathname.endsWith('.tsx')) return nextLoad(url, context)
  const filename = fileURLToPath(url)
  const transformed = await transformWithOxc(await readFile(filename, 'utf8'), filename, {
    lang: 'tsx',
    jsx: { runtime: 'automatic' }
  })
  return { format: 'module', source: transformed.code, shortCircuit: true }
}

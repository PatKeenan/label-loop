import { describe, expect, test } from 'bun:test'
import { relative, resolve } from 'node:path'
import { Glob } from 'bun'

/**
 * Architectural rules that are enforced rather than remembered (ADR-0016).
 *
 * The rule under test is CONVENTIONS.md's "no fetch to a provider anywhere else in the
 * codebase, ever" — the one most likely to erode under M7's multi-provider routing, when
 * one shortcut around the gateway will look harmless and will quietly cost the codebase
 * its timeout, its retry budget, its breaker and its cost accounting all at once.
 *
 * It is a test rather than a lint rule because the rule is about the shape of the
 * repository, not the shape of a file, and because a failure should read as a sentence
 * explaining what was broken and why.
 */

const REPO_ROOT = resolve(import.meta.dir, '../../..')

/** The one directory allowed to reach a provider. Everything below is measured against it. */
const GATEWAY = 'apps/api/src/llm/'

type SourceFile = { path: string; source: string }

const sourceFiles = async (): Promise<SourceFile[]> => {
  const glob = new Glob('{apps,packages}/*/src/**/*.{ts,tsx}')
  const files: SourceFile[] = []
  for await (const path of glob.scan({ cwd: REPO_ROOT, absolute: true })) {
    if (path.includes('node_modules')) continue
    files.push({ path: relative(REPO_ROOT, path), source: await Bun.file(path).text() })
  }
  return files
}

const FILES = await sourceFiles()

const outsideTheGateway = (): SourceFile[] => FILES.filter((file) => !file.path.startsWith(GATEWAY))

/** Where the offending text appears, formatted so a failure names the file and the line. */
const offences = (files: SourceFile[], pattern: RegExp): string[] =>
  files.flatMap((file) =>
    file.source
      .split('\n')
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => pattern.test(line))
      .map(({ line, number }) => `${file.path}:${number} — ${line.trim()}`),
  )

describe('only src/llm may reach a model provider (ADR-0016)', () => {
  test('the scan actually found the codebase — a rule over zero files proves nothing', () => {
    expect(FILES.length).toBeGreaterThan(20)
    expect(FILES.some((file) => file.path.startsWith(GATEWAY))).toBe(true)
  })

  test('no provider SDK is imported outside the gateway', () => {
    // Matched by name rather than by an allow-list of packages we happen to have
    // installed, so a provider added at M1 or M7 is caught the day it arrives.
    const providerPackage =
      /from\s+['"](?:@?[\w./-]*)(anthropic|openai|gemini|generative-ai|bedrock-runtime|mistral|cohere|groq|ollama|replicate|together)/i
    expect(offences(outsideTheGateway(), providerPackage)).toEqual([])
  })

  test('no provider hostname appears outside the gateway', () => {
    // The obvious way around an import ban is a hand-rolled HTTP call, so the hosts are
    // banned as well as the SDKs.
    const providerHost =
      /api\.(?:anthropic|openai|mistral|cohere|groq|together|deepseek)\.(?:com|ai)|generativelanguage\.googleapis\.com|bedrock-runtime\.[\w-]+\.amazonaws\.com/i
    expect(offences(outsideTheGateway(), providerHost)).toEqual([])
  })

  test('apps/api makes no outbound HTTP call outside the gateway', () => {
    // Narrower than the two rules above, and deliberately so. `apps/web` exists to talk
    // to an HTTP API and `apps/api`'s own tests call their own server over the loopback,
    // so a blanket ban would be noise. What is left — the API's production code — has no
    // business calling anything but its database and its provider, and only one directory
    // may do the second.
    const apiProductionCode = outsideTheGateway().filter(
      (file) => file.path.startsWith('apps/api/src/') && !file.path.endsWith('.test.ts'),
    )
    expect(offences(apiProductionCode, /(?<![.\w])fetch\s*\(/)).toEqual([])
  })
})

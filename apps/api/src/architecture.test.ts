import { describe, expect, test } from 'bun:test'
import { relative, resolve } from 'node:path'
import { Glob } from 'bun'

/**
 * Architectural rules that are enforced rather than remembered (ADR-0016).
 *
 * The first rule is CONVENTIONS.md's "no fetch to a provider anywhere else in the
 * codebase, ever" — the one most likely to erode under M7's multi-provider routing, when
 * one shortcut around the gateway will look harmless and will quietly cost the codebase
 * its timeout, its retry budget, its breaker and its cost accounting all at once.
 *
 * The second is ADR-0007's ban on OpenTelemetry auto-instrumentation, added at P6 for the
 * same reason: it erodes by ACCRETION rather than by decision. Nobody argues for it; a
 * package gets added because it makes one thing easier, and the codebase quietly stops
 * being one where every span was chosen.
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
    //
    // `(?!\.)` restricts this to BARE specifiers — third-party packages. A relative import
    // of our own adapter is not what this rule is about: `server.ts` is the composition
    // root and its whole job is to wire `./llm/openrouter-provider.ts` in. Without the
    // guard the rule fires on the one file that is supposed to do that, which would teach
    // everyone to weaken the rule rather than to keep it.
    const providerPackage =
      /from\s+['"](?!\.)(?:@?[\w./-]*)(anthropic|openai|openrouter|gemini|generative-ai|bedrock-runtime|mistral|cohere|groq|ollama|replicate|together)/i
    expect(offences(outsideTheGateway(), providerPackage)).toEqual([])
  })

  test('no provider hostname appears outside the gateway', () => {
    // The obvious way around an import ban is a hand-rolled HTTP call, so the hosts are
    // banned as well as the SDKs.
    // `openrouter\.ai` joins the list at M1 (ADR-0021). Written escaped, exactly like
    // every entry beside it, so the rule does not match its own source and fail here.
    const providerHost =
      /api\.(?:anthropic|openai|mistral|cohere|groq|together|deepseek)\.(?:com|ai)|generativelanguage\.googleapis\.com|bedrock-runtime\.[\w-]+\.amazonaws\.com|openrouter\.ai/i
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

describe('no OpenTelemetry auto-instrumentation, anywhere (ADR-0007)', () => {
  test('no auto-instrumentation package is imported', () => {
    // The whole `@opentelemetry/instrumentation*` family, plus the two meta-packages that
    // pull it in transitively and the module-patching machinery underneath it. Matched by
    // shape rather than by an allow-list of packages that exist today, so the one added in
    // two years is caught as well.
    const autoInstrumentation =
      /from\s+['"](?:@opentelemetry\/(?:instrumentation|auto-instrumentations)[\w-]*|@opentelemetry\/sdk-node|import-in-the-middle|require-in-the-middle)/i
    expect(offences(FILES, autoInstrumentation)).toEqual([])
  })

  test('no package.json declares one either', async () => {
    // The import scan is necessary and not sufficient: a package that patches modules on
    // load does its damage by being installed and preloaded, without any file importing it.
    const manifests = new Glob('{apps,packages}/*/package.json')
    const offending: string[] = []
    for await (const path of manifests.scan({ cwd: REPO_ROOT, absolute: true })) {
      const manifest = (await Bun.file(path).json()) as {
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
      }
      const named = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
      offending.push(
        ...named
          .filter(
            (name) =>
              name.startsWith('@opentelemetry/instrumentation') ||
              name.startsWith('@opentelemetry/auto-instrumentations') ||
              name === '@opentelemetry/sdk-node',
          )
          .map((name) => `${relative(REPO_ROOT, path)} — ${name}`),
      )
    }
    expect(offending).toEqual([])
  })
})

/**
 * TWO SURFACES, AND THEY DO NOT BORROW FROM EACH OTHER (PRODUCT.md 5.5, CLAUDE.md).
 *
 * The annotator surface is the minimal, friendly, light one, for a non-engineer answering one
 * question at a time. Everything staff-facing is the engineer console: dark, dense, inside
 * `ConsoleShell`, under `data-surface="console"`. They share `tokens.css` at different settings
 * — the same tokens, never a second design system — and nothing else.
 *
 * **This is a test because a paragraph did not hold.** M5 phase 5 broke the rule by accident and
 * nothing in the code said not to: a console screen linked into the annotator surface, and met
 * in a running console it read as an ambush (ADR-0084). The rule is now the kind of thing CI
 * refuses rather than the kind a reviewer has to notice.
 *
 * `components/shaped/` is shared ON PURPOSE and belongs to neither side: it is the ONE renderer
 * for a trace (ADR-0078), and two renderings of one trace would be two accounts of what was
 * judged. `components/shell/` is the console's, `components/annotate/` is the annotator's, and
 * those two are what may not cross.
 */
const CONSOLE_ROUTES = [
  'apps/web/src/routes/annotations.tsx',
  'apps/web/src/routes/annotation-set.tsx',
  'apps/web/src/routes/traces.tsx',
  'apps/web/src/routes/trace.tsx',
  'apps/web/src/routes/panel.tsx',
  'apps/web/src/routes/keys.tsx',
  'apps/web/src/routes/members.tsx',
  'apps/web/src/routes/home.tsx',
]

const ANNOTATOR_FILES = [
  'apps/web/src/routes/annotate.tsx',
  'apps/web/src/routes/annotate-session.tsx',
]

const fileAt = (path: string): SourceFile => {
  const file = FILES.find((candidate) => candidate.path === path)
  if (file === undefined) {
    throw new Error(`${path} is not in the scan — rename it here as well, or the rule is silent.`)
  }
  return file
}

describe('the two surfaces do not borrow from each other (PRODUCT 5.5, ADR-0084)', () => {
  test('every file the rule names still exists — a rule over a moved file proves nothing', () => {
    for (const path of [...CONSOLE_ROUTES, ...ANNOTATOR_FILES]) expect(fileAt(path).path).toBe(path)
  })

  test('no CONSOLE route imports an annotator component', () => {
    const found = offences(CONSOLE_ROUTES.map(fileAt), /from '.*components\/annotate\//)
    expect(found).toEqual([])
  })

  test('no ANNOTATOR screen imports a console component', () => {
    // `components/shell/` is the console's frame, its sidebar, its tables and its dialogs. The
    // annotator surface has its own frame and shares only the account menu and the surface
    // hook, which live there for a reason that is recorded and is the exception, not the rule.
    const SHARED_FROM_SHELL = /components\/shell\/(account-menu|surface|context|menu-focus)/
    const found = offences(ANNOTATOR_FILES.map(fileAt), /from '.*components\/shell\//).filter(
      (offence) => !SHARED_FROM_SHELL.test(offence),
    )
    expect(found).toEqual([])
  })

  test('no console route links INTO the annotator surface except one assigned set', () => {
    /**
     * ADR-0084: staff are never ROUTED to the annotator surface. The one route that remains is
     * a person picking up work assigned to them — their own set, chosen — which is the opposite
     * of the ambush phase 5 shipped, and it lives on the set page behind `assignedToMe`.
     */
    const others = CONSOLE_ROUTES.filter(
      (path) => path !== 'apps/web/src/routes/annotation-set.tsx',
    )
    expect(offences(others.map(fileAt), /to="\/annotate/)).toEqual([])
    expect(offences(others.map(fileAt), /to: '\/annotate/)).toEqual([])

    // And on the one page that has it, it is guarded rather than unconditional.
    expect(fileAt('apps/web/src/routes/annotation-set.tsx').source).toContain('assignedToMe')
  })
})

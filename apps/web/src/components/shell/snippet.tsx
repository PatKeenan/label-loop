import { useState } from 'react'
import { API_URL } from '../../api/client.ts'
import { Button } from '../ui/button.tsx'
import { Data, Eyebrow, Mark } from './mark.tsx'

/**
 * THE STARTER CODE (6c decisions 7 and 8) — curl, Node and Python, with the key in them.
 *
 * **Written against the contract, and re-checked against the version this phase shipped.**
 * The approved mockup's snippet was written before ADR-0060 landed and told the caller to
 * read `data.passed`. That is now wrong for a new panel: `passed` is NULL while a panel is
 * collecting, and a gate reading it as a boolean would treat null as false and block
 * everything. Every snippet here reads `state` FIRST and says why in a comment — which is
 * the same property the mockup was protecting, applied to the contract as it now is.
 *
 * **The same call works unchanged once judges exist.** Only what comes back changes. That is
 * deliberate: nothing about integrating has to be redone when a panel leaves collecting.
 *
 * **The key is masked on screen and real on the clipboard** (6c decision 7). It exists
 * exactly once — LabelLoop stores only a hash — so this screen IS the reveal, rather than a
 * modal that can be dismissed with the key uncopied.
 */

const LANGUAGES = ['curl', 'node', 'python'] as const
type Language = (typeof LANGUAGES)[number]

const maskKey = (key: string) => {
  const last4 = key.slice(-4)
  // The prefix is a fact about where the key was minted, not a secret, so it stays legible.
  const prefix = key.startsWith('llk_live_') ? 'llk_live_' : 'llk_test_'
  return `${prefix}${'•'.repeat(48)}${last4}`
}

const snippetFor = (language: Language, panelId: string, key: string): string => {
  const url = `${API_URL}/v1/panels/${panelId}/evaluate`
  if (language === 'curl') {
    return `curl -X POST ${url} \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -d '{
    "artifact": "what your agent produced, or decided about",
    "context": { "your_agent_decision": "p2" }
  }'`
  }
  if (language === 'node') {
    return `const res = await fetch("${url}", {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${process.env.LABELLOOP_KEY}\`,
    "Content-Type": "application/json",
    // Optional. Safe to retry the same call without judging twice.
    "Idempotency-Key": crypto.randomUUID(),
  },
  body: JSON.stringify({
    // What your agent PRODUCED — a draft, an image, a reply.
    artifact: draft,
    // What a judge needs to decide, INCLUDING your agent's own decision.
    context: { your_agent_decision: "p2" },
  }),
})

const { data } = await res.json()

// Check the STATE first. A new panel has no judges yet, so \`passed\` is null
// until you have authored some — treat collecting as a pass while you integrate.
if (data.state === "collecting") {
  // Nothing was judged. The trace is stored, and counts toward annotation.
} else if (data.passed === false) {
  // A gate would stop here. \`data.judges\` says which judge failed and why.
}

// \`complete: false\` means a judge did not run, so \`score\` is real but partial.
// \`data.trace_id\` is the record an expert annotates later.`
  }
  return `import os, uuid, requests

res = requests.post(
    "${url}",
    headers={
        "Authorization": f"Bearer {os.environ['LABELLOOP_KEY']}",
        "Content-Type": "application/json",
        # Optional. Safe to retry the same call without judging twice.
        "Idempotency-Key": str(uuid.uuid4()),
    },
    json={
        # What your agent PRODUCED — a draft, an image, a reply.
        "artifact": draft,
        # What a judge needs to decide, INCLUDING your agent's own decision.
        "context": {"your_agent_decision": "p2"},
    },
)

data = res.json()["data"]

# Check the STATE first. A new panel has no judges yet, so \`passed\` is None
# until you have authored some — treat collecting as a pass while you integrate.
if data["state"] == "collecting":
    pass  # Nothing was judged. The trace is stored, and counts toward annotation.
elif data["passed"] is False:
    pass  # A gate would stop here. data["judges"] says which judge failed and why.

# complete=False means a judge did not run, so score is real but partial.
# data["trace_id"] is the record an expert annotates later.`
}

/**
 * `first-call` is the Overview's onboarding, before any trace exists. `reference` is the same
 * code as a standing reference on Keys, once traffic has arrived and "first" is no longer true
 * — the snippet moves there rather than vanishing, because a key and an endpoint are exactly
 * what someone on the Keys screen is holding.
 */
export type SnippetVariant = 'first-call' | 'reference'

export const Snippet = ({
  panelId,
  apiKey,
  variant,
}: {
  panelId: string
  apiKey: string | null
  variant: SnippetVariant
}) => {
  const [language, setLanguage] = useState<Language>('curl')
  const [revealed, setRevealed] = useState(false)
  const [copied, setCopied] = useState<'key' | 'code' | null>(null)

  /**
   * TWO renderings of the same snippet, and the difference is the point.
   *
   * What is DRAWN carries the masked key; what is COPIED carries the real one. The first
   * draft used the real key for both, which put a live credential in a code block on screen
   * while the key row two lines above it was carefully masked — masking one and not the
   * other protects nothing. Caught by looking at the running screen, not by a test.
   *
   * `Reveal` shows it in both, because at that point the person has asked.
   */
  const shown = apiKey === null ? 'YOUR_KEY' : revealed ? apiKey : maskKey(apiKey)
  const code = snippetFor(language, panelId, shown)
  const copyable = snippetFor(language, panelId, apiKey ?? 'YOUR_KEY')

  const copy = async (what: 'key' | 'code', value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(what)
    } catch {
      // Clipboard access can be refused (permissions, an insecure origin). The key is
      // selectable on screen, so there is a way through — saying nothing would be worse
      // than a button that visibly did nothing.
      setCopied(null)
    }
  }

  return (
    <section className="flex flex-col gap-[var(--gap-stack)] rounded-lg border bg-card px-[var(--pad-panel-x)] py-[var(--pad-panel-y)]">
      <div className="flex flex-col gap-[var(--gap-tight)]">
        <h2 className="m-0 text-title font-semibold tracking-[var(--tracking-snug)]">
          {variant === 'first-call' ? 'Send your first call' : 'Call this panel'}
        </h2>
        {/*
          The one thing an integrator must know while a panel collects, moved here from the
          gate card: it is about the RESPONSE this code receives, so it belongs beside the code.
        */}
        <p className="m-0 text-body text-muted-foreground">
          While the panel collects, responses carry{' '}
          <Data className="text-foreground">state: "collecting"</Data> and no verdict — treat that
          as a pass.
        </p>
      </div>

      {apiKey === null ? (
        <p className="m-0 text-body text-muted-foreground">
          {variant === 'first-call'
            ? 'This panel’s key was shown once, when it was created, and can’t be shown again. '
            : 'A key is shown only when it’s issued, so the snippet uses YOUR_KEY. '}
          <strong>Issue a key{variant === 'first-call' ? ' from Keys' : ' above'}</strong> and the
          snippet fills in with it for as long as this tab is open.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-[var(--gap-inline)]">
            <Eyebrow>Key</Eyebrow>
            <Data className="min-w-0 flex-1 truncate text-foreground select-all">
              {revealed ? apiKey : maskKey(apiKey)}
            </Data>
            <Button variant="outline" size="sm" onClick={() => setRevealed((on) => !on)}>
              {revealed ? 'Hide' : 'Reveal'}
            </Button>
            <Button variant="outline" size="sm" onClick={() => void copy('key', apiKey)}>
              {copied === 'key' ? 'Copied' : 'Copy key'}
            </Button>
          </div>
          <div className="flex items-start gap-[var(--gap-inline)] rounded-md border border-warning-line bg-warning-tint px-[var(--pad-field-x)] py-[var(--pad-field-y)]">
            <Mark tone="warning">shown once</Mark>
            <p className="m-0 text-body">
              LabelLoop stores only a hash. Once this tab closes the full key can’t be shown again —
              if it’s lost, revoke it and issue another.
            </p>
          </div>
        </>
      )}

      <div className="flex flex-wrap items-center gap-[var(--gap-tight)]">
        {LANGUAGES.map((option) => (
          <Button
            key={option}
            size="sm"
            variant={option === language ? 'default' : 'outline'}
            onClick={() => setLanguage(option)}
          >
            {option}
          </Button>
        ))}
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          onClick={() => void copy('code', copyable)}
        >
          {copied === 'code' ? 'Copied' : 'Copy snippet'}
        </Button>
      </div>

      <pre className="overflow-x-auto rounded-md border bg-muted px-[var(--pad-field-x)] py-[var(--pad-field-y)] font-mono text-data leading-[var(--leading-snug)]">
        <code>{code}</code>
      </pre>
    </section>
  )
}

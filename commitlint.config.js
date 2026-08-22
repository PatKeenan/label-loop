/**
 * Conventional commits (CONVENTIONS.md "Quality gates"); the input release-please
 * consumes to derive versions and the CHANGELOG (ADR-0011).
 */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Scopes are free-form but must be lower-case when present.
    'scope-case': [2, 'always', 'lower-case'],
    // Relaxed from config-conventional, which also bans sentence-case. Dependabot
    // writes "ci: Bump x from 1 to 2" and reasserts that title on every rebase, so a
    // leading capital cannot be legislated away — and casing cannot cause a wrong
    // version bump, which is the whole reason ADR-0011 enforces commit messages.
    // Start-case, pascal-case and upper-case stay banned: "CI: FIX THE THING" is still
    // a lint error.
    'subject-case': [2, 'never', ['start-case', 'pascal-case', 'upper-case']],
    // Long bodies are welcome; only the subject line is constrained.
    'body-max-line-length': [0, 'always'],
    'footer-max-line-length': [0, 'always'],
    'header-max-length': [2, 'always', 100],
  },
}

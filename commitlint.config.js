/**
 * Conventional commits (CONVENTIONS.md "Quality gates"); the input release-please
 * consumes to derive versions and the CHANGELOG (ADR-0011).
 */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Scopes are free-form but must be lower-case when present.
    'scope-case': [2, 'always', 'lower-case'],
    // Long bodies are welcome; only the subject line is constrained.
    'body-max-line-length': [0, 'always'],
    'footer-max-line-length': [0, 'always'],
    'header-max-length': [2, 'always', 100],
  },
}

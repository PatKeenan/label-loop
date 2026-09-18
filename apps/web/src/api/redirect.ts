/**
 * Where to send someone after they sign in — and the check that keeps `?redirect=` from
 * being an open redirect.
 *
 * The target arrives in the URL, and the URL is something anyone can write: a link to
 * `/login?redirect=https://labelloop.example.evil` that bounced a freshly signed-in person
 * to another site would be a phishing kit with our domain on the front of it. So the only
 * thing accepted is a PATH on this origin — it must start with `/`, and must not start with
 * `//` or `/\`, which browsers read as protocol-relative URLs to another host. Anything else
 * is treated as absent, and absent means Home.
 *
 * It is checked where it is READ (the login route's `validateSearch`), not where it is
 * written, because the console is not the only thing that can write a URL.
 */
export const safeRedirect = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  if (!value.startsWith('/')) return undefined
  if (value.startsWith('//') || value.startsWith('/\\')) return undefined
  // `/login` sending you back to `/login` is a loop with a sign-in form in the middle of it.
  if (value === '/login' || value.startsWith('/login?') || value.startsWith('/login#')) {
    return undefined
  }
  return value
}

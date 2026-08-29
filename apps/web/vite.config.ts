import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * The console's build. Deliberately close to Vite's defaults: at M0 this app exists to
 * prove that a real session and a typed RPC call work end to end, and a build with
 * opinions in it would be one more thing between the proof and the reader.
 */
export default defineConfig({
  plugins: [react()],
  // There is ONE .env in this repo, at the root, and this is what keeps that true for the
  // console too — Vite would otherwise look in `apps/web` and find nothing, silently
  // falling back to the default API URL. Only `VITE_`-prefixed variables are exposed to
  // the bundle, so pointing it at the root file does not leak DATABASE_URL into a browser.
  //
  // ONE VARIABLE ESCAPES THAT RULE, and it cost a 50% larger bundle to find: Vite reads
  // `NODE_ENV` out of an env file regardless of prefix, and uses it to pick package export
  // conditions. A root `.env` saying `NODE_ENV=development` therefore resolved React's
  // DEVELOPMENT build into a production bundle — 663 kB of dev-only warnings where the real
  // thing is 433 kB. Silently, and invisibly to CI, which has no `.env` and so built the
  // correct artifact while every local build was wrong.
  //
  // Two things stop it, deliberately independent. `.env.example` no longer sets NODE_ENV at
  // all (`config.ts` defaults it, so the API never needed the line), and `package.json` sets
  // `NODE_ENV=production` on the build script, which wins over the file if one reappears.
  envDir: '../..',
  server: {
    // Stated rather than left to Vite's default, because it is not only this app's
    // business: the API's WEB_ORIGIN and better-auth's trusted origin both name this port,
    // and `strictPort` turns "something else already has 5173" into a failure to start
    // rather than a silent move to 5174 and an unexplained CORS rejection.
    port: 5173,
    strictPort: true,
  },
})

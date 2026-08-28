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

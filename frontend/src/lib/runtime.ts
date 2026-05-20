/**
 * Runtime-environment helpers.
 *
 * pywebview/WebView2 injects `window.pywebview` once the JS-Python bridge is
 * ready, so its presence is a reliable signal that the frontend is hosted
 * inside the desktop shell rather than served to a browser via `npm run dev`
 * or a static build. The bridge can land a beat after page load — gate any
 * pywebview-only UI on user-initiated actions rather than mount-time logic.
 */
export function isPywebview(): boolean {
  return typeof window !== 'undefined' && 'pywebview' in window
}

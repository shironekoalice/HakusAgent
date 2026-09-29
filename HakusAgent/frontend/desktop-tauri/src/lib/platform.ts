/**
 * Platform detection shared across the app shell.
 *
 * `IS_ANDROID` covers the real APK (Tauri on an Android WebView). The
 * `?platform=android` query flag lets a desktop browser preview exercise the
 * exact same Android-only UI paths without a device — same idea as
 * `?backend=rust` for the embedded runtime.
 */
export const IS_ANDROID_UA = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)

export const IS_ANDROID_PREVIEW = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).get('platform')?.toLowerCase() === 'android'

export const IS_ANDROID = IS_ANDROID_UA || IS_ANDROID_PREVIEW

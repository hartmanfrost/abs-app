/**
 * Persisted reader preferences shared by the Book and Transcript views: the font size table (with a migration of the
 * old index-based storage) and the boolean toggles (night mode, smooth scrolling).
 *
 * `storage` is a Storage-like object ({getItem, setItem}); every access is wrapped because localStorage can be
 * unavailable (private mode, WebView policies) - a preference that cannot be read or written simply is not remembered.
 */

// Many small steps on the low side: the 10-foot UI of a TV needs far smaller text than a phone at the lower end
export const FONT_SCALES = [0.4, 0.48, 0.56, 0.64, 0.72, 0.8, 0.9, 1, 1.25, 1.5, 1.8]
export const DEFAULT_FONT_LEVEL = FONT_SCALES.indexOf(1)
// Table used until versionCode 120: the stored value was an index into it
const LEGACY_FONT_SCALES = [0.8, 1, 1.25, 1.5, 1.8]

export const NIGHT_KEY = 'absReaderNight'
export const SMOOTH_KEY = 'absBookSmoothScroll'
export const SWAP_KEY = 'absBookPanesSwapped'

/** Index of the step closest to `scale` (ties go to the smaller step). */
export function nearestFontLevel(scale) {
  let best = DEFAULT_FONT_LEVEL
  let bestD = Infinity
  FONT_SCALES.forEach((s, i) => {
    const d = Math.abs(s - scale)
    if (d < bestD - 1e-9) {
      bestD = d
      best = i
    }
  })
  return best
}

const read = (storage, key) => {
  try {
    return storage ? storage.getItem(key) : null
  } catch (e) {
    return null
  }
}
const write = (storage, key, value) => {
  try {
    if (storage) storage.setItem(key, value)
  } catch (e) {
    // not remembered
  }
}

/**
 * Stored font level. `key` holds the scale itself; `legacyKey` (optional) is the old index-based key, used once
 * when the new key is absent.
 */
export function loadFontLevel(storage, key, legacyKey) {
  const scale = parseFloat(read(storage, key))
  if (scale > 0) return nearestFontLevel(scale)
  if (legacyKey) {
    const idx = parseInt(read(storage, legacyKey), 10)
    if (idx >= 0 && idx < LEGACY_FONT_SCALES.length) return nearestFontLevel(LEGACY_FONT_SCALES[idx])
  }
  return DEFAULT_FONT_LEVEL
}

export function saveFontLevel(storage, key, level) {
  write(storage, key, String(FONT_SCALES[Math.min(FONT_SCALES.length - 1, Math.max(0, level))]))
}

export function loadFlag(storage, key, def = false) {
  const v = read(storage, key)
  return v === '1' ? true : v === '0' ? false : def
}

export function saveFlag(storage, key, value) {
  write(storage, key, value ? '1' : '0')
}

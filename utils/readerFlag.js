/**
 * Tracks open reader screens (transcript / book) in the store's `transcriptOpen` flag.
 *
 * The flag stays up briefly after the last screen closes: a hardware Back press can deliver both a DOM key event
 * and the native backButton event, and the second one must not fall through to the player. With a counter the
 * delayed reset cannot clobber a screen that was opened in between (switching modes unmounts one reader and
 * mounts the other within the same tick).
 */
let open = 0

export function enterReader(store) {
  open++
  store.commit('setTranscriptOpen', true)
}

export function leaveReader(store) {
  setTimeout(() => {
    open = Math.max(0, open - 1)
    if (open === 0) store.commit('setTranscriptOpen', false)
  }, 400)
}

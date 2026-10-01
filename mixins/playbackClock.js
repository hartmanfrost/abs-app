/**
 * Playback clock shared by the transcript and book readers.
 *
 * The player reports its position about once a second; to move a highlight smoothly the readers interpolate
 * between those updates with a non-reactive anchor. Requires the props `currentTime`, `isPlaying`, `playbackRate`.
 */

// After a seek, ignore player position updates that still report the old position
export const SEEK_HOLD_MS = 1500

export default {
  watch: {
    currentTime(val) {
      this.syncClock(val)
    },
    isPlaying(playing) {
      // Re-anchor so pausing/resuming does not jump: on pause freeze at the interpolated position
      if (!playing) this.anchorT = this.interpolate()
      this.anchorAt = performance.now()
    }
  },
  created() {
    this.anchorT = this.currentTime
    this.anchorAt = performance.now()
    this.seekHoldUntil = 0
    this.seekTarget = 0
  },
  methods: {
    syncClock(val) {
      const now = performance.now()
      // Right after a seek the player may still report the old position or a position a little before the
      // target (position updates are ~1 Hz); taking it would flash the previous sentence, so ignore those
      if (now < this.seekHoldUntil && (val < this.seekTarget - 0.05 || Math.abs(val - this.seekTarget) > 2)) return
      this.anchorT = val
      this.anchorAt = now
    },
    interpolate() {
      return this.anchorT + ((performance.now() - this.anchorAt) / 1000) * (this.playbackRate || 1)
    },
    estimateTime() {
      return this.isPlaying ? this.interpolate() : this.anchorT
    },
    // Called right before emitting a seek so the old position is not taken back
    markSeek(t) {
      this.anchorT = t
      this.anchorAt = performance.now()
      this.seekTarget = t
      this.seekHoldUntil = performance.now() + SEEK_HOLD_MS
    }
  }
}

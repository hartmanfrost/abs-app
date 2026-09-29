<template>
  <div ref="root" class="transcript-view absolute top-0 left-0 w-full h-full z-40 pointer-events-auto flex flex-col" :style="{ '--tr-bg': coverColor }" role="dialog" :aria-label="$strings.LabelTranscript" tabindex="-1" @wheel.prevent="onWheel" @touchstart.passive="onTouchStart" @touchmove.prevent="onTouchMove">
    <!-- Header: chapter title, position, controls -->
    <div class="tr-head flex items-center px-4 pt-3 pb-2">
      <div class="flex-1 min-w-0 pr-3">
        <p class="tr-chapter truncate">{{ headerChapter || $strings.LabelTranscript }}</p>
        <p class="tr-sub truncate">
          <span class="font-mono">{{ headerClock }}</span>
          <span v-if="!following" class="tr-pill">{{ $strings.LabelTranscriptFollow }}</span>
          <span v-if="searchOpen && query" class="ml-2">{{ matches.length ? `${matchPos + 1}/${matches.length}` : $strings.MessageTranscriptNoResults }}</span>
        </p>
      </div>
      <div class="flex items-center">
        <span v-for="(b, i) in headerButtons" :key="b.id" role="button" class="tr-btn material-symbols" :class="{ 'tr-focus': zone === 'header' && headerIdx === i, 'tr-btn-off': b.disabled }" :title="b.label" :aria-label="b.label" @click.stop="activateButton(i)">{{ b.icon }}</span>
      </div>
    </div>

    <div v-if="searchOpen" class="px-4 pb-2">
      <input ref="searchInput" v-model="query" type="search" class="tr-search" :placeholder="$strings.LabelTranscriptSearchPlaceholder" enterkeyhint="search" autocomplete="off" @input="scheduleSearch" @focus="searchFocused = true" @blur="searchFocused = false" @click.stop />
    </div>

    <!-- Body: windowed cue list, the centre cue is positioned with a transform (no scrolling container) -->
    <div ref="body" class="tr-body relative flex-1 overflow-hidden">
      <div v-if="status === 'loading'" class="absolute inset-0 flex flex-col items-center justify-center text-fg-muted">
        <widgets-spinner-icon class="h-10 w-10 mb-3" />
        <p>{{ $strings.MessageTranscriptLoading }} <span v-if="progress > 0 && progress < 1">{{ Math.round(progress * 100) }}%</span></p>
      </div>
      <div v-else-if="status === 'error'" class="absolute inset-0 flex items-center justify-center px-8 text-center text-fg-muted">
        <p>{{ $strings.MessageTranscriptFailed }}</p>
      </div>
      <div v-else ref="track" class="tr-track absolute left-0 right-0 top-0 px-6" :style="{ fontSize: fontPx + 'px' }">
        <p v-for="i in windowIndices" :key="i" :data-i="i" class="tr-cue" :class="cueClass(i)" @click.stop="onCueClick(i)">
          <template v-if="i === activeIdx && cues[i].words"
            ><span v-for="(w, wi) in cues[i].words" :key="wi" class="tr-word" :class="{ 'tr-word-done': wi < wordIdx, 'tr-word-now': wi === wordIdx }">{{ w.w }}</span></template
          >
          <template v-else>{{ cues[i].text }}</template>
        </p>
      </div>
    </div>

    <p v-if="isTv" class="tr-hint truncate px-4 py-1">{{ following ? $strings.MessageTranscriptHintFollow : $strings.MessageTranscriptHintBrowse }}</p>
  </div>
</template>

<script>
import { findCueIndex, findWordIndex, searchCues, formatClock } from '@/utils/transcript'
import { loadTranscript } from '@/utils/transcriptLoader'

const FONT_SCALES = [0.8, 1, 1.25, 1.5, 1.8]
const FONT_STORAGE_KEY = 'absTranscriptFontLevel'
const WINDOW_BEFORE = 30
const WINDOW_AFTER = 50
const WINDOW_MARGIN = 12
const JUMP_CUES = 10
// After a seek, ignore player position updates that still report the old position
const SEEK_HOLD_MS = 1500

export default {
  props: {
    libraryItemId: { type: String, required: true },
    // [{ ino, offset, signature }] from fetchTranscriptSources
    sources: { type: Array, required: true },
    currentTime: { type: Number, default: 0 },
    isPlaying: Boolean,
    playbackRate: { type: Number, default: 1 },
    chapters: { type: Array, default: () => [] },
    coverColor: { type: String, default: 'rgb(55, 56, 56)' }
  },
  data() {
    return {
      status: 'loading', // loading | ready | error
      progress: 0,
      cues: [],
      hasWords: false,
      zone: 'list', // list | header
      headerIdx: 0,
      following: true,
      activeIdx: -1,
      wordIdx: -1,
      selectedIdx: 0,
      winStart: 0,
      winEnd: 0,
      fontLevel: 1,
      viewportHeight: 0,
      searchOpen: false,
      searchFocused: false,
      query: '',
      matches: [],
      matchPos: -1
    }
  },
  computed: {
    isTv() {
      return !!this.$store.state.isAndroidTv
    },
    fontPx() {
      const h = this.viewportHeight || 600
      const base = this.isTv ? Math.max(18, Math.round(h * 0.04)) : Math.max(16, Math.min(22, Math.round(h * 0.028)))
      return Math.round(base * FONT_SCALES[this.fontLevel])
    },
    centerIdx() {
      if (this.following) return Math.max(this.activeIdx, 0)
      return this.selectedIdx
    },
    windowIndices() {
      const out = []
      for (let i = this.winStart; i < this.winEnd; i++) out.push(i)
      return out
    },
    matchSet() {
      return new Set(this.matches)
    },
    headerButtons() {
      return [
        { id: 'play', icon: this.isPlaying ? 'pause' : 'play_arrow', label: this.$strings.LabelTranscriptPlayPause, action: () => this.$emit('toggle-play') },
        { id: 'follow', icon: 'my_location', label: this.$strings.LabelTranscriptFollow, disabled: this.following, action: () => this.resumeFollow() },
        { id: 'smaller', icon: 'text_decrease', label: this.$strings.LabelTranscriptFontSmaller, disabled: this.fontLevel === 0, action: () => this.changeFont(-1) },
        { id: 'larger', icon: 'text_increase', label: this.$strings.LabelTranscriptFontLarger, disabled: this.fontLevel === FONT_SCALES.length - 1, action: () => this.changeFont(1) },
        { id: 'search', icon: 'search', label: this.$strings.LabelTranscriptSearch, action: () => this.toggleSearch() },
        { id: 'close', icon: 'close', label: this.$strings.ButtonClose, action: () => this.$emit('close') }
      ]
    },
    headerTime() {
      const cue = this.cues[this.centerIdx]
      return cue ? cue.start : this.currentTime
    },
    headerClock() {
      return formatClock(this.headerTime)
    },
    headerChapter() {
      const t = this.headerTime
      const ch = this.chapters.find((c) => Number(c.start) <= t && Number(c.end) > t)
      return ch ? ch.title : ''
    }
  },
  watch: {
    currentTime(val) {
      this.syncClock(val)
    },
    isPlaying(playing) {
      // Re-anchor so pausing/resuming does not jump: on pause freeze at the interpolated position
      if (!playing) this.anchorT = this.interpolate()
      this.anchorAt = performance.now()
    },
    centerIdx() {
      this.ensureWindow()
      this.$nextTick(() => this.applyTransform(true))
    },
    fontPx() {
      this.$nextTick(() => this.applyTransform(false))
    },
    viewportHeight() {
      this.$nextTick(() => this.applyTransform(false))
    }
  },
  created() {
    // Non-reactive playback clock (interpolated between the player's 1 Hz position updates)
    this.anchorT = this.currentTime
    this.anchorAt = performance.now()
    this.seekHoldUntil = 0
    this.seekTarget = 0
    this.rebased = true
    this.lastBackAt = 0
    this.searchTimer = null
    this.tickTimer = null
    this.touchY = null
    this.touchAcc = 0
    try {
      const stored = parseInt(window.localStorage.getItem(FONT_STORAGE_KEY), 10)
      if (stored >= 0 && stored < FONT_SCALES.length) this.fontLevel = stored
    } catch (e) {
      // localStorage unavailable: keep the default size
    }
  },
  mounted() {
    this.viewportHeight = window.innerHeight
    window.addEventListener('keydown', this.onKeyDown, true)
    window.addEventListener('resize', this.onResize)
    this.$eventBus.$on('transcript-back', this.back)
    this.$store.commit('setTranscriptOpen', true)
    this.$refs.root && this.$refs.root.focus({ preventScroll: true })
    this.load()
  },
  beforeDestroy() {
    window.removeEventListener('keydown', this.onKeyDown, true)
    window.removeEventListener('resize', this.onResize)
    this.$eventBus.$off('transcript-back', this.back)
    clearInterval(this.tickTimer)
    clearTimeout(this.searchTimer)
    // Keep the flag up briefly: a hardware Back press can deliver both a DOM key event and the native
    // backButton event, and the second one must not fall through to the player.
    const store = this.$store
    setTimeout(() => store.commit('setTranscriptOpen', false), 400)
  },
  methods: {
    async load() {
      try {
        const result = await loadTranscript(this.$nativeHttp, this.libraryItemId, this.sources, (p) => (this.progress = p))
        this.cues = Object.freeze(result.cues)
        this.hasWords = result.hasWords
        this.status = 'ready'
        this.tick()
        this.selectedIdx = Math.max(this.activeIdx, 0)
        this.ensureWindow()
        this.$nextTick(() => this.applyTransform(false))
        this.tickTimer = setInterval(this.tick, 100)
      } catch (error) {
        console.error('[transcript] load failed', error)
        this.status = 'error'
      }
    },

    // ---- playback clock ----
    syncClock(val) {
      const now = performance.now()
      if (now < this.seekHoldUntil && Math.abs(val - this.seekTarget) > 2) return
      this.anchorT = val
      this.anchorAt = now
    },
    interpolate() {
      return this.anchorT + ((performance.now() - this.anchorAt) / 1000) * (this.playbackRate || 1)
    },
    estimateTime() {
      return this.isPlaying ? this.interpolate() : this.anchorT
    },
    tick() {
      if (!this.cues.length) return
      const t = this.estimateTime()
      const idx = findCueIndex(this.cues, t)
      if (idx !== this.activeIdx) this.activeIdx = idx
      const w = idx >= 0 && this.cues[idx].words ? findWordIndex(this.cues[idx], t) : -1
      if (w !== this.wordIdx) this.wordIdx = w
      if (this.following && idx >= 0 && this.selectedIdx !== idx) this.selectedIdx = idx
    },

    // ---- windowing / positioning ----
    ensureWindow() {
      const n = this.cues.length
      if (!n) return
      const c = this.centerIdx
      const needs = this.winEnd === 0 || (c < this.winStart + WINDOW_MARGIN && this.winStart > 0) || (c > this.winEnd - WINDOW_MARGIN && this.winEnd < n) || c < this.winStart || c >= this.winEnd
      if (!needs) return
      this.winStart = Math.max(0, c - WINDOW_BEFORE)
      this.winEnd = Math.min(n, c + WINDOW_AFTER)
      this.rebased = true // DOM above the centre changes: reposition without animating
    },
    applyTransform(animate) {
      const track = this.$refs.track
      const body = this.$refs.body
      if (!track || !body) return
      const el = track.querySelector(`[data-i="${this.centerIdx}"]`)
      if (!el) return
      const y = el.offsetTop + el.offsetHeight / 2
      const ty = Math.round(body.clientHeight * 0.42 - y)
      track.style.transition = animate && !this.rebased ? 'transform 180ms ease-out' : 'none'
      track.style.transform = `translate3d(0, ${ty}px, 0)`
      this.rebased = false
    },
    onResize() {
      this.viewportHeight = window.innerHeight
    },
    cueClass(i) {
      return {
        'tr-active': i === this.activeIdx,
        'tr-selected': this.zone === 'list' && !this.following && i === this.selectedIdx,
        'tr-match': this.searchOpen && this.matchSet.has(i)
      }
    },

    // ---- actions ----
    browse(idx) {
      const n = this.cues.length
      if (!n) return
      this.following = false
      this.selectedIdx = Math.min(n - 1, Math.max(0, idx))
    },
    resumeFollow() {
      this.following = true
      this.selectedIdx = Math.max(this.activeIdx, 0)
      this.zone = 'list'
    },
    seekToCue(i) {
      const cue = this.cues[i]
      if (!cue) return
      const t = cue.start
      this.anchorT = t
      this.anchorAt = performance.now()
      this.seekTarget = t
      this.seekHoldUntil = performance.now() + SEEK_HOLD_MS
      this.$emit('seek', t)
      this.activeIdx = i
      this.wordIdx = cue.words ? 0 : -1
      this.following = true
      this.selectedIdx = i
      this.zone = 'list'
    },
    onCueClick(i) {
      this.seekToCue(i)
    },
    changeFont(delta) {
      const next = Math.min(FONT_SCALES.length - 1, Math.max(0, this.fontLevel + delta))
      if (next === this.fontLevel) return
      this.fontLevel = next
      try {
        window.localStorage.setItem(FONT_STORAGE_KEY, String(next))
      } catch (e) {
        // ignore: preference simply is not remembered
      }
    },
    activateButton(i) {
      const b = this.headerButtons[i]
      if (!b || b.disabled) return
      this.headerIdx = i
      b.action()
    },

    // ---- search ----
    toggleSearch() {
      if (this.searchOpen) return this.closeSearch()
      this.searchOpen = true
      this.$nextTick(() => this.$refs.searchInput && this.$refs.searchInput.focus())
    },
    closeSearch() {
      this.searchOpen = false
      this.searchFocused = false
      this.query = ''
      this.matches = []
      this.matchPos = -1
    },
    scheduleSearch() {
      clearTimeout(this.searchTimer)
      this.searchTimer = setTimeout(this.runSearch, 250)
    },
    runSearch() {
      clearTimeout(this.searchTimer)
      this.matches = searchCues(this.cues, this.query)
      if (!this.matches.length) {
        this.matchPos = -1
        return
      }
      // First match at or after the current position
      let pos = this.matches.findIndex((m) => m >= this.centerIdx)
      if (pos < 0) pos = 0
      this.gotoMatch(pos)
    },
    gotoMatch(pos) {
      if (!this.matches.length) return
      this.matchPos = (pos + this.matches.length) % this.matches.length
      this.browse(this.matches[this.matchPos])
    },

    // ---- input ----
    back() {
      const now = Date.now()
      if (now - this.lastBackAt < 250) return
      this.lastBackAt = now
      if (this.searchOpen) return this.closeSearch()
      if (!this.following) return this.resumeFollow()
      this.$emit('close')
    },
    consume(e) {
      e.preventDefault()
      e.stopImmediatePropagation()
    },
    onKeyDown(e) {
      const k = e.key
      const isBack = k === 'Escape' || k === 'GoBack' || e.keyCode === 4
      if (this.searchFocused) {
        if (isBack) {
          this.consume(e)
          if (this.$refs.searchInput) this.$refs.searchInput.blur()
          if (!this.query) this.closeSearch()
        } else if (k === 'Enter') {
          this.consume(e)
          if (this.query) {
            this.runSearch()
            this.$refs.searchInput.blur()
            this.zone = 'list'
          }
        } else if (k === 'ArrowDown') {
          this.consume(e)
          this.$refs.searchInput.blur()
          this.zone = 'list'
        } else if (k === 'ArrowUp') {
          this.consume(e)
          this.$refs.searchInput.blur()
          this.zone = 'header'
        }
        return // everything else is typing
      }
      if (isBack) {
        this.consume(e)
        this.back()
        return
      }
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(k)) return
      this.consume(e)

      if (this.zone === 'header') {
        if (k === 'ArrowLeft') this.headerIdx = Math.max(0, this.headerIdx - 1)
        else if (k === 'ArrowRight') this.headerIdx = Math.min(this.headerButtons.length - 1, this.headerIdx + 1)
        else if (k === 'ArrowDown') this.zone = 'list'
        else if (k === 'Enter') this.activateButton(this.headerIdx)
        return
      }

      // list zone
      if (k === 'ArrowDown') this.browse(this.centerIdx + 1)
      else if (k === 'ArrowUp') {
        if (this.centerIdx <= 0) this.zone = 'header'
        else this.browse(this.centerIdx - 1)
      } else if (k === 'ArrowLeft' || k === 'ArrowRight') {
        const dir = k === 'ArrowRight' ? 1 : -1
        if (this.searchOpen && this.matches.length) this.gotoMatch(this.matchPos + dir)
        else this.browse(this.centerIdx + dir * JUMP_CUES)
      } else if (k === 'Enter') {
        if (this.following) this.$emit('toggle-play')
        else this.seekToCue(this.selectedIdx)
      }
    },
    onWheel(e) {
      if (this.status !== 'ready') return
      this.browse(this.centerIdx + (e.deltaY > 0 ? 1 : -1))
    },
    onTouchStart(e) {
      this.touchY = e.touches[0].clientY
      this.touchAcc = 0
    },
    onTouchMove(e) {
      if (this.status !== 'ready' || this.touchY === null) return
      const y = e.touches[0].clientY
      this.touchAcc += this.touchY - y
      this.touchY = y
      const step = this.fontPx * 2.5
      while (Math.abs(this.touchAcc) >= step) {
        const dir = this.touchAcc > 0 ? 1 : -1
        this.browse(this.centerIdx + dir)
        this.touchAcc -= dir * step
      }
    }
  }
}
</script>

<style scoped>
.transcript-view {
  background: linear-gradient(rgba(0, 0, 0, 0.78), rgba(0, 0, 0, 0.86)), var(--tr-bg);
  color: #fff;
  outline: none;
}
.tr-chapter {
  font-size: 1.05rem;
  font-weight: 600;
}
.tr-sub {
  font-size: 0.8rem;
  opacity: 0.7;
}
.tr-pill {
  margin-left: 0.5rem;
  padding: 0 0.5rem;
  border-radius: 9999px;
  border: 1px solid currentColor;
  font-size: 0.7rem;
}
.tr-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.75rem;
  height: 2.75rem;
  margin-left: 0.25rem;
  border-radius: 9999px;
  font-size: 1.6rem;
  cursor: pointer;
  border: 2px solid transparent;
}
.tr-btn-off {
  opacity: 0.35;
}
.tr-focus {
  border-color: var(--tv-focus-color, #1ad691);
  background: rgba(255, 255, 255, 0.12);
}
.tr-search {
  width: 100%;
  padding: 0.4rem 0.75rem;
  border-radius: 0.5rem;
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
  outline: none;
}
.tr-body {
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 10%, #000 90%, transparent 100%);
  mask-image: linear-gradient(to bottom, transparent 0, #000 10%, #000 90%, transparent 100%);
}
.tr-track {
  will-change: transform;
}
.tr-cue {
  margin: 0;
  padding: 0.35em 0.6em;
  line-height: 1.4;
  opacity: 0.45;
  border-left: 0.2em solid transparent;
  border-radius: 0.2em;
  overflow-wrap: anywhere;
}
.tr-active {
  opacity: 1;
}
.tr-selected {
  opacity: 0.95;
  border-left-color: var(--tv-focus-color, #1ad691);
  background: rgba(255, 255, 255, 0.08);
}
.tr-match {
  text-decoration: underline;
  text-decoration-color: rgba(255, 213, 79, 0.9);
}
.tr-word {
  opacity: 0.55;
}
.tr-word-done {
  opacity: 1;
}
.tr-word-now {
  opacity: 1;
  color: var(--tv-focus-color, #1ad691);
}
.tr-hint {
  font-size: 0.75rem;
  opacity: 0.55;
  text-align: center;
}
</style>

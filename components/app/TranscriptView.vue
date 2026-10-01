<template>
  <div ref="root" class="transcript-view absolute top-0 left-0 w-full h-full z-40 pointer-events-auto flex flex-col" :style="{ '--tr-bg': coverColor }" role="dialog" :aria-label="$strings.LabelTranscript" tabindex="-1" @wheel.prevent="onWheel" @touchstart.passive="onTouchStart" @touchmove.prevent="onTouchMove">
    <!-- Header: chapter title, position, controls -->
    <div class="tr-head flex items-center px-4 pt-3 pb-2">
      <div class="flex-1 min-w-0 pr-3">
        <p class="tr-chapter truncate">{{ headerChapter || $strings.LabelTranscript }}</p>
        <p class="tr-sub truncate">
          <span class="font-mono">{{ headerClock }}</span>
          <template v-if="duration > 0"
            ><span class="tr-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="Math.round(progressFraction * 100)"><span class="tr-progress-fill" :style="{ width: progressFraction * 100 + '%' }"></span></span
            ><span class="font-mono">-{{ remainingClock }}</span></template
          >
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

    <!-- Body: windowed list of blocks (paragraphs), the current line is positioned with a transform (no scrolling container) -->
    <div ref="body" class="tr-body relative flex-1 overflow-hidden">
      <div v-if="status === 'loading'" class="absolute inset-0 flex flex-col items-center justify-center text-fg-muted">
        <widgets-spinner-icon class="h-10 w-10 mb-3" />
        <p>{{ $strings.MessageTranscriptLoading }} <span v-if="progress > 0 && progress < 1">{{ Math.round(progress * 100) }}%</span></p>
      </div>
      <div v-else-if="status === 'error'" class="absolute inset-0 flex items-center justify-center px-8 text-center text-fg-muted">
        <p>{{ $strings.MessageTranscriptFailed }}</p>
      </div>
      <div v-else ref="track" class="tr-track absolute left-0 right-0 top-0 px-6" :style="{ fontSize: fontPx + 'px' }">
        <app-transcript-block v-for="b in windowIndices" :key="b" :cues="cues" :block="blocks[b]" :index="b" :active-cue="b === activeBlock ? activeIdx : -1" :word-idx="b === activeBlock ? wordIdx : -1" :selected="zone === 'list' && !following && b === selectedBlock" :match-set="searchOpen ? matchSet : null" @pick="onPick" />
      </div>
    </div>

    <p v-if="isTv" class="tr-hint truncate px-4 py-1">{{ following ? $strings.MessageTranscriptHintFollow : $strings.MessageTranscriptHintBrowse }}</p>
  </div>
</template>

<script>
import { findCueIndex, findWordIndex, searchCues, formatClock, buildBlocks, seekTimeForCue } from '@/utils/transcript'
import { loadTranscript } from '@/utils/transcriptLoader'
import playbackClock from '@/mixins/playbackClock'
import { enterReader, leaveReader } from '@/utils/readerFlag'

const FONT_SCALES = [0.8, 1, 1.25, 1.5, 1.8]
const FONT_STORAGE_KEY = 'absTranscriptFontLevel'
// Window sizes in blocks: a book paragraph holds several sentences, a legacy block is a single cue
const WINDOW = { book: { before: 12, after: 24, margin: 6 }, legacy: { before: 30, after: 50, margin: 12 } }

export default {
  mixins: [playbackClock],
  props: {
    libraryItemId: { type: String, required: true },
    // [{ ino, offset, signature }] from fetchTranscriptSources
    sources: { type: Array, required: true },
    currentTime: { type: Number, default: 0 },
    isPlaying: Boolean,
    playbackRate: { type: Number, default: 1 },
    chapters: { type: Array, default: () => [] },
    // Total book duration in seconds (0 = unknown, hides the progress bar)
    duration: { type: Number, default: 0 },
    coverColor: { type: String, default: 'rgb(55, 56, 56)' },
    // A synced EPUB exists too: show a header button that switches to the book view
    canSwitchMode: Boolean
  },
  data() {
    return {
      status: 'loading', // loading | ready | error
      progress: 0,
      cues: [],
      blocks: [],
      blockOf: null,
      book: false,
      hasWords: false,
      zone: 'list', // list | header
      headerIdx: 0,
      following: true,
      activeIdx: -1,
      wordIdx: -1,
      selectedBlock: 0,
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
    win() {
      return this.book ? WINDOW.book : WINDOW.legacy
    },
    // Block that holds the current sentence (-1 before the first spoken cue)
    activeBlock() {
      return this.blockOf && this.activeIdx >= 0 ? this.blockOf[this.activeIdx] : -1
    },
    centerBlock() {
      if (this.following) return Math.max(this.activeBlock, 0)
      return this.selectedBlock
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
      const buttons = [
        { id: 'play', icon: this.isPlaying ? 'pause' : 'play_arrow', label: this.$strings.LabelTranscriptPlayPause, action: () => this.$emit('toggle-play') },
        { id: 'follow', icon: 'my_location', label: this.$strings.LabelTranscriptFollow, disabled: this.following, action: () => this.resumeFollow() },
        { id: 'smaller', icon: 'text_decrease', label: this.$strings.LabelTranscriptFontSmaller, disabled: this.fontLevel === 0, action: () => this.changeFont(-1) },
        { id: 'larger', icon: 'text_increase', label: this.$strings.LabelTranscriptFontLarger, disabled: this.fontLevel === FONT_SCALES.length - 1, action: () => this.changeFont(1) },
        { id: 'search', icon: 'search', label: this.$strings.LabelTranscriptSearch, action: () => this.toggleSearch() }
      ]
      // Result navigation is a pair of header buttons so it stays reachable with the D-pad
      if (this.searchOpen && this.matches.length) {
        buttons.push({ id: 'prev-match', icon: 'keyboard_arrow_up', label: this.$strings.LabelTranscriptPrevMatch, action: () => this.gotoMatch(this.matchPos - 1) })
        buttons.push({ id: 'next-match', icon: 'keyboard_arrow_down', label: this.$strings.LabelTranscriptNextMatch, action: () => this.gotoMatch(this.matchPos + 1) })
      }
      if (this.canSwitchMode) buttons.push({ id: 'mode', icon: 'menu_book', label: this.$strings.LabelReaderBook, action: () => this.$emit('switch-mode') })
      buttons.push({ id: 'close', icon: 'close', label: this.$strings.ButtonClose, action: () => this.$emit('close') })
      return buttons
    },
    // Book time of the row shown in the header: the playback position while following, else the browsed block
    headerTime() {
      if (this.following || !this.blocks.length) return this.currentTime
      const b = this.blocks[this.centerBlock]
      if (!b) return this.currentTime
      const cue = this.cues[b.firstSpoken >= 0 ? b.firstSpoken : b.first]
      return cue ? cue.start : this.currentTime
    },
    headerClock() {
      return formatClock(this.headerTime)
    },
    progressFraction() {
      return this.duration > 0 ? Math.min(1, Math.max(0, this.headerTime / this.duration)) : 0
    },
    // Same arithmetic as the player's own "remaining" readout: book time left divided by the playback speed
    remainingClock() {
      return formatClock(Math.max(0, this.duration - this.headerTime) / (this.playbackRate || 1))
    },
    headerChapter() {
      const t = this.headerTime
      const ch = this.chapters.find((c) => Number(c.start) <= t && Number(c.end) > t)
      return ch ? ch.title : ''
    }
  },
  watch: {
    centerBlock() {
      if (this.following) return Math.max(this.activeBlock, 0)
      return this.selectedBlock
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
      const buttons = [
        { id: 'play', icon: this.isPlaying ? 'pause' : 'play_arrow', label: this.$strings.LabelTranscriptPlayPause, action: () => this.$emit('toggle-play') },
        { id: 'follow', icon: 'my_location', label: this.$strings.LabelTranscriptFollow, disabled: this.following, action: () => this.resumeFollow() },
        { id: 'smaller', icon: 'text_decrease', label: this.$strings.LabelTranscriptFontSmaller, disabled: this.fontLevel === 0, action: () => this.changeFont(-1) },
        { id: 'larger', icon: 'text_increase', label: this.$strings.LabelTranscriptFontLarger, disabled: this.fontLevel === FONT_SCALES.length - 1, action: () => this.changeFont(1) },
        { id: 'search', icon: 'search', label: this.$strings.LabelTranscriptSearch, action: () => this.toggleSearch() }
      ]
      // Result navigation is a pair of header buttons so it stays reachable with the D-pad
      if (this.searchOpen && this.matches.length) {
        buttons.push({ id: 'prev-match', icon: 'keyboard_arrow_up', label: this.$strings.LabelTranscriptPrevMatch, action: () => this.gotoMatch(this.matchPos - 1) })
        buttons.push({ id: 'next-match', icon: 'keyboard_arrow_down', label: this.$strings.LabelTranscriptNextMatch, action: () => this.gotoMatch(this.matchPos + 1) })
      }
      if (this.canSwitchMode) buttons.push({ id: 'mode', icon: 'menu_book', label: this.$strings.LabelReaderBook, action: () => this.$emit('switch-mode') })
      buttons.push({ id: 'close', icon: 'close', label: this.$strings.ButtonClose, action: () => this.$emit('close') })
      return buttons
    },
    // Book time of the row shown in the header: the playback position while following, else the browsed block
    headerTime() {
      if (this.following || !this.blocks.length) return this.currentTime
      const b = this.blocks[this.centerBlock]
      if (!b) return this.currentTime
      const cue = this.cues[b.firstSpoken >= 0 ? b.firstSpoken : b.first]
      return cue ? cue.start : this.currentTime
    },
    headerClock() {
      return formatClock(this.headerTime)
    },
    progressFraction() {
      return this.duration > 0 ? Math.min(1, Math.max(0, this.headerTime / this.duration)) : 0
    },
    // Same arithmetic as the player's own "remaining" readout: book time left divided by the playback speed
    remainingClock() {
      return formatClock(Math.max(0, this.duration - this.headerTime) / (this.playbackRate || 1))
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
    centerBlock() {
      this.ensureWindow()
      this.scheduleTransform(true)
    },
    // While following, keep the line being read at a fixed height (typewriter style)
    wordIdx() {
      if (this.following) this.scheduleTransform(true)
    },
    activeIdx() {
      if (this.following) this.scheduleTransform(true)
    },
    following() {
      this.scheduleTransform(true)
    },
    fontPx() {
      this.scheduleTransform(false)
    },
    viewportHeight() {
      this.scheduleTransform(false)
    },
    headerButtons(list) {
      if (this.headerIdx >= list.length) this.headerIdx = list.length - 1
    }
  },
  created() {
    this.rebased = true
    this.lastBackAt = 0
    this.searchTimer = null
    this.tickTimer = null
    this.transformQueued = false
    this.transformAnimate = false
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
    enterReader(this.$store)
    this.$refs.root && this.$refs.root.focus({ preventScroll: true })
    this.load()
  },
  beforeDestroy() {
    window.removeEventListener('keydown', this.onKeyDown, true)
    window.removeEventListener('resize', this.onResize)
    this.$eventBus.$off('transcript-back', this.back)
    clearInterval(this.tickTimer)
    clearTimeout(this.searchTimer)
    leaveReader(this.$store)
  },
  methods: {
    async load() {
      try {
        const result = await loadTranscript(this.$nativeHttp, this.libraryItemId, this.sources, (p) => (this.progress = p))
        const layout = buildBlocks(result.cues)
        this.cues = Object.freeze(result.cues)
        this.blocks = Object.freeze(layout.blocks)
        this.blockOf = layout.blockOf
        this.book = layout.book
        this.hasWords = result.hasWords
        this.status = 'ready'
        this.tick()
        this.selectedBlock = Math.max(this.activeBlock, 0)
        this.ensureWindow()
        this.scheduleTransform(false)
        this.tickTimer = setInterval(this.tick, 100)
      } catch (error) {
        console.error('[transcript] load failed', error)
        this.status = 'error'
      }
    },

    // ---- playback clock (see mixins/playbackClock.js) ----
    tick() {
      if (!this.cues.length) return
      const t = this.estimateTime()
      // Only cues with spoken words can be current; fully unspoken cues are skipped by the lookup
      const idx = findCueIndex(this.cues, t)
      if (idx !== this.activeIdx) this.activeIdx = idx
      const w = idx >= 0 && this.cues[idx].words ? findWordIndex(this.cues[idx], t) : -1
      if (w !== this.wordIdx) this.wordIdx = w
      if (this.following && idx >= 0 && this.selectedBlock !== this.blockOf[idx]) this.selectedBlock = this.blockOf[idx]
    },

    // ---- windowing / positioning ----
    ensureWindow() {
      const n = this.blocks.length
      if (!n) return
      const c = this.centerBlock
      const { before, after, margin } = this.win
      const needs = this.winEnd === 0 || (c < this.winStart + margin && this.winStart > 0) || (c > this.winEnd - margin && this.winEnd < n) || c < this.winStart || c >= this.winEnd
      if (!needs) return
      this.winStart = Math.max(0, c - before)
      this.winEnd = Math.min(n, c + after)
      this.rebased = true // DOM above the centre changes: reposition without animating
    },
    scheduleTransform(animate) {
      this.transformAnimate = this.transformAnimate || animate
      if (this.transformQueued) return
      this.transformQueued = true
      this.$nextTick(() => {
        this.transformQueued = false
        const a = this.transformAnimate
        this.transformAnimate = false
        this.applyTransform(a)
      })
    },
    applyTransform(animate) {
      const track = this.$refs.track
      const body = this.$refs.body
      if (!track || !body) return
      const blockEl = track.querySelector(`[data-b="${this.centerBlock}"]`)
      if (!blockEl) return
      const bodyH = body.clientHeight
      const trackTop = track.getBoundingClientRect().top
      // Rect of an element relative to the (possibly mid-transition) track
      const relRect = (el) => {
        const r = el.getClientRects()[0] || el.getBoundingClientRect()
        return { top: r.top - trackTop, height: r.height }
      }
      let ty
      let lineEl = null
      if (this.following && this.activeBlock === this.centerBlock) {
        // Follow the line being read: the current word, else the current sentence
        lineEl = track.querySelector('.tr-word-now') || track.querySelector(`[data-c="${this.activeIdx}"]`)
      }
      if (lineEl) {
        const r = relRect(lineEl)
        ty = Math.round(bodyH * 0.42 - (r.top + r.height / 2))
      } else {
        const r = relRect(blockEl)
        // A paragraph taller than the screen is aligned by its top edge so its start stays visible
        ty = r.height > bodyH * 0.7 ? Math.round(bodyH * 0.15 - r.top) : Math.round(bodyH * 0.42 - (r.top + r.height / 2))
      }
      track.style.transition = animate && !this.rebased ? 'transform 180ms ease-out' : 'none'
      track.style.transform = `translate3d(0, ${ty}px, 0)`
      this.rebased = false
    },
    onResize() {
      this.viewportHeight = window.innerHeight
    },
    centerBlockHeight() {
      const track = this.$refs.track
      const el = track && track.querySelector(`[data-b="${this.centerBlock}"]`)
      return el ? el.offsetHeight : 0
    },

    // ---- actions ----
    browse(blockIdx) {
      const n = this.blocks.length
      if (!n) return
      this.following = false
      this.selectedBlock = Math.min(n - 1, Math.max(0, blockIdx))
    },
    resumeFollow() {
      this.following = true
      this.selectedBlock = Math.max(this.activeBlock, 0)
      this.zone = 'list'
    },
    seekToTime(t) {
      if (t < 0) return
      this.markSeek(t)
      this.$emit('seek', t)
      const idx = findCueIndex(this.cues, t)
      this.activeIdx = idx
      this.wordIdx = idx >= 0 && this.cues[idx].words ? findWordIndex(this.cues[idx], t) : -1
      this.following = true
      this.selectedBlock = Math.max(idx >= 0 ? this.blockOf[idx] : 0, 0)
      this.zone = 'list'
    },
    // Seek to the first spoken word of a cue / block
    seekToCue(i) {
      this.seekToTime(seekTimeForCue(this.cues, i))
    },
    seekToBlock(b) {
      const blk = this.blocks[b]
      if (blk) this.seekToCue(blk.firstSpoken >= 0 ? blk.firstSpoken : blk.first)
    },
    onPick(ci) {
      this.seekToCue(ci)
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
      // The result buttons disappear with the search: keep the header focus on the search button
      // instead of letting it clamp onto Close
      const at = this.headerButtons.findIndex((b) => b.id === 'search')
      if (this.zone === 'header' && this.headerIdx > at) this.headerIdx = at
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
      // First match at or after the current block
      const from = this.blocks[this.centerBlock] ? this.blocks[this.centerBlock].first : 0
      let pos = this.matches.findIndex((m) => m >= from)
      if (pos < 0) pos = 0
      this.gotoMatch(pos)
    },
    gotoMatch(pos) {
      if (!this.matches.length) return
      this.matchPos = (pos + this.matches.length) % this.matches.length
      this.browse(this.blockOf[this.matches[this.matchPos]])
    },

    // ---- input ----
    back() {
      const now = Date.now()
      if (now - this.lastBackAt < 250) return
      this.lastBackAt = now
      if (this.searchOpen) return this.closeSearch()
      if (this.zone === 'header') {
        this.zone = 'list'
        return
      }
      if (!this.following) return this.resumeFollow()
      this.$emit('close')
    },
    consume(e) {
      e.preventDefault()
      e.stopImmediatePropagation()
    },
    /*
     * Key map (Android TV remote):
     *   text    Up / Down      previous / next paragraph (Up on the first one moves to the header)
     *           Left / Right   move focus to the header button row
     *           OK             following: play / pause, browsing: play from the focused paragraph
     *   header  Left / Right   previous / next button
     *           OK             activate the focused button
     *           Down           back to the text (or into the search field when search is open)
     *   search  typing, OK runs the search; Down = text, Up = header; result navigation = the
     *           up / down arrow buttons that appear in the header while there are matches
     *   Back    closes search, then leaves the header row, then resumes following, then closes the view
     */
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
        else if (k === 'ArrowDown') {
          // With results on screen go straight to the text (focusing the field would pop the TV keyboard)
          if (this.searchOpen && !this.query && this.$refs.searchInput) this.$refs.searchInput.focus()
          else this.zone = 'list'
        } else if (k === 'Enter') this.activateButton(this.headerIdx)
        return
      }

      // text zone
      if (k === 'ArrowDown') this.browse(this.centerBlock + 1)
      else if (k === 'ArrowUp') {
        if (this.centerBlock <= 0) this.zone = 'header'
        else this.browse(this.centerBlock - 1)
      } else if (k === 'ArrowLeft' || k === 'ArrowRight') {
        this.zone = 'header'
      } else if (k === 'Enter') {
        if (this.following) this.$emit('toggle-play')
        else this.seekToBlock(this.selectedBlock)
      }
    },
    onWheel(e) {
      if (this.status !== 'ready') return
      this.browse(this.centerBlock + (e.deltaY > 0 ? 1 : -1))
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
      // One step per block, so the distance to drag is about the height of a paragraph
      const bodyH = (this.$refs.body && this.$refs.body.clientHeight) || 600
      let guard = 0
      for (;;) {
        const step = Math.min(Math.max(this.centerBlockHeight(), this.fontPx * 2.5), bodyH * 0.5)
        if (Math.abs(this.touchAcc) < step || ++guard > 20) break
        const dir = this.touchAcc > 0 ? 1 : -1
        this.browse(this.centerBlock + dir)
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
.tr-progress {
  display: inline-block;
  width: 14em;
  max-width: 28%;
  height: 0.35em;
  margin: 0 0.4em;
  vertical-align: middle;
  border-radius: 9999px;
  background: rgba(255, 255, 255, 0.25);
  overflow: hidden;
}
@media (max-width: 480px) {
  /* the header buttons leave very little room on a phone: keep the two clocks, drop the bar */
  .tr-progress {
    display: none;
  }
  .tr-progress + .font-mono {
    margin-left: 0.5em;
  }
}
.tr-progress-fill {
  display: block;
  height: 100%;
  background: var(--tv-focus-color, #1ad691);
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
.tr-hint {
  font-size: 0.75rem;
  opacity: 0.55;
  text-align: center;
}
</style>

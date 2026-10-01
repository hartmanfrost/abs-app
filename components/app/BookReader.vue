<template>
  <div ref="root" class="book-reader absolute top-0 left-0 w-full h-full z-40 pointer-events-auto flex flex-col" :style="{ '--tr-bg': coverColor }" role="dialog" :aria-label="$strings.LabelReaderBook" tabindex="-1">
    <!-- Header: chapter title, position, controls (same row as the transcript view) -->
    <div class="tr-head flex items-center px-4 pt-3 pb-2">
      <div class="flex-1 min-w-0 pr-3">
        <p class="tr-chapter truncate">{{ headerChapter || $strings.LabelReaderBook }}</p>
        <p class="tr-sub truncate">
          <span class="font-mono">{{ headerClock }}</span>
          <template v-if="duration > 0"
            ><span class="tr-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="Math.round(progressFraction * 100)"><span class="tr-progress-fill" :style="{ width: progressFraction * 100 + '%' }"></span></span
            ><span class="font-mono">-{{ remainingClock }}</span></template
          >
          <span v-if="!following" class="tr-pill">{{ $strings.LabelTranscriptFollow }}</span>
          <span v-if="searchOpen && query" class="ml-2">{{ searchBusy ? '…' : matchCount ? `${matchPos + 1}/${matchCount}` : $strings.MessageTranscriptNoResults }}</span>
        </p>
      </div>
      <div class="flex items-center">
        <span v-for="(b, i) in headerButtons" :key="b.id" role="button" class="tr-btn material-symbols" :class="{ 'tr-focus': zone === 'header' && headerIdx === i, 'tr-btn-off': b.disabled }" :title="b.label" :aria-label="b.label" @click.stop="activateButton(i)">{{ b.icon }}</span>
      </div>
    </div>

    <div v-if="searchOpen" class="px-4 pb-2">
      <input ref="searchInput" v-model="query" type="search" class="tr-search" :placeholder="$strings.LabelTranscriptSearchPlaceholder" enterkeyhint="search" autocomplete="off" @input="scheduleSearch" @focus="searchFocused = true" @blur="searchFocused = false" @click.stop />
    </div>

    <!-- Body: the chapter lives in an isolated iframe document with the book's own CSS; it is scaled as a whole for 10-foot viewing -->
    <div ref="body" class="bk-body relative flex-1 overflow-hidden">
      <iframe ref="frame" class="bk-frame" :class="{ 'bk-frame-hidden': status !== 'ready' }" :style="frameStyle" tabindex="-1" title="Book"></iframe>
      <div v-if="status === 'loading'" class="absolute inset-0 flex flex-col items-center justify-center text-fg-muted bk-overlay">
        <widgets-spinner-icon class="h-10 w-10 mb-3" />
        <p>{{ $strings.MessageReaderBookLoading }} <span v-if="progress > 0 && progress < 1">{{ Math.round(progress * 100) }}%</span></p>
      </div>
      <div v-else-if="status === 'error' || status === 'unsynced'" class="absolute inset-0 flex items-center justify-center px-8 text-center text-fg-muted bk-overlay">
        <p>{{ status === 'unsynced' ? $strings.MessageReaderBookNotSynced : $strings.MessageReaderBookFailed }}</p>
      </div>
      <div v-if="chapterLoading && status === 'ready'" class="bk-chapter-busy"><widgets-spinner-icon class="h-6 w-6" /></div>
    </div>

    <p v-if="isTv" class="tr-hint truncate px-4 py-1">{{ hint }}</p>

    <!-- Fullscreen interactive widget -->
    <div v-if="widgetOpen" class="bk-wfull" @click.stop>
      <div class="bk-wstage" :style="widgetStageStyle">
        <iframe v-if="widgetOpen.src" ref="wframe" :src="widgetOpen.src" class="bk-wframe" allow="autoplay; fullscreen" tabindex="-1" @load="onWidgetLoad"></iframe>
        <img v-else-if="widgetOpen.thumb" :src="widgetOpen.thumb" class="bk-wthumb" alt="" />
        <div v-if="widgetOpen.src && isTv" class="bk-pointer" :style="{ left: pointer.x + 'px', top: pointer.y + 'px' }"></div>
      </div>
      <p class="bk-whint truncate">{{ $strings.MessageReaderWidgetHint }}</p>
    </div>
  </div>
</template>

<script>
import { findPar, parForId } from '@/utils/epub/smil'
import { decodeEntities } from '@/utils/epub/epubPackage'
import { openBookFor } from '@/utils/epub/epubBook'
import { buildChapterHtml, hydrateChapter } from '@/utils/epub/chapterRender'
import { ensureVfs, mountBook, unmountBook, vfsUrl } from '@/utils/epub/vfs'
import { formatClock } from '@/utils/transcript'
import playbackClock from '@/mixins/playbackClock'
import { enterReader, leaveReader } from '@/utils/readerFlag'

const FONT_SCALES = [0.8, 1, 1.25, 1.5, 1.8]
const FONT_STORAGE_KEY = 'absBookFontLevel'
const BLOCKS = 'p,h1,h2,h3,h4,h5,h6,li,dd,dt,blockquote,figcaption,td,th,pre,div'
const WORD_ID = /^w\d+$/
const MAX_MATCHES = 400

export default {
  mixins: [playbackClock],
  props: {
    libraryItemId: { type: String, required: true },
    // { ino, size, signature } of the synced .epub (see fetchItemFiles)
    file: { type: Object, required: true },
    currentTime: { type: Number, default: 0 },
    isPlaying: Boolean,
    playbackRate: { type: Number, default: 1 },
    chapters: { type: Array, default: () => [] },
    duration: { type: Number, default: 0 },
    coverColor: { type: String, default: 'rgb(55, 56, 56)' },
    // A VTT transcript exists too: show a header button that switches to it
    canSwitchMode: Boolean
  },
  data() {
    return {
      status: 'loading', // loading | ready | error | unsynced
      progress: 0,
      chapterLoading: false,
      zone: 'list', // list | header
      headerIdx: 0,
      following: true,
      fontLevel: 1,
      viewChapter: 0,
      selIdx: -1,
      selKind: 'p',
      selTime: -1,
      rootW: 0,
      rootH: 0,
      bodyW: 0,
      bodyH: 0,
      scale: 1,
      searchOpen: false,
      searchFocused: false,
      searchBusy: false,
      query: '',
      matchCount: 0,
      matchPos: -1,
      widgetOpen: null,
      pointer: { x: 0, y: 0 }
    }
  },
  computed: {
    isTv() {
      return !!this.$store.state.isAndroidTv
    },
    frameStyle() {
      const s = this.scale || 1
      return { width: this.bodyW / s + 'px', height: this.bodyH / s + 'px', transform: `scale(${s})` }
    },
    widgetStageStyle() {
      const o = this.widgetOpen
      if (!o) return {}
      const k = Math.min((this.rootW || 1280) / o.w, ((this.rootH || 720) - 30) / o.h)
      return { width: o.w + 'px', height: o.h + 'px', transform: `translate(-50%, -50%) scale(${k})` }
    },
    hint() {
      if (this.following) return this.$strings.MessageReaderHintFollow
      return this.selKind === 'widget' ? this.$strings.MessageReaderHintWidget : this.$strings.MessageReaderHintBrowse
    },
    headerButtons() {
      const buttons = [
        { id: 'play', icon: this.isPlaying ? 'pause' : 'play_arrow', label: this.$strings.LabelTranscriptPlayPause, action: () => this.$emit('toggle-play') },
        { id: 'follow', icon: 'my_location', label: this.$strings.LabelTranscriptFollow, disabled: this.following, action: () => this.resumeFollow() },
        { id: 'smaller', icon: 'text_decrease', label: this.$strings.LabelTranscriptFontSmaller, disabled: this.fontLevel === 0, action: () => this.changeFont(-1) },
        { id: 'larger', icon: 'text_increase', label: this.$strings.LabelTranscriptFontLarger, disabled: this.fontLevel === FONT_SCALES.length - 1, action: () => this.changeFont(1) },
        { id: 'search', icon: 'search', label: this.$strings.LabelReaderBookSearch, action: () => this.toggleSearch() }
      ]
      if (this.searchOpen && this.matchCount) {
        buttons.push({ id: 'prev-match', icon: 'keyboard_arrow_up', label: this.$strings.LabelTranscriptPrevMatch, action: () => this.gotoMatch(this.matchPos - 1) })
        buttons.push({ id: 'next-match', icon: 'keyboard_arrow_down', label: this.$strings.LabelTranscriptNextMatch, action: () => this.gotoMatch(this.matchPos + 1) })
      }
      if (this.canSwitchMode) buttons.push({ id: 'mode', icon: 'subtitles', label: this.$strings.LabelReaderTranscript, action: () => this.$emit('switch-mode') })
      buttons.push({ id: 'close', icon: 'close', label: this.$strings.ButtonClose, action: () => this.$emit('close') })
      return buttons
    },
    // Book time shown in the header: the playback position while following, else the browsed paragraph
    headerTime() {
      return this.following || this.selTime < 0 ? this.currentTime : this.selTime
    },
    headerClock() {
      return formatClock(this.headerTime)
    },
    progressFraction() {
      return this.duration > 0 ? Math.min(1, Math.max(0, this.headerTime / this.duration)) : 0
    },
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
    fontLevel() {
      this.relayout()
    },
    headerButtons(list) {
      if (this.headerIdx >= list.length) this.headerIdx = list.length - 1
    }
  },
  created() {
    // Everything below is deliberately non-reactive (large objects, DOM nodes, timers)
    this.book = null
    this.sid = ''
    this.vfsOk = false
    this.doc = null
    this.win = null
    this.items = []
    this.widgets = []
    this.smil = null // overlay of the displayed chapter
    this.wordEl = null
    this.paraEl = null
    this.selEl = null
    this.findEl = null
    this.lastPar = -1
    this.loadToken = 0
    this.relocating = false
    this.cancelHydrate = null
    this.scrollRaf = 0
    this.userScrollTimer = null
    this.liveTimer = null
    this.liveWrap = null
    this.tickTimer = null
    this.searchTimer = null
    this.searchIndex = null
    this.searchResults = []
    this.lastBackAt = 0
    this.dropcaps = []
    this.wasPlayingBeforeWidget = false
    try {
      const stored = parseInt(window.localStorage.getItem(FONT_STORAGE_KEY), 10)
      if (stored >= 0 && stored < FONT_SCALES.length) this.fontLevel = stored
    } catch (e) {
      // localStorage unavailable: keep the default size
    }
  },
  mounted() {
    this.measure()
    window.addEventListener('keydown', this.onKeyDown, true)
    window.addEventListener('resize', this.onResize)
    window.addEventListener('message', this.onWindowMessage)
    this.$eventBus.$on('transcript-back', this.back)
    enterReader(this.$store)
    this.$refs.root && this.$refs.root.focus({ preventScroll: true })
    this.open()
  },
  beforeDestroy() {
    window.removeEventListener('keydown', this.onKeyDown, true)
    window.removeEventListener('resize', this.onResize)
    window.removeEventListener('message', this.onWindowMessage)
    this.$eventBus.$off('transcript-back', this.back)
    clearInterval(this.tickTimer)
    clearTimeout(this.searchTimer)
    clearTimeout(this.liveTimer)
    clearTimeout(this.userScrollTimer)
    cancelAnimationFrame(this.scrollRaf)
    if (this.cancelHydrate) this.cancelHydrate()
    if (this.wasPlayingBeforeWidget && this.widgetOpen && !this.isPlaying) this.$emit('toggle-play')
    if (this.sid) unmountBook(this.sid)
    this.loadToken++
    leaveReader(this.$store)
  },
  methods: {
    measure() {
      const body = this.$refs.body
      if (!body) return
      this.bodyW = body.clientWidth
      this.bodyH = body.clientHeight
      this.rootW = this.$refs.root.clientWidth
      this.rootH = this.$refs.root.clientHeight
    },
    onResize() {
      this.measure()
      this.relayout()
    },

    // ---- opening ----
    async open() {
      try {
        const [book, vfsOk] = await Promise.all([openBookFor(this.$nativeHttp, this.libraryItemId, this.file), ensureVfs()])
        if (this._isDestroyed) return
        this.book = book
        this.vfsOk = vfsOk
        if (!book.synced) {
          this.status = 'unsynced'
          return
        }
        this.sid = mountBook(book)
        const t = this.estimateTime()
        const ch = await book.timeline.chapterAt(t, 0)
        await this.showChapter(Math.max(0, ch), { initial: true })
        this.status = 'ready'
        this.tickTimer = setInterval(this.tick, 100)
        this.$nextTick(() => this.tick())
      } catch (error) {
        console.error('[book] open failed', error)
        if (!this._isDestroyed) this.status = 'error'
      }
    },

    // ---- chapter loading / layout ----
    async showChapter(idx, { initial = false } = {}) {
      const token = ++this.loadToken
      const book = this.book
      this.chapterLoading = !initial
      try {
        const built = await buildChapterHtml(book, idx)
        if (token !== this.loadToken) return false
        const smil = await book.timeline.smilFor(idx)
        if (token !== this.loadToken) return false
        const frame = this.$refs.frame
        await new Promise((resolve) => {
          frame.addEventListener('load', resolve, { once: true })
          frame.srcdoc = built.html
        })
        if (token !== this.loadToken) return false
        this.detach()
        this.doc = frame.contentDocument
        this.win = frame.contentWindow
        this.smil = smil
        this.widgets = built.widgets
        this.dropcaps = built.dropcaps
        this.viewChapter = idx
        this.lastPar = -1
        this.wordEl = this.paraEl = this.selEl = this.findEl = null
        this.cancelHydrate = hydrateChapter(this.doc, book, built.dropcaps)
        this.attach()
        try {
          await Promise.race([this.doc.fonts.ready, new Promise((r) => setTimeout(r, 2500))])
        } catch (e) {
          // fonts API unavailable: lay out with what is there
        }
        if (token !== this.loadToken) return false
        this.buildItems()
        this.applyScale()
        // Warm the next chapter while this one is read
        if (idx + 1 < book.chapters.length) book.timeline.preload(idx + 1)
        this.selIdx = -1
        this.selTime = -1
        this.win.scrollTo(0, 0)
        this.scheduleLive()
        return true
      } catch (error) {
        console.error('[book] chapter failed', error)
        if (token === this.loadToken && initial) throw error
        return false
      } finally {
        if (token === this.loadToken) this.chapterLoading = false
      }
    },
    attach() {
      const doc = this.doc
      this.onDocClick = (e) => {
        const w = e.target.closest && e.target.closest('.abs-widget')
        if (w) {
          this.openWidget(parseInt(w.getAttribute('data-abs-w'), 10))
          return
        }
        const word = e.target.closest && e.target.closest('[id^="w"]')
        if (word && WORD_ID.test(word.id)) this.seekToWord(word)
      }
      this.onDocScroll = () => {
        if (!this.autoScrolling && !this.isTv && this.following && this.status === 'ready') this.following = false
        this.scheduleLive()
      }
      doc.addEventListener('click', this.onDocClick)
      this.win.addEventListener('scroll', this.onDocScroll, { passive: true })
    },
    detach() {
      if (this.cancelHydrate) this.cancelHydrate()
      this.cancelHydrate = null
      this.liveWrap = null
      // The old document goes away with the next srcdoc; nothing else holds listeners on it
      this.doc = null
      this.win = null
    },
    buildItems() {
      const doc = this.doc
      const items = []
      const index = new Map()
      let last = null
      doc.querySelectorAll('[id^="w"], .abs-widget').forEach((n) => {
        if (n.classList.contains('abs-widget')) {
          index.set(n, items.length)
          items.push({ el: n, kind: 'widget', widget: parseInt(n.getAttribute('data-abs-w'), 10), first: null })
          last = null
          return
        }
        if (!WORD_ID.test(n.id)) return
        const block = n.closest(BLOCKS) || n.parentElement
        if (block === last) return
        last = block
        if (index.has(block)) return
        index.set(block, items.length)
        items.push({ el: block, kind: 'p', first: n.id })
      })
      this.items = items
      this.itemIndex = index
    },
    relayout() {
      if (!this.doc || this.status !== 'ready') return
      this.applyScale()
      this.$nextTick(() => this.scrollToCurrent(false))
    },
    // Text size: the page is scaled as a whole (the iframe is laid out narrower and scaled up), which keeps the book's
    // own px/em proportions intact whatever units its CSS uses
    applyScale() {
      const doc = this.doc
      if (!doc || !this.bodyH) return
      let base = 16
      for (const it of this.items) {
        if (it.kind !== 'p') continue
        const fs = parseFloat(this.win.getComputedStyle(it.el).fontSize)
        if (fs >= 12 && (it.el.textContent || '').length > 120) {
          base = fs
          break
        }
      }
      const h = this.bodyH + 60
      const target = this.isTv ? Math.max(20, h * 0.045) : Math.max(17, Math.min(24, h * 0.032))
      this.scale = Math.min(3.5, Math.max(0.5, (target / base) * FONT_SCALES[this.fontLevel]))
    },

    // ---- playback following ----
    tick() {
      if (this.status !== 'ready' || !this.smil || !this.doc || this.widgetOpen) return
      if (!this.following) return
      const t = this.estimateTime()
      const smil = this.smil
      const next = this.book.timeline.peek(this.viewChapter + 1)
      const last = this.viewChapter + 1 >= this.book.chapters.length
      const outside = (this.viewChapter > 0 && t < smil.firstStart - 1) || (!last && t > smil.lastEnd + 1) || !!(next && t >= next.firstStart)
      if (outside && !this.relocating) {
        this.relocate(t)
        return
      }
      const par = findPar(smil, t)
      if (par === this.lastPar) return
      this.lastPar = par
      this.setActive(par)
    },
    async relocate(t) {
      this.relocating = true
      try {
        const idx = await this.book.timeline.chapterAt(t, this.viewChapter)
        if (idx >= 0 && idx !== this.viewChapter && this.following) await this.showChapter(idx)
      } finally {
        this.relocating = false
      }
    },
    setActive(par) {
      const doc = this.doc
      const cls = this.book.activeClass
      const old = this.wordEl
      let el = null
      if (par >= 0) el = doc.getElementById(this.smil.ids[par])
      if (old === el) return
      if (old) old.classList.remove(cls)
      this.wordEl = el
      if (!el) return
      el.classList.add(cls)
      const block = el.closest(BLOCKS)
      if (block !== this.paraEl) {
        if (this.paraEl) this.paraEl.classList.remove('abs-para-on')
        this.paraEl = block
        if (block) block.classList.add('abs-para-on')
      }
      this.keepInView(el)
    },
    keepInView(el) {
      const vh = this.win.innerHeight
      const r = el.getBoundingClientRect()
      if (r.top < vh * 0.05 || r.top > vh * 0.4 || r.bottom > vh * 0.5) this.scrollToY(this.win.scrollY + r.top - vh * 0.2, true)
    },
    scrollToCurrent(animate) {
      if (!this.win) return
      if (this.following && this.wordEl) {
        const r = this.wordEl.getBoundingClientRect()
        this.scrollToY(this.win.scrollY + r.top - this.win.innerHeight * 0.2, animate)
      } else if (this.selEl) {
        this.scrollToItemEl(this.selEl, animate)
      }
    },
    scrollToItemEl(el, animate) {
      const vh = this.win.innerHeight
      const r = el.getBoundingClientRect()
      const y = r.height > vh * 0.7 ? this.win.scrollY + r.top - vh * 0.1 : this.win.scrollY + r.top - Math.max(vh * 0.12, (vh * 0.55 - r.height) / 2)
      this.scrollToY(y, animate)
    },
    scrollToY(y, animate) {
      const win = this.win
      if (!win) return
      cancelAnimationFrame(this.scrollRaf)
      const from = win.scrollY
      const to = Math.max(0, Math.round(y))
      const dist = Math.abs(to - from)
      if (dist < 2) return
      this.autoScrolling = true
      if (!animate || dist > win.innerHeight * 2.5) {
        win.scrollTo(0, to)
        setTimeout(() => (this.autoScrolling = false), 60)
        return
      }
      const t0 = performance.now()
      const dur = 220
      const step = (now) => {
        const k = Math.min(1, (now - t0) / dur)
        win.scrollTo(0, from + (to - from) * (1 - Math.pow(1 - k, 3)))
        if (k < 1) this.scrollRaf = requestAnimationFrame(step)
        else setTimeout(() => (this.autoScrolling = false), 60)
      }
      this.scrollRaf = requestAnimationFrame(step)
    },

    // ---- browsing ----
    select(i) {
      const items = this.items
      if (!items.length) return
      i = Math.min(items.length - 1, Math.max(0, i))
      if (this.selEl) this.selEl.classList.remove('abs-sel')
      const it = items[i]
      this.selIdx = i
      this.selKind = it.kind
      this.selEl = it.el
      it.el.classList.add('abs-sel')
      this.selTime = this.itemTime(it)
      this.scrollToItemEl(it.el, true)
      this.scheduleLive()
    },
    // Book time of the first spoken word of an item (-1 if unknown)
    itemTime(it) {
      const smil = this.smil
      if (!smil || it.kind !== 'p') return -1
      const par = this.firstSpokenPar(it.el)
      return par >= 0 ? smil.starts[par] : -1
    },
    firstSpokenPar(el) {
      const spans = el.querySelectorAll('[id^="w"]')
      for (let k = 0; k < spans.length; k++) {
        if (!WORD_ID.test(spans[k].id)) continue
        const par = parForId(this.smil, spans[k].id)
        if (par >= 0) return par
      }
      return -1
    },
    async browse(delta) {
      if (!this.items.length) return
      if (this.following) {
        this.following = false
        // Start from what is being read
        let i = this.wordEl ? this.itemIndex.get(this.paraEl) : undefined
        if (i === undefined) i = Math.max(0, this.selIdx)
        if (i + delta < 0 && this.viewChapter === 0) {
          this.following = true
          this.zone = 'header'
          return
        }
        this.select(i + delta)
        return
      }
      const next = this.selIdx + delta
      if (next >= this.items.length) {
        if (this.viewChapter + 1 < this.book.chapters.length && (await this.showChapter(this.viewChapter + 1))) this.select(0)
        return
      }
      if (next < 0) {
        if (this.selIdx <= 0 && this.viewChapter > 0) {
          if (await this.showChapter(this.viewChapter - 1)) this.select(this.items.length - 1)
        } else {
          this.zone = 'header'
        }
        return
      }
      this.select(next)
    },
    resumeFollow() {
      this.following = true
      this.zone = 'list'
      if (this.selEl) this.selEl.classList.remove('abs-sel')
      this.selEl = null
      this.selIdx = -1
      this.selTime = -1
      this.lastPar = -1
      this.tick()
    },
    seekToTime(t) {
      if (!(t >= 0)) return
      this.markSeek(t)
      this.$emit('seek', t)
      this.following = true
      this.zone = 'list'
      if (this.selEl) this.selEl.classList.remove('abs-sel')
      this.selEl = null
      this.selTime = -1
      this.lastPar = -1
      this.tick()
    },
    seekToWord(el) {
      const par = parForId(this.smil, el.id)
      if (par >= 0) this.seekToTime(this.smil.starts[par])
    },
    // OK on a paragraph: play from its first spoken word (or the next spoken one when it is not in the recording)
    seekToSelected() {
      for (let i = this.selIdx; i < this.items.length; i++) {
        const it = this.items[i]
        if (it.kind !== 'p') continue
        const par = this.firstSpokenPar(it.el)
        if (par >= 0) return this.seekToTime(this.smil.starts[par])
      }
    },

    // ---- widgets ----
    scheduleLive() {
      clearTimeout(this.liveTimer)
      this.liveTimer = setTimeout(this.updateLive, 250)
    },
    // Only one widget is live at a time (TV video decoders are scarce): the one nearest to the middle of the view
    updateLive() {
      if (!this.doc || !this.vfsOk || this.widgetOpen || this.status !== 'ready') return
      const vh = this.win.innerHeight
      let best = null
      let bestD = Infinity
      this.doc.querySelectorAll('.abs-widget').forEach((w) => {
        const r = w.getBoundingClientRect()
        if (r.bottom < -vh * 0.2 || r.top > vh * 1.2) return
        const d = Math.abs((r.top + r.bottom) / 2 - vh / 2)
        if (d < bestD) {
          bestD = d
          best = w
        }
      })
      if (best === this.liveWrap) return
      if (this.liveWrap) this.stopLive(this.liveWrap)
      this.liveWrap = best
      if (best) this.startLive(best)
    },
    startLive(wrap) {
      const spec = this.widgets[parseInt(wrap.getAttribute('data-abs-w'), 10)]
      if (!spec) return
      const doc = this.doc
      const thumb = wrap.querySelector('img.abs-w-thumb')
      // The frame is sized from the thumbnail, so wait for it (images arrive lazily)
      if (thumb && !(thumb.complete && thumb.naturalWidth)) {
        thumb.addEventListener('load', () => this.liveWrap === wrap && this.startLive(wrap), { once: true })
        return
      }
      const w = spec.stageW || 1024
      const h = spec.stageH || 768
      if (!thumb) {
        wrap.style.width = Math.min(w, wrap.parentElement ? wrap.parentElement.clientWidth : w) + 'px'
        wrap.style.aspectRatio = `${w} / ${h}`
      }
      const f = doc.createElement('iframe')
      f.className = 'abs-w-live'
      f.setAttribute('tabindex', '-1')
      f.setAttribute('allow', 'autoplay')
      f.setAttribute('title', spec.title || 'widget')
      // The thumbnail is a crop of the stage: scale the stage to cover the placeholder and centre it
      const ww = wrap.clientWidth
      const wh = wrap.clientHeight
      const k = Math.max(ww / w, wh / h)
      f.style.width = w + 'px'
      f.style.height = h + 'px'
      f.style.transform = `scale(${k})`
      f.style.left = (ww - w * k) / 2 + 'px'
      f.style.top = (wh - h * k) / 2 + 'px'
      f.style.opacity = '0'
      f.addEventListener('load', () => (f.style.opacity = '1'))
      f.src = vfsUrl(this.sid, spec.bundle + '/' + spec.start, 'muted')
      wrap.appendChild(f)
    },
    stopLive(wrap) {
      const f = wrap.querySelector('iframe.abs-w-live')
      if (f) {
        f.src = 'about:blank'
        f.remove()
      }
    },
    openWidget(index) {
      const spec = this.widgets[index]
      if (!spec || this.widgetOpen) return
      const wrap = this.doc.querySelector(`.abs-widget[data-abs-w="${index}"]`)
      const thumb = wrap && wrap.querySelector('img.abs-w-thumb')
      if (this.liveWrap) {
        this.stopLive(this.liveWrap)
        this.liveWrap = null
      }
      // The audiobook pauses while a widget plays its own sound; it resumes on close
      this.wasPlayingBeforeWidget = this.isPlaying
      if (this.isPlaying) this.$emit('toggle-play')
      const w = spec.stageW || 1024
      const h = spec.stageH || 768
      this.pointer = { x: w / 2, y: h / 2 }
      this.widgetOpen = { index, w, h, src: this.vfsOk ? vfsUrl(this.sid, spec.bundle + '/' + spec.start, 'live') : '', thumb: thumb ? thumb.getAttribute('src') : '' }
      this.$nextTick(() => this.$refs.root && this.$refs.root.focus({ preventScroll: true }))
    },
    closeWidget() {
      const o = this.widgetOpen
      if (!o) return
      try {
        const f = this.$refs.wframe
        if (f && f.contentWindow) f.contentWindow.postMessage({ abs: 'exit' }, '*')
      } catch (e) {
        // frame already gone
      }
      this.widgetOpen = null
      if (this.wasPlayingBeforeWidget && !this.isPlaying) this.$emit('toggle-play')
      this.wasPlayingBeforeWidget = false
      this.$nextTick(() => {
        this.$refs.root && this.$refs.root.focus({ preventScroll: true })
        this.scheduleLive()
      })
    },
    onWidgetLoad() {
      const f = this.$refs.wframe
      if (!f || !f.contentWindow) return
      f.contentWindow.postMessage({ abs: 'mute', value: false }, '*')
      f.contentWindow.postMessage({ abs: 'enter' }, '*')
      // Keep D-pad focus in the reader, the frame would swallow the keys
      this.$refs.root && this.$refs.root.focus({ preventScroll: true })
    },
    onWindowMessage(e) {
      const d = e.data
      if (d && d.abs === 'back' && this.widgetOpen) this.closeWidget()
    },
    movePointer(dx, dy) {
      const o = this.widgetOpen
      const step = Math.max(o.w, o.h) / 36
      const now = performance.now()
      // Held keys accelerate
      this.pointerStreak = now - (this.pointerAt || 0) < 160 ? Math.min(6, (this.pointerStreak || 1) + 0.4) : 1
      this.pointerAt = now
      this.pointer = { x: Math.min(o.w - 2, Math.max(2, this.pointer.x + dx * step * this.pointerStreak)), y: Math.min(o.h - 2, Math.max(2, this.pointer.y + dy * step * this.pointerStreak)) }
    },
    // OK inside a widget: a tap at the pointer, sent as touch (when the page listens to it) and mouse events
    tapWidget() {
      const f = this.$refs.wframe
      const doc = f && f.contentDocument
      const win = f && f.contentWindow
      if (!doc || !win) return
      const { x, y } = this.pointer
      const el = doc.elementFromPoint(x, y) || doc.body
      const base = { bubbles: true, cancelable: true, view: win, clientX: x, clientY: y, screenX: x, screenY: y }
      let prevented = false
      try {
        if ('ontouchend' in win && win.Touch && win.TouchEvent) {
          const touch = new win.Touch({ identifier: 1, target: el, clientX: x, clientY: y, pageX: x, pageY: y })
          const t1 = new win.TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [touch], targetTouches: [touch], changedTouches: [touch] })
          el.dispatchEvent(t1)
          const t2 = new win.TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [touch] })
          el.dispatchEvent(t2)
          prevented = t1.defaultPrevented || t2.defaultPrevented
        }
      } catch (e) {
        // synthetic touch events are not available: mouse events below
      }
      if (!prevented) {
        for (const type of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new win.MouseEvent(type, { ...base, button: 0, buttons: type === 'mousedown' ? 1 : 0 }))
      }
    },

    // ---- font ----
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

    // ---- search over the whole book text ----
    toggleSearch() {
      if (this.searchOpen) return this.closeSearch()
      this.searchOpen = true
      this.$nextTick(() => this.$refs.searchInput && this.$refs.searchInput.focus())
    },
    closeSearch() {
      const at = this.headerButtons.findIndex((b) => b.id === 'search')
      if (this.zone === 'header' && this.headerIdx > at) this.headerIdx = at
      this.searchOpen = false
      this.searchFocused = false
      this.query = ''
      this.matchCount = 0
      this.matchPos = -1
      this.searchResults = []
      if (this.findEl) this.findEl.classList.remove('abs-find')
      this.findEl = null
    },
    scheduleSearch() {
      clearTimeout(this.searchTimer)
      this.searchTimer = setTimeout(this.runSearch, 300)
    },
    // Word list of one chapter straight from the XHTML source: [{id, text}] + the joined lower-case text
    async chapterIndex(i) {
      if (!this.searchIndex) this.searchIndex = []
      if (this.searchIndex[i]) return this.searchIndex[i]
      const raw = await this.book.text(this.book.chapters[i].href)
      const ids = []
      const offsets = []
      let text = ''
      const re = /<span\b[^>]*\bid=["'](w\d+)["'][^>]*>([\s\S]*?)<\/span>/g
      let m
      while ((m = re.exec(raw))) {
        const word = decodeEntities(m[2].replace(/<[^>]+>/g, '')).trim()
        if (!word) continue
        offsets.push(text.length)
        ids.push(m[1])
        text += word.toLowerCase() + ' '
      }
      return (this.searchIndex[i] = { ids, offsets, text })
    },
    async runSearch() {
      clearTimeout(this.searchTimer)
      const q = this.query.toLowerCase().replace(/\s+/g, ' ').trim()
      this.searchResults = []
      this.matchCount = 0
      this.matchPos = -1
      if (!q || !this.book) return
      const token = (this.searchToken = (this.searchToken || 0) + 1)
      this.searchBusy = true
      try {
        const n = this.book.chapters.length
        const results = []
        for (let k = 0; k < n && results.length < MAX_MATCHES; k++) {
          const ch = (this.viewChapter + k) % n
          const idx = await this.chapterIndex(ch)
          if (token !== this.searchToken) return
          let from = 0
          for (;;) {
            const at = idx.text.indexOf(q, from)
            if (at < 0 || results.length >= MAX_MATCHES) break
            from = at + 1
            // word that holds the match start
            let lo = 0
            let hi = idx.offsets.length - 1
            while (lo < hi) {
              const mid = (lo + hi + 1) >> 1
              if (idx.offsets[mid] <= at) lo = mid
              else hi = mid - 1
            }
            results.push({ ch, id: idx.ids[lo] })
          }
          if (k === 0 && results.length) {
            // Jump to the first hit as soon as the current chapter is searched
            this.searchResults = results.slice()
            this.matchCount = results.length
            if (this.matchPos < 0) this.gotoMatch(0)
          }
          await new Promise((r) => setTimeout(r, 0))
        }
        if (token !== this.searchToken) return
        this.searchResults = results
        this.matchCount = results.length
        if (this.matchPos < 0 && results.length) this.gotoMatch(0)
      } catch (e) {
        console.error('[book] search failed', e)
      } finally {
        if (token === this.searchToken) this.searchBusy = false
      }
    },
    async gotoMatch(pos) {
      const list = this.searchResults
      if (!list.length) return
      pos = (pos + list.length) % list.length
      this.matchPos = pos
      const m = list[pos]
      this.following = false
      this.zone = 'list'
      if (m.ch !== this.viewChapter) {
        if (!(await this.showChapter(m.ch))) return
      }
      if (pos !== this.matchPos) return // a newer jump superseded this one
      const el = this.doc.getElementById(m.id)
      if (!el) return
      if (this.findEl) this.findEl.classList.remove('abs-find')
      this.findEl = el
      el.classList.add('abs-find')
      const block = el.closest(BLOCKS)
      const i = this.itemIndex.get(block)
      if (i !== undefined) this.select(i)
    },

    // ---- input ----
    back() {
      const now = Date.now()
      if (now - this.lastBackAt < 250) return
      this.lastBackAt = now
      if (this.widgetOpen) return this.closeWidget()
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
     * Key map (same as the transcript view):
     *   text    Up / Down      previous / next paragraph (or widget); Up on the first one moves to the header
     *           Left / Right   move focus to the header button row
     *           OK             following: play / pause; browsing: play from the paragraph / open the widget
     *   header  Left / Right   previous / next button, OK activates, Down returns to the text
     *   widget  arrows move a pointer, OK taps, Back closes and resumes the audiobook
     */
    onKeyDown(e) {
      const k = e.key
      const isBack = k === 'Escape' || k === 'GoBack' || e.keyCode === 4
      if (this.widgetOpen) {
        if (isBack) {
          this.consume(e)
          this.back()
        } else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(k)) {
          this.consume(e)
          if (k === 'Enter') this.tapWidget()
          else this.movePointer(k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : 0, k === 'ArrowUp' ? -1 : k === 'ArrowDown' ? 1 : 0)
        }
        return
      }
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
        return
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
          if (this.searchOpen && !this.query && this.$refs.searchInput) this.$refs.searchInput.focus()
          else this.zone = 'list'
        } else if (k === 'Enter') this.activateButton(this.headerIdx)
        return
      }

      if (this.status !== 'ready') {
        if (k === 'ArrowUp' || k === 'ArrowLeft' || k === 'ArrowRight') this.zone = 'header'
        return
      }
      if (k === 'ArrowDown') this.browse(1)
      else if (k === 'ArrowUp') {
        this.browse(-1)
      } else if (k === 'ArrowLeft' || k === 'ArrowRight') {
        this.zone = 'header'
      } else if (k === 'Enter') {
        if (this.following) this.$emit('toggle-play')
        else if (this.selKind === 'widget') this.openWidget(this.items[this.selIdx].widget)
        else this.seekToSelected()
      }
    }
  }
}
</script>

<style scoped>
.book-reader {
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
.tr-hint {
  font-size: 0.75rem;
  opacity: 0.55;
  text-align: center;
}
.bk-body {
  background: #fcfbf7;
}
.bk-frame {
  position: absolute;
  left: 0;
  top: 0;
  border: 0;
  transform-origin: 0 0;
  background: #fcfbf7;
}
.bk-frame-hidden {
  visibility: hidden;
}
.bk-overlay {
  background: rgba(20, 20, 20, 0.92);
}
.bk-chapter-busy {
  position: absolute;
  right: 1rem;
  top: 1rem;
  padding: 0.4rem;
  border-radius: 9999px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
}
.bk-wfull {
  position: absolute;
  inset: 0;
  z-index: 50;
  background: #000;
}
.bk-wstage {
  position: absolute;
  left: 50%;
  top: calc(50% - 10px);
  transform-origin: 50% 50%;
  background: #fff;
}
.bk-wframe {
  width: 100%;
  height: 100%;
  border: 0;
  background: #fff;
}
.bk-wthumb {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.bk-pointer {
  position: absolute;
  width: 26px;
  height: 26px;
  margin: -13px 0 0 -13px;
  border-radius: 50%;
  border: 3px solid #fff;
  background: rgba(26, 214, 145, 0.7);
  box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.6);
  pointer-events: none;
}
.bk-whint {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0.4rem;
  text-align: center;
  font-size: 0.75rem;
  color: #fff;
  opacity: 0.6;
}
</style>

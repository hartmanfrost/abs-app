<template>
  <div class="tr-block" :class="blockClass" :data-b="index" @click.stop="onClick">
    <template v-for="ci in cueList"
      ><span :key="ci" class="tr-s" :class="sentenceClass(ci)" :data-c="ci"
        ><span v-for="(seg, si) in segsFor(ci)" :key="si" :class="segClass(seg, ci)">{{ seg.w }}</span></span
      >{{ ci === block.last ? '' : ' ' }}</template
    >
  </div>
</template>

<script>
import { FLAG_ITALIC, FLAG_BOLD, FLAG_UNDERLINE, FLAG_UNSPOKEN } from '@/utils/transcript'

/**
 * One display block of the transcript: a paragraph (sentences flowing inline), a chapter heading or,
 * for legacy transcripts, a single cue. Kept as its own component so that a playback tick only
 * re-renders the one block that holds the current sentence.
 */
export default {
  props: {
    cues: { type: Array, required: true },
    block: { type: Object, required: true },
    index: { type: Number, required: true },
    // Index of the current cue when it lies inside this block, otherwise -1
    activeCue: { type: Number, default: -1 },
    // Index of the spoken word being read inside the active cue, otherwise -1
    wordIdx: { type: Number, default: -1 },
    // The block the D-pad cursor is on (browse mode)
    selected: Boolean,
    matchSet: { type: Set, default: null }
  },
  computed: {
    cueList() {
      const out = []
      for (let i = this.block.first; i <= this.block.last; i++) out.push(i)
      return out
    },
    blockClass() {
      return {
        'tr-heading': this.block.kind === 'h',
        'tr-para': this.block.kind === 'p',
        'tr-legacy': this.block.kind === 'cue',
        'tr-active': this.activeCue >= 0,
        'tr-selected': this.selected
      }
    }
  },
  methods: {
    segsFor(ci) {
      const cue = this.cues[ci]
      if (cue.segs) return cue.segs
      if (ci === this.activeCue && cue.words) return cue.words.map((w, k) => ({ w: w.w, f: 0, k }))
      return [{ w: cue.text, f: 0, k: -1 }]
    },
    sentenceClass(ci) {
      return {
        'tr-cur': ci === this.activeCue,
        'tr-match': !!this.matchSet && this.matchSet.has(ci)
      }
    },
    segClass(seg, ci) {
      const f = seg.f
      const c = []
      if (f & FLAG_ITALIC) c.push('tr-i')
      if (f & FLAG_BOLD) c.push('tr-b')
      if (f & FLAG_UNDERLINE) c.push('tr-u')
      if (f & FLAG_UNSPOKEN) c.push('tr-un')
      // Unspoken runs have k = -1 and are therefore never highlighted
      if (ci === this.activeCue && seg.k >= 0) c.push(seg.k < this.wordIdx ? 'tr-word-done' : seg.k === this.wordIdx ? 'tr-word-now' : 'tr-word-todo')
      return c
    },
    onClick(e) {
      const el = e.target && e.target.closest ? e.target.closest('[data-c]') : null
      this.$emit('pick', el ? parseInt(el.getAttribute('data-c'), 10) : this.block.first)
    }
  }
}
</script>

<style scoped>
.tr-block {
  margin: 0 0 0.75em;
  padding: 0.15em 0.6em;
  line-height: 1.5;
  color: rgba(255, 255, 255, 0.62);
  border-left: 0.2em solid transparent;
  border-radius: 0.2em;
  overflow-wrap: anywhere;
}
.tr-para {
  text-indent: 1.6em;
  white-space: pre-line; /* keep deliberate line breaks (letters, poems) */
}
.tr-heading {
  margin: 1.4em 0 1em;
  text-align: center;
  font-size: 1.3em;
  font-weight: 700;
  letter-spacing: 0.04em;
  white-space: pre-line;
}
.tr-legacy {
  margin: 0;
  padding: 0.35em 0.6em;
  line-height: 1.4;
  opacity: 0.45;
  color: #fff;
}
.tr-legacy.tr-active {
  opacity: 1;
}
.tr-active {
  color: #fff;
}
.tr-selected {
  border-left-color: var(--tv-focus-color, #1ad691);
  background: rgba(255, 255, 255, 0.08);
}
.tr-legacy.tr-selected {
  opacity: 0.95;
}
.tr-s {
  border-radius: 0.2em;
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
}
.tr-para .tr-cur,
.tr-heading .tr-cur {
  background: rgba(255, 255, 255, 0.11);
}
.tr-i {
  font-style: italic;
}
.tr-b {
  font-weight: 700;
}
.tr-u {
  text-decoration: underline;
}
.tr-un {
  opacity: 0.5; /* book words that are not heard in the recording: visible but secondary */
}
.tr-match {
  text-decoration: underline;
  text-decoration-color: rgba(255, 213, 79, 0.9);
}
.tr-word-todo {
  opacity: 0.88;
}
.tr-legacy .tr-word-todo {
  opacity: 0.55;
}
.tr-word-done {
  opacity: 1;
}
.tr-word-now {
  opacity: 1;
  color: #0b0b0b;
  background: var(--tv-focus-color, #1ad691);
  border-radius: 0.15em;
  box-shadow: 0 0 0 0.08em var(--tv-focus-color, #1ad691);
}
.tr-legacy .tr-word-now {
  color: var(--tv-focus-color, #1ad691);
  background: none;
  box-shadow: none;
}
/*
 * Night mode (the .tr-night class sits on the Transcript view root). Solid colours instead of opacity so every
 * state stays >= 7:1 on pure black: idle text #b0b0b0, unspoken #9a9a9a, current block #e6e6e6, the word being
 * read is black on amber.
 */
.tr-night .tr-block {
  color: #b0b0b0;
}
.tr-night .tr-heading {
  color: #e6e6e6;
}
.tr-night .tr-active {
  color: #e6e6e6;
}
.tr-night .tr-legacy {
  opacity: 1;
  color: #a8a8a8;
}
.tr-night .tr-legacy.tr-active {
  color: #e6e6e6;
}
.tr-night .tr-selected {
  border-left-color: #ffd54a;
  background: rgba(255, 255, 255, 0.12);
}
.tr-night .tr-para .tr-cur,
.tr-night .tr-heading .tr-cur {
  background: rgba(255, 190, 0, 0.22);
}
.tr-night .tr-un {
  opacity: 1;
  color: #9a9a9a;
}
.tr-night .tr-match {
  text-decoration-color: #ffd54a;
  text-decoration-thickness: 0.12em;
}
.tr-night .tr-legacy .tr-word-todo {
  opacity: 1;
  color: #b0b0b0;
}
.tr-night .tr-word-now {
  color: #000;
  background: #ffd54a;
  box-shadow: 0 0 0 0.08em #ffd54a;
}
.tr-night .tr-legacy .tr-word-now {
  color: #ffd54a;
  background: none;
  box-shadow: none;
}
</style>

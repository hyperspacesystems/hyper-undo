// Every listener sits on the scope root, in the capture phase: typing only ever happens
// inside it, and the window keeps only the history key bindings.
// A sentence end, a field switch, a change of intent, a command, a replaced
// selection and a caret jump each close the open typing step, so one undo press
// undoes one sentence of typing. The idle timer never closes a step while an
// input method composition is open.

const SENTENCE_END = /[.?!]["'\u201D\u2019)\]]*$/
const LINE_BREAKS = new Set(['insertParagraph', 'insertLineBreak'])
const ALONE = new Set([
  'insertFromPaste',
  'insertFromDrop',
  'insertFromYank',
  'insertReplacementText',
  'deleteByCut',
  'deleteByDrag',
])
const TYPING_KEYS = new Set(['Enter', 'Backspace', 'Delete'])
const NAV_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
])

export function endsSentence(textBefore) {
  return SENTENCE_END.test(textBefore)
}

export function watchTyping(root, { sentence, endStep, stepOpen = () => true, composing }) {
  const view = root.ownerDocument && root.ownerDocument.defaultView
  if (!view) return () => {}
  const inside = (node) => !!node && typeof node.nodeType === 'number' && (node === root || root.contains(node))
  let breakAfter = false
  let jumped = false
  let early = false
  let last = { kind: 'other', host: null }

  const kindOf = (type) => ALONE.has(type) || type.startsWith('format') ? 'alone'
    : type.startsWith('delete') ? 'delete'
    : type.startsWith('insert') ? 'insert' : 'other'

  const hostOf = (target) => {
    if (!target) return null
    const el = target.nodeType === 1 ? target : target.parentElement
    const host = el && el.closest && el.closest('[contenteditable]:not([contenteditable="false"])')
    return host || target
  }

  // A rich editor may cancel the line break and insert the paragraph itself, so
  // no input event follows: the timer closes the step either way, and the flush
  // takes the pending records synchronously.
  const closeAfter = () => {
    if (!breakAfter) return
    breakAfter = false
    endStep()
  }

  const onBeforeInput = (event) => {
    if (!sentence || event.isComposing || !inside(event.target)) return
    const type = event.inputType || ''
    const kind = kindOf(type)
    const host = hostOf(event.target)
    const selection = view.getSelection && view.getSelection()
    const collapsed = !selection || selection.isCollapsed
    const wasJumped = jumped
    jumped = false
    const wasEarly = early
    early = false
    if (
      kind === 'alone' ||
      (!wasEarly && kind !== last.kind && kind !== 'other' && last.kind !== 'other') ||
      (!wasEarly && ((last.host !== null && host !== last.host) || !collapsed || wasJumped))
    ) {
      endStep()
    }
    last = { kind, host }
    if (kind === 'alone') {
      breakAfter = true
      setTimeout(closeAfter, 0)
      return
    }
    const space = type === 'insertText' && (event.data === ' ' || event.data === '\u00A0')
    if (!space && !LINE_BREAKS.has(type)) return
    if (space && !stepOpen()) return
    if (!endsSentence(textBeforeCaret(view))) return
    breakAfter = true
    setTimeout(closeAfter, 0)
  }
  const onInput = (event) => { if (inside(event.target)) closeAfter() }
  const onStart = (event) => { if (inside(event.target)) composing(true) }
  const onEnd = (event) => { if (inside(event.target)) composing(false) }
  const onPointerDown = (event) => { if (inside(event.target)) jumped = true }
  // A rich editor may write in its own keydown, before beforeinput: it deletes the
  // selection the key replaces, and it tidies its markup on the first key. A caret jump,
  // a field switch and a replaced selection close the step here, so those writes belong
  // to the step the key starts.
  const onKeyDown = (event) => {
    if (!inside(event.target)) return
    if (NAV_KEYS.has(event.key)) { jumped = true; return }
    if (!sentence || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey) return
    if (!event.key || (event.key.length !== 1 && !TYPING_KEYS.has(event.key))) return
    const selection = view.getSelection && view.getSelection()
    const switched = last.host !== null && hostOf(event.target) !== last.host
    if (!jumped && !switched && (!selection || selection.isCollapsed)) return
    endStep()
    jumped = false
    early = true
    setTimeout(() => { early = false }, 0)
  }
  root.addEventListener('beforeinput', onBeforeInput, true)
  root.addEventListener('input', onInput, true)
  root.addEventListener('compositionstart', onStart, true)
  root.addEventListener('compositionend', onEnd, true)
  root.addEventListener('pointerdown', onPointerDown, true)
  root.addEventListener('keydown', onKeyDown, true)
  return () => {
    root.removeEventListener('beforeinput', onBeforeInput, true)
    root.removeEventListener('input', onInput, true)
    root.removeEventListener('compositionstart', onStart, true)
    root.removeEventListener('compositionend', onEnd, true)
    root.removeEventListener('pointerdown', onPointerDown, true)
    root.removeEventListener('keydown', onKeyDown, true)
  }
}

function textBeforeCaret(view) {
  const selection = view.getSelection && view.getSelection()
  if (!selection || !selection.isCollapsed || !selection.anchorNode) return ''
  const anchor = selection.anchorNode
  const element = anchor.nodeType === 1 ? anchor : anchor.parentElement
  const host = element && element.closest('[contenteditable]:not([contenteditable="false"])')
  if (!host) return ''
  const range = host.ownerDocument.createRange()
  range.setStart(host, 0)
  range.setEnd(anchor, selection.anchorOffset)
  return range.toString().replace(/\u200B/g, '').slice(-8)
}

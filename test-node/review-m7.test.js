import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeDom, tick } from './_setup.js'
import { createScope } from '../src/scope.js'
import { installKeys } from '../src/keys.js'
import undoModule from '../src/index.js'

// Findings from the M7 code review. Each case is a probe the review ran on the
// engine source; the fix makes it pass.

const read = (el) => el.innerHTML
const write = (el, html) => { el.innerHTML = html }

const PAGE = '<!DOCTYPE html><html><head><title>T</title></head><body>' +
  '<div id="ck" class="ck-editor__editable" contenteditable="true"><p>Ck</p></div>' +
  '<div id="lexical" data-lexical-editor contenteditable="true"><p>Lex</p></div>' +
  '<p id="side">Side</p>' +
  '<div id="field" contenteditable="true"><p>One</p><p>Two</p></div>' +
  '</body></html>'

function page(opts = {}) { return makePage(PAGE, opts) }

function makePage(html, opts = {}) {
  const dom = makeDom(html)
  const doc = dom.window.document
  const scope = createScope({
    scope: doc.body,
    idleWindowMs: 60_000,
    shadowKeydownIn: undoModule.defaults.shadowKeydownIn,
    ...opts,
  })
  scope.start()
  const cleanup = installKeys(scope)
  return { dom, doc, scope, cleanup }
}

function press(dom, el, init = { key: 'z', metaKey: true }) {
  const event = new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  el.dispatchEvent(event)
  return event
}

function seed(doc, scope) {
  scope.commit('Rename', () => { doc.getElementById('side').firstChild.data = 'Renamed' })
}

// Opus 2: a third-party editor inside the page keeps its own Cmd+Z.
test('a Cmd+Z inside an embedded third-party editor is left to that editor', () => {
  for (const id of ['ck', 'lexical']) {
    const { dom, doc, scope, cleanup } = page({ editableKeys: 'page' })
    seed(doc, scope)
    const event = press(dom, doc.getElementById(id))
    assert.equal(event.defaultPrevented, false, `${id}: the key belongs to the editor`)
    assert.equal(scope.history.length, 1)
    assert.equal(doc.getElementById('side').textContent, 'Renamed', `${id}: no earlier field was reverted`)
    cleanup()
    scope.stop()
  }
})

// Opus 3: a tracked root's own removals are never "removed from the scope".
test('a tracked root: changing a line and removing it in one batch undoes in one press', async () => {
  const { doc, scope } = page()
  const field = doc.getElementById('field')
  scope.trackContent(field, { read, write })
  const second = field.querySelectorAll('p')[1]
  second.firstChild.data = 'Changed'
  second.remove()
  await tick(5)
  scope.flush()
  const undone = scope.undo()
  assert.deepEqual([undone.ok, undone.code], [true, undefined])
  assert.equal(field.innerHTML, '<p>One</p><p>Two</p>')
  scope.stop()
})

// Opus 4: a kind switch after an early boundary does not close the step twice.
const RICH = '<!DOCTYPE html><html><head><title>T</title></head><body>' +
  '<div id="rich" contenteditable="true"><p id="line">One two three</p></div>' +
  '</body></html>'

test('a rich field: typing over a selection right after a deletion makes one step', async () => {
  const { dom, doc, scope } = makePage(RICH, { typingBreak: 'sentence' })
  const rich = doc.getElementById('rich')
  const line = doc.getElementById('line')
  const node = line.firstChild
  const InputEvent = dom.window.InputEvent

  doc.getSelection().collapse(node, node.data.length)
  rich.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'deleteContentBackward' }))
  node.deleteData(node.data.length - 1, 1)
  doc.getSelection().collapse(node, node.data.length)
  rich.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }))
  await tick(2)

  rich.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }))
  doc.getSelection().setBaseAndExtent(node, 4, node, 7)
  rich.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'X' }))
  node.deleteData(4, 3)
  doc.getSelection().collapse(node, 4)
  for (let at = 0; at < 4; at++) await Promise.resolve()
  rich.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: 'X' }))
  node.insertData(4, 'X')
  doc.getSelection().collapse(node, 5)
  rich.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'X' }))
  await tick(2)
  scope.flush()

  const states = []
  while (scope.canUndo) { scope.undo(); states.push(line.textContent) }
  assert.deepEqual(states, ['One two thre', 'One two three'], 'one press takes back the whole replacement')
  scope.stop()
})

// Opus 5: a merged rich step that only swaps a space for a non-breaking space is no step.
const SPACED = '<!DOCTYPE html><html><head><title>T</title></head><body>' +
  '<div id="field" contenteditable="true"><p>Hello world</p></div>' +
  '</body></html>'

test('a tracked root: a step that only swaps a space for a non-breaking space makes no entry', async () => {
  const { doc, scope } = makePage(SPACED)
  const field = doc.getElementById('field')
  scope.trackContent(field, { read, write })
  const node = field.querySelector('p').firstChild
  node.data = 'Hello Xworld'
  await tick(5)
  node.data = 'Hello\u00A0world'
  await tick(5)
  scope.flush()
  assert.equal(scope.history.length, 0)
  scope.stop()
})

// Astra 2: commands mode records no typing, so it claims no tracked root's keys.
test('commands mode: a Cmd+Z inside a tracked root is left to the editor', () => {
  const { dom, doc, scope, cleanup } = page({ editableKeys: 'page' })
  scope.setRecording('commands')
  const field = doc.getElementById('field')
  scope.trackContent(field, { read, write })
  const event = press(dom, field.querySelector('p'))
  assert.equal(event.defaultPrevented, false)
  cleanup()
  scope.stop()
})

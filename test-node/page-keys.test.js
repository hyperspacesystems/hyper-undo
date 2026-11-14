import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeDom } from './_setup.js'
import { createScope } from '../src/scope.js'
import { installKeys } from '../src/keys.js'
import undoModule from '../src/index.js'

// With `editableKeys: 'page'` a history key or a history input event inside
// editable content goes to the page history instead of the browser's own
// per-field undo. Form controls, IME compositions and regions the filter does
// not record keep the browser's undo. With the default nothing changes.

const PAGE = '<!DOCTYPE html><html><head><title>T</title></head><body>' +
  '<p id="plain" contenteditable="plaintext-only">Start</p>' +
  '<div id="rich" no-undo contenteditable="true"><p>Rich</p></div>' +
  '<div id="authored" no-undo><p id="own" contenteditable="true">Own</p></div>' +
  '<div class="ProseMirror blockeditor-editor" contenteditable="true" id="article"><p>Article</p></div>' +
  '<div class="ProseMirror" contenteditable="true" id="other"><p>Other</p></div>' +
  '<input id="input" value="x">' +
  '<textarea id="textarea">y</textarea>' +
  '<p id="side">Side</p>' +
  '</body></html>'

const PAGE_KEYS = { editableKeys: 'page', ownKeysIn: ['.blockeditor-editor'] }

function page(opts = {}) {
  const dom = makeDom(PAGE)
  const doc = dom.window.document
  const scope = createScope({ scope: doc.body, idleWindowMs: 60_000, shadowKeydownIn: undoModule.defaults.shadowKeydownIn, ...opts })
  scope.start()
  const cleanup = installKeys(scope)
  const rich = doc.getElementById('rich')
  scope.trackContent(rich, { read: (el) => el.innerHTML, write: (el, html) => { el.innerHTML = html } })
  return { dom, doc, scope, cleanup }
}

function press(dom, el, init = { key: 'z', metaKey: true }) {
  const event = new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  el.dispatchEvent(event)
  return event
}

function historyInput(dom, el, inputType = 'historyUndo', extra = {}) {
  const event = new dom.window.InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType, ...extra })
  el.dispatchEvent(event)
  return event
}

function seed(doc, scope) {
  scope.commit('Rename', () => { doc.getElementById('side').firstChild.data = 'Renamed' })
}

test('default options: Cmd+Z in a contenteditable field is left alone', () => {
  const { dom, doc, scope, cleanup } = page()
  seed(doc, scope)
  const event = press(dom, doc.getElementById('plain'))
  assert.equal(event.defaultPrevented, false)
  assert.equal(scope.history.length, 1)
  assert.equal(doc.getElementById('side').textContent, 'Renamed')
  cleanup()
  scope.stop()
})

test("'page': Cmd+Z in a plain contenteditable field undoes and never reaches a document listener", () => {
  const { dom, doc, scope, cleanup } = page(PAGE_KEYS)
  seed(doc, scope)
  let reached = false
  doc.addEventListener('keydown', () => { reached = true }, true)
  const event = press(dom, doc.getElementById('plain'))
  assert.equal(event.defaultPrevented, true)
  assert.equal(reached, false)
  assert.equal(scope.history.length, 0)
  assert.equal(doc.getElementById('side').textContent, 'Side')
  cleanup()
  scope.stop()
})

test("'page': Cmd+Shift+Z and Ctrl+Y in the same field redo", () => {
  const { dom, doc, scope, cleanup } = page(PAGE_KEYS)
  seed(doc, scope)
  press(dom, doc.getElementById('plain'))
  assert.equal(scope.history.length, 0)
  const shiftZ = press(dom, doc.getElementById('plain'), { key: 'z', metaKey: true, shiftKey: true })
  assert.equal(shiftZ.defaultPrevented, true)
  assert.equal(doc.getElementById('side').textContent, 'Renamed')
  press(dom, doc.getElementById('plain'))
  const ctrlY = press(dom, doc.getElementById('plain'), { key: 'y', ctrlKey: true })
  assert.equal(ctrlY.defaultPrevented, true)
  assert.equal(doc.getElementById('side').textContent, 'Renamed')
  cleanup()
  scope.stop()
})

test("'page': Cmd+Z in an input and in a textarea is left to the browser", () => {
  for (const id of ['input', 'textarea']) {
    const { dom, doc, scope, cleanup } = page(PAGE_KEYS)
    seed(doc, scope)
    const event = press(dom, doc.getElementById(id))
    assert.equal(event.defaultPrevented, false, id)
    assert.equal(scope.history.length, 1, id)
    cleanup()
    scope.stop()
  }
})

test("'page': Cmd+Z in a contenteditable inside [no-undo] is left alone", () => {
  const { dom, doc, scope, cleanup } = page(PAGE_KEYS)
  seed(doc, scope)
  const event = press(dom, doc.getElementById('own'))
  assert.equal(event.defaultPrevented, false)
  assert.equal(scope.history.length, 1)
  cleanup()
  scope.stop()
})

test("'page': Cmd+Z inside a tracked root that carries no-undo is the page's", () => {
  const { dom, doc, scope, cleanup } = page(PAGE_KEYS)
  seed(doc, scope)
  const event = press(dom, doc.getElementById('rich').firstChild)
  assert.equal(event.defaultPrevented, true)
  assert.equal(scope.history.length, 0)
  cleanup()
  scope.stop()
})

test("'page': another ProseMirror keeps the key, ownKeysIn takes it back", () => {
  const plain = page(PAGE_KEYS)
  seed(plain.doc, plain.scope)
  assert.equal(press(plain.dom, plain.doc.getElementById('other')).defaultPrevented, false)
  assert.equal(plain.scope.history.length, 1)
  plain.cleanup()
  plain.scope.stop()

  const owned = page(PAGE_KEYS)
  seed(owned.doc, owned.scope)
  const event = press(owned.dom, owned.doc.getElementById('article'))
  assert.equal(event.defaultPrevented, true)
  assert.equal(owned.scope.history.length, 0)
  owned.cleanup()
  owned.scope.stop()
})

test("'page': a composing key and a keyCode 229 key are left alone", () => {
  const { dom, doc, scope, cleanup } = page(PAGE_KEYS)
  seed(doc, scope)
  assert.equal(press(dom, doc.getElementById('plain'), { key: 'z', metaKey: true, isComposing: true }).defaultPrevented, false)
  assert.equal(press(dom, doc.getElementById('plain'), { key: 'z', metaKey: true, keyCode: 229 }).defaultPrevented, false)
  assert.equal(historyInput(dom, doc.getElementById('plain'), 'historyUndo', { isComposing: true }).defaultPrevented, false)
  assert.equal(scope.history.length, 1)
  cleanup()
  scope.stop()
})

test("'page': the browser history input is owned in a field and redoes too", () => {
  const { dom, doc, scope, cleanup } = page(PAGE_KEYS)
  seed(doc, scope)
  const undo = historyInput(dom, doc.getElementById('plain'), 'historyUndo')
  assert.equal(undo.defaultPrevented, true)
  assert.equal(scope.history.length, 0)
  const redo = historyInput(dom, doc.getElementById('plain'), 'historyRedo')
  assert.equal(redo.defaultPrevented, true)
  assert.equal(scope.history.length, 1)
  cleanup()
  scope.stop()
})

test("'page': the history input is left alone in an input and not listened to by default", () => {
  const a = page(PAGE_KEYS)
  seed(a.doc, a.scope)
  assert.equal(historyInput(a.dom, a.doc.getElementById('input')).defaultPrevented, false)
  assert.equal(a.scope.history.length, 1)
  a.cleanup()
  a.scope.stop()

  const b = page()
  seed(b.doc, b.scope)
  assert.equal(historyInput(b.dom, b.doc.getElementById('plain')).defaultPrevented, false)
  assert.equal(b.scope.history.length, 1)
  b.cleanup()
  b.scope.stop()
})

test('holdReplay: undo is held, the stack and the document stay, and the key is still claimed', () => {
  const { dom, doc, scope, cleanup } = page({ ...PAGE_KEYS, holdReplay: () => true })
  seed(doc, scope)
  const refused = []
  scope.on('refused', (receipt) => refused.push(receipt))
  const receipt = scope.undo()
  assert.deepEqual(receipt, { ok: false, code: 'held' })
  assert.equal(scope.history.length, 1)
  assert.equal(doc.getElementById('side').textContent, 'Renamed')
  assert.deepEqual(refused, [])
  const event = press(dom, doc.getElementById('plain'))
  assert.equal(event.defaultPrevented, true)
  assert.equal(scope.history.length, 1)
  cleanup()
  scope.stop()
})

test('after stop neither listener remains', () => {
  const { dom, doc, scope, cleanup } = page(PAGE_KEYS)
  seed(doc, scope)
  cleanup()
  cleanup()
  assert.equal(press(dom, doc.getElementById('plain')).defaultPrevented, false)
  assert.equal(historyInput(dom, doc.getElementById('plain')).defaultPrevented, false)
  assert.equal(scope.history.length, 1)
  scope.stop()
})

test("'page': with an empty history the key and the history input are still prevented", () => {
  const { dom, doc, scope, cleanup } = page(PAGE_KEYS)
  const plain = doc.getElementById('plain')
  const before = plain.textContent
  const key = press(dom, plain)
  assert.equal(key.defaultPrevented, true)
  assert.deepEqual(scope.undo(), { ok: false, code: 'empty' })
  const input = historyInput(dom, plain)
  assert.equal(input.defaultPrevented, true)
  assert.deepEqual(scope.undo(), { ok: false, code: 'empty' })
  assert.equal(plain.textContent, before)
  cleanup()
  scope.stop()
})

test("'page': a history key dispatched on window itself undoes and does not throw", () => {
  const { dom, doc, scope, cleanup } = page(PAGE_KEYS)
  seed(doc, scope)
  const event = press(dom, dom.window)
  assert.equal(event.defaultPrevented, true)
  assert.equal(scope.history.length, 0)
  assert.equal(doc.getElementById('side').textContent, 'Side')
  cleanup()
  scope.stop()
})

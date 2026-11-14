import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeDom } from './_setup.js'
import { createScope } from '../src/scope.js'

// A receipt says where text changed: `caret` is a DOM position `{ node, offset }`,
// a tracked-content offset `{ root, textOffset }`, or `null`. It is taken from the
// last operation of the replay that changed text, so the host can place the caret
// where the removed or restored text was. The engine never touches the selection.

const PAGE = '<!DOCTYPE html><html><head><title>T</title></head><body>' +
  '<p id="plain">Hello</p>' +
  '<div id="field"><p>Hello</p></div>' +
  '<div id="host"></div>' +
  '<p id="other" data-id="other">Other</p>' +
  '</body></html>'

const read = (el) => el.innerHTML
const write = (el, html) => { el.innerHTML = html }

function page(opts = {}) {
  const dom = makeDom(PAGE)
  const doc = dom.window.document
  const scope = createScope({ scope: doc.body, idleWindowMs: 60_000, ...opts })
  scope.start()
  return { dom, doc, scope }
}

function trackedPage(opts = {}) {
  const fixture = page(opts)
  const field = fixture.doc.getElementById('field')
  const release = fixture.scope.trackContent(field, { read, write })
  return { ...fixture, field, release }
}

// A peer/disk write: paused so it never enters this scope's history.
function peer(scope, fn) {
  scope.pause()
  try { fn() } finally { scope.resume() }
}

test('text appended: undo points where the text was removed, redo where it came back', () => {
  const { doc, scope } = page()
  const text = doc.getElementById('plain').firstChild
  scope.commit('Edit', () => { text.data = 'Hello world' })

  const undone = scope.undo()
  assert.equal(undone.ok, true)
  assert.equal(undone.caret.node, text)
  assert.equal(undone.caret.offset, 5)

  const redone = scope.redo()
  assert.equal(redone.ok, true)
  assert.equal(redone.caret.node, text)
  assert.equal(redone.caret.offset, 11)
})

test('text changed in the middle points at the end of the changed run', () => {
  const { doc, scope } = page()
  const text = doc.getElementById('plain').firstChild
  text.data = 'abc def'
  scope.commit('Edit', () => { text.data = 'abc X def' })

  const undone = scope.undo()
  assert.equal(undone.ok, true)
  assert.equal(text.data, 'abc def')
  assert.equal(undone.caret.node, text)
  assert.equal(undone.caret.offset, 4)

  const redone = scope.redo()
  assert.equal(redone.ok, true)
  assert.equal(text.data, 'abc X def')
  assert.equal(redone.caret.node, text)
  assert.equal(redone.caret.offset, 6)
})

test('a text node the entry added: undo points at its parent and index, redo at its end', () => {
  const { doc, scope } = page()
  const host = doc.getElementById('host')
  host.appendChild(doc.createTextNode('first'))
  scope.commit('Add', () => { host.appendChild(doc.createTextNode('Xy')) })
  const added = host.lastChild
  assert.equal(added.data, 'Xy')

  const undone = scope.undo()
  assert.equal(undone.ok, true)
  assert.equal(added.parentNode, null)
  assert.equal(undone.caret.node, host)
  assert.equal(undone.caret.offset, 1)

  const redone = scope.redo()
  assert.equal(redone.ok, true)
  assert.equal(host.lastChild, added)
  assert.equal(redone.caret.node, added)
  assert.equal(redone.caret.offset, 2)
})

test('a tracked content step reports a text offset into the root', () => {
  const { scope, field } = trackedPage()
  scope.commit('Edit', () => { field.querySelector('p').firstChild.data = 'Hello world' })

  const undone = scope.undo()
  assert.equal(undone.ok, true)
  assert.equal(field.textContent, 'Hello')
  assert.equal(undone.caret.root, field)
  assert.equal(undone.caret.textOffset, 5)

  const redone = scope.redo()
  assert.equal(redone.ok, true)
  assert.equal(field.textContent, 'Hello world')
  assert.equal(redone.caret.root, field)
  assert.equal(redone.caret.textOffset, 11)
})

test('a value step with a write and no content flag reports no caret', () => {
  const { doc, scope } = page()
  const other = doc.getElementById('other')
  let token = 'one'
  scope.command('Set', () => scope.record({
    kind: 'value',
    target: other,
    prop: 'token',
    oldValue: 'one',
    newValue: 'two',
    read: () => token,
    write: (_t, value) => { token = value },
  }))
  token = 'two'

  const undone = scope.undo()
  assert.equal(undone.ok, true)
  assert.equal(token, 'one')
  assert.equal('caret' in undone, false)
})

test('an entry with only attribute steps reports a null caret', () => {
  const { doc, scope } = page()
  const other = doc.getElementById('other')
  scope.commit('Mark', () => { other.setAttribute('data-mark', 'yes') })

  const undone = scope.undo()
  assert.equal(undone.ok, true)
  assert.equal(other.hasAttribute('data-mark'), false)
  assert.equal('caret' in undone, false)

  const redone = scope.redo()
  assert.equal(redone.ok, true)
  assert.equal(other.getAttribute('data-mark'), 'yes')
  assert.equal('caret' in redone, false)
})

test('a text step and then an attribute step reports the text step hint', () => {
  const { doc, scope } = page()
  const text = doc.getElementById('plain').firstChild
  const other = doc.getElementById('other')
  scope.commit('Both', () => {
    text.data = 'Hi'
    other.setAttribute('data-mark', 'yes')
  })

  const undone = scope.undo()
  assert.equal(undone.ok, true)
  assert.equal(text.data, 'Hello')
  assert.equal(undone.caret.node, text)
  assert.equal(undone.caret.offset, 5)
})

test('a refused replay carries no caret, and the engine never reads the selection', () => {
  const { dom, doc, scope } = page()
  const text = doc.getElementById('plain').firstChild
  scope.commit('Edit', () => { text.data = 'Hello world' })
  peer(scope, () => { text.data = 'A peer wrote this' })

  let reads = 0
  doc.getSelection = () => { reads++; return null }
  dom.window.getSelection = () => { reads++; return null }

  const refused = scope.undo()
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'content-changed')
  assert.equal('caret' in refused, false)
  assert.equal(reads, 0)

  const { doc: otherDoc, scope: otherScope } = page()
  const otherText = otherDoc.getElementById('plain').firstChild
  otherScope.commit('Edit', () => { otherText.data = 'Hello world' })
  let otherReads = 0
  otherDoc.getSelection = () => { otherReads++; return null }
  otherScope.undo()
  otherScope.redo()
  assert.equal(otherReads, 0)
})

test('a press that skips an entry reports the caret of the entry it applied', () => {
  const { doc, scope } = page({ refused: 'skip' })
  const text = doc.getElementById('plain').firstChild
  const other = doc.getElementById('other').firstChild
  scope.commit('Edit', () => { text.data = 'Hello world' })
  scope.commit('Other', () => { other.data = 'Changed' })
  peer(scope, () => { other.data = 'A peer wrote this' })

  const result = scope.undo()
  assert.equal(result.ok, true)
  assert.equal(result.label, 'Edit')
  assert.equal(result.skipped.length, 1)
  assert.equal(result.caret.node, text)
  assert.equal(result.caret.offset, 5)

  const lonely = page({ refused: 'skip' })
  const lonelyText = lonely.doc.getElementById('plain').firstChild
  lonely.scope.commit('Edit', () => { lonelyText.data = 'Hello world' })
  peer(lonely.scope, () => { lonelyText.data = 'A peer wrote this' })
  const onlySkipped = lonely.scope.undo()
  assert.equal(onlySkipped.ok, false)
  assert.equal(onlySkipped.code, 'empty')
  assert.equal(onlySkipped.skipped.length, 1)
  assert.equal('caret' in onlySkipped, false)
})

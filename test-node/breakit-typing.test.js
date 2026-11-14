import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeDom, tick } from './_setup.js'
import { createScope } from '../src/scope.js'

// Break-it cases for the sentence rule (M7). Each test types the way a browser
// reports typing: a beforeinput event, the text change, an input event.

const PAGE = '<!DOCTYPE html><html><head><title>T</title></head><body>' +
  '<p id="plain" contenteditable="plaintext-only">Done.</p>' +
  '<p id="other" contenteditable="plaintext-only">Other</p>' +
  '<div id="rich" no-undo contenteditable="true"><p id="line">One two three</p>\n    </div>' +
  '</body></html>'

function page() {
  const dom = makeDom(PAGE)
  const doc = dom.window.document
  const scope = createScope({ scope: doc.body, idleWindowMs: 10_000, typingBreak: 'sentence' })
  scope.start()
  const rich = doc.getElementById('rich')
  scope.trackContent(rich, { read: (el) => el.innerHTML, write: (el, html) => { el.innerHTML = html } })
  return { dom, doc, scope, rich }
}

function fire(dom, field, name, inputType, data = null) {
  const Event = dom.window.InputEvent
  field.dispatchEvent(new Event(name, { bubbles: true, cancelable: name === 'beforeinput', inputType, data }))
}

async function typeAtEnd(dom, field, node, text) {
  const doc = dom.window.document
  for (const ch of text) {
    doc.getSelection().collapse(node, node.data.length)
    fire(dom, field, 'beforeinput', 'insertText', ch)
    node.data += ch
    fire(dom, field, 'input', 'insertText', ch)
    await tick(1)
  }
}

test('control: a sentence typed whole is one step with its space', async () => {
  const { dom, doc, scope } = page()
  const plain = doc.getElementById('other')
  await typeAtEnd(dom, plain, plain.firstChild, ' more words. Next')
  scope.flush()
  const states = []
  while (scope.canUndo) { scope.undo(); states.push(plain.textContent) }
  assert.deepEqual(states, ['Other more words. ', 'Other'])
  scope.stop()
})

test('BREAK: typing that starts with a space after a finished sentence makes a step that holds only the space', async () => {
  const { dom, doc, scope } = page()
  const plain = doc.getElementById('plain')
  await typeAtEnd(dom, plain, plain.firstChild, ' More words')
  scope.flush()
  const states = []
  while (scope.canUndo) { scope.undo(); states.push(plain.textContent) }
  assert.deepEqual(states, ['Done.'], 'one press takes back what was typed')
  scope.stop()
})

test('BREAK: the same after a paste that ends a sentence', async () => {
  const { dom, doc, scope } = page()
  const plain = doc.getElementById('other')
  const node = plain.firstChild
  doc.getSelection().collapse(node, node.data.length)
  fire(dom, plain, 'beforeinput', 'insertFromPaste')
  node.data += ' Pasted one.'
  fire(dom, plain, 'input', 'insertFromPaste')
  await tick(2)
  await typeAtEnd(dom, plain, node, ' After')
  scope.flush()
  const states = []
  while (scope.canUndo) { scope.undo(); states.push(plain.textContent) }
  assert.deepEqual(states, ['Other Pasted one.', 'Other'], 'two presses: the typing, then the paste')
  scope.stop()
})

// A rich editor (Squire) deletes a selection in its own keydown handler and then lets the
// browser insert the character, so the deletion is already in the page when beforeinput
// arrives with a collapsed selection.
test('BREAK: a rich field: a word picked with the mouse and typed over undoes in two presses, the first leaving the word deleted', async () => {
  const { dom, doc, scope, rich } = page()
  const line = doc.getElementById('line')
  const node = line.firstChild
  rich.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }))
  doc.getSelection().setBaseAndExtent(node, 4, node, 7)
  rich.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'X' }))
  node.deleteData(4, 3)
  doc.getSelection().collapse(node, 4)
  // The same task as the keydown: only the mutation records are delivered in between.
  for (let at = 0; at < 4; at++) await Promise.resolve()
  for (const ch of 'XY') {
    const at = doc.getSelection().anchorOffset
    fire(dom, rich, 'beforeinput', 'insertText', ch)
    node.insertData(at, ch)
    doc.getSelection().collapse(node, at + 1)
    fire(dom, rich, 'input', 'insertText', ch)
    await tick(1)
  }
  scope.flush()
  assert.equal(rich.textContent.trim(), 'One XY three')
  const states = []
  while (scope.canUndo) { scope.undo(); states.push(rich.textContent.trim()) }
  assert.deepEqual(states, ['One two three'], 'one press gives the replaced word back')
  scope.stop()
})

// The same editor drops the source's indentation beside its block tags in the keydown of
// the first key typed in a field. The person clicked into the field first, so that tidy
// is closed as a step of its own: a press that changes nothing anyone can see.
test('BREAK: a rich field: the editor tidies its markup in its own keydown, and after a click that tidy is an undo step with nothing to see', async () => {
  const { dom, doc, scope, rich } = page()
  const node = doc.getElementById('line').firstChild
  rich.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }))
  doc.getSelection().collapse(node, node.data.length)
  for (const ch of 'AB') {
    rich.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: ch }))
    if (rich.lastChild.nodeType === 3) rich.lastChild.remove()
    for (let at = 0; at < 4; at++) await Promise.resolve()
    fire(dom, rich, 'beforeinput', 'insertText', ch)
    node.data += ch
    fire(dom, rich, 'input', 'insertText', ch)
    await tick(1)
  }
  scope.flush()
  const states = []
  while (scope.canUndo) { scope.undo(); states.push(rich.textContent.trim()) }
  assert.deepEqual(states, ['One two three'], 'one press takes the typing back, and no press leaves the text the same')
  scope.stop()
})

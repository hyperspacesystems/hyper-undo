import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeDom, tick } from './_setup.js'
import { createScope } from '../src/scope.js'

// Break-it cases (M7): a plain field emptied with select all and Backspace. Chrome empties
// the text node, takes it out and puts a <br> in. Undo gives the text back; redo must
// empty the field again.

const PAGE = '<!DOCTYPE html><html><head><title>T</title></head><body>' +
  '<h1 id="title" contenteditable="plaintext-only">Old title</h1>' +
  '<p id="other" contenteditable="plaintext-only">Other</p>' +
  '</body></html>'

function page() {
  const dom = makeDom(PAGE)
  const doc = dom.window.document
  const scope = createScope({ scope: doc.body, idleWindowMs: 10_000, typingBreak: 'sentence', refused: 'skip' })
  scope.start()
  const skipped = []
  scope.on('skipped', (record) => skipped.push(record.code))
  return { dom, doc, scope, skipped, title: doc.getElementById('title') }
}

function fire(dom, field, name, inputType, data = null) {
  field.dispatchEvent(new dom.window.InputEvent(name, { bubbles: true, cancelable: name === 'beforeinput', inputType, data }))
}

async function empty(dom, title) {
  const doc = dom.window.document
  const node = title.firstChild
  doc.getSelection().selectAllChildren(title)
  fire(dom, title, 'beforeinput', 'deleteContentBackward')
  node.data = ''
  node.remove()
  title.append(doc.createElement('br'))
  fire(dom, title, 'input', 'deleteContentBackward')
  await tick(1)
}

async function retype(dom, title, text) {
  const doc = dom.window.document
  const node = doc.createTextNode('')
  for (const ch of text) {
    fire(dom, title, 'beforeinput', 'insertText', ch)
    if (!node.parentNode) { title.append(node); title.querySelector('br').remove() }
    node.data += ch
    fire(dom, title, 'input', 'insertText', ch)
    await tick(1)
  }
}

test('control: a title changed in place undoes and redoes', async () => {
  const { dom, scope, skipped, title } = page()
  fire(dom, title, 'beforeinput', 'insertText', '!')
  title.firstChild.data = 'Old title!'
  fire(dom, title, 'input', 'insertText', '!')
  await tick(1)
  scope.flush()
  while (scope.canUndo) scope.undo()
  assert.equal(title.textContent, 'Old title')
  while (scope.canRedo) scope.redo()
  assert.equal(title.textContent, 'Old title!')
  assert.deepEqual(skipped, [])
  scope.stop()
})

test('control: text typed into a field that was already empty undoes and redoes', async () => {
  const { dom, doc, scope, skipped, title } = page()
  scope.pause()
  title.replaceChildren(doc.createElement('br'))
  scope.resume()
  await tick(2)
  await retype(dom, title, 'New title')
  scope.flush()
  while (scope.canUndo) scope.undo()
  assert.equal(title.innerHTML, '<br>')
  while (scope.canRedo) scope.redo()
  assert.deepEqual(skipped, [])
  assert.equal(title.innerHTML, 'New title')
  scope.stop()
})

test('BREAK: a title emptied with select all and Backspace: undo, then redo is skipped as "changed elsewhere"', async () => {
  const { dom, scope, skipped, title } = page()
  await empty(dom, title)
  scope.flush()
  assert.equal(title.innerHTML, '<br>')
  while (scope.canUndo) scope.undo()
  assert.equal(title.innerHTML, 'Old title')
  while (scope.canRedo) scope.redo()
  assert.deepEqual(skipped, [], 'nobody else changed the page, so no step is skipped')
  assert.equal(title.innerHTML, '<br>', 'redo empties the title again')
  scope.stop()
})

test('BREAK: a title emptied and retyped: undo all, then redo all does not bring the new title back', async () => {
  const { dom, scope, skipped, title } = page()
  await empty(dom, title)
  await retype(dom, title, 'New title')
  scope.flush()
  assert.equal(title.innerHTML, 'New title')
  while (scope.canUndo) scope.undo()
  assert.equal(title.innerHTML, 'Old title')
  while (scope.canRedo) scope.redo()
  assert.deepEqual(skipped, [], 'nobody else changed the page, so no step is skipped')
  assert.equal(title.innerHTML, 'New title', 'redo brings the new title back')
  scope.stop()
})

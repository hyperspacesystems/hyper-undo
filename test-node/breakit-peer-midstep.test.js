import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeDom, tick } from './_setup.js'
import { createScope } from '../src/scope.js'

// Break-it cases (M7): another writer changes a field while this tab's typing step in that
// field is still open. A sync frame is applied between pause() and resume(), so the
// engine never records the other writer's change. The step that closes afterwards must
// not take that change back when it is undone.

const PAGE = '<!DOCTYPE html><html><head><title>T</title></head><body>' +
  '<p id="plain" contenteditable="plaintext-only">Start</p>' +
  '<div id="rich" no-undo contenteditable="true"><p id="peer">Peer paragraph</p><p id="mine">Mine</p></div>' +
  '</body></html>'

function page(opts = {}) {
  const dom = makeDom(PAGE)
  const doc = dom.window.document
  const scope = createScope({ scope: doc.body, idleWindowMs: 10_000, typingBreak: 'sentence', refused: 'skip', ...opts })
  scope.start()
  const rich = doc.getElementById('rich')
  scope.trackContent(rich, { read: (el) => el.innerHTML, write: (el, html) => { el.innerHTML = html } })
  const skipped = []
  scope.on('skipped', (record) => skipped.push(record))
  return { dom, doc, scope, rich, skipped }
}

async function typeAtEnd(dom, field, node, text) {
  const doc = dom.window.document
  for (const ch of text) {
    doc.getSelection().collapse(node, node.data.length)
    field.dispatchEvent(new dom.window.InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: ch }))
    node.data += ch
    field.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }))
    await tick(1)
  }
}

test('control: the other writer changes the rich field after the step closed: undo skips the step and keeps their text', async () => {
  const { dom, doc, scope, rich, skipped } = page()
  await typeAtEnd(dom, rich, doc.getElementById('mine').firstChild, ' typed one')
  scope.flush()
  scope.pause()
  doc.getElementById('peer').firstChild.data = 'Peer paragraph, fixed by the other writer'
  scope.resume()
  await tick(2)
  scope.undo()
  assert.equal(skipped.length, 1)
  assert.match(rich.textContent, /fixed by the other writer/)
  assert.match(rich.textContent, /typed one/)
  scope.stop()
})

test('BREAK: the other writer changes the rich field while the step is open: undo takes their text away', async () => {
  const { dom, doc, scope, rich } = page()
  await typeAtEnd(dom, rich, doc.getElementById('mine').firstChild, ' typed one')
  scope.pause()
  doc.getElementById('peer').firstChild.data = 'Peer paragraph, fixed by the other writer'
  scope.resume()
  await tick(2)
  await typeAtEnd(dom, rich, doc.getElementById('mine').firstChild, ' typed two')
  scope.flush()
  assert.match(rich.textContent, /fixed by the other writer/)
  while (scope.canUndo) {
    scope.undo()
    assert.match(rich.textContent, /fixed by the other writer/, 'the other writer’s text is still in the field after this tab’s undo')
  }
  assert.doesNotMatch(rich.textContent, /typed two/, 'the typing after their change is undone')
  scope.stop()
})

test('BREAK: the same in a plain field: the other writer rewrites the text node while the step is open', async () => {
  const { dom, doc, scope } = page()
  const plain = doc.getElementById('plain')
  const node = plain.firstChild
  await typeAtEnd(dom, plain, node, ' typed one')
  scope.pause()
  node.data = `Their prefix. ${node.data}`
  scope.resume()
  await tick(2)
  await typeAtEnd(dom, plain, node, ' typed two')
  scope.flush()
  assert.equal(plain.textContent, 'Their prefix. Start typed one typed two')
  while (scope.canUndo) {
    scope.undo()
    assert.match(plain.textContent, /Their prefix\./, 'the other writer’s text is still in the field after this tab’s undo')
  }
  assert.doesNotMatch(plain.textContent, /typed two/, 'the typing after their change is undone')
  scope.stop()
})

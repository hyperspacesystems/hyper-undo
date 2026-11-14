import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeDom } from './_setup.js'
import { createScope } from '../src/scope.js'
import { installKeys } from '../src/keys.js'

// Break-it case (M7): a page that records commands only (a board app) does not record
// typing in an editable field, so Cmd+Z there has only the browser's own undo to go to.

const PAGE = '<!DOCTYPE html><html><head><title>T</title></head><body>' +
  '<h3 id="title" contenteditable="plaintext-only">Card title</h3>' +
  '<p id="side">Side</p>' +
  '</body></html>'

function page(opts) {
  const dom = makeDom(PAGE)
  const doc = dom.window.document
  const scope = createScope({ scope: doc.body, idleWindowMs: 60_000, ...opts })
  scope.start()
  const cleanup = installKeys(scope)
  return { dom, doc, scope, cleanup }
}

const press = (dom, el) => {
  const event = new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'z', metaKey: true })
  el.dispatchEvent(event)
  return event
}

test('control: before M7 (default keys) a commands-only page leaves Cmd+Z in an editable field to the browser', () => {
  const { dom, doc, scope, cleanup } = page({ recording: 'commands' })
  scope.command('Move card', () => { doc.getElementById('side').firstChild.data = 'Moved' })
  const event = press(dom, doc.getElementById('title'))
  assert.equal(event.defaultPrevented, false)
  assert.equal(doc.getElementById('side').textContent, 'Moved')
  cleanup(); scope.stop()
})

test('BREAK: with the page keys on, Cmd+Z while typing a title undoes the last board action and the typing has no undo', async () => {
  const { dom, doc, scope, cleanup } = page({ recording: 'commands', editableKeys: 'page', refused: 'skip' })
  scope.command('Move card', () => { doc.getElementById('side').firstChild.data = 'Moved' })
  const title = doc.getElementById('title')
  title.firstChild.data = 'Card titlee'
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(scope.history.length, 1, 'the typing made no entry')
  const event = press(dom, title)
  assert.deepEqual(
    { taken: event.defaultPrevented, side: doc.getElementById('side').textContent },
    { taken: false, side: 'Moved' },
    'the key is left to the browser, and the board action stays',
  )
  cleanup(); scope.stop()
})

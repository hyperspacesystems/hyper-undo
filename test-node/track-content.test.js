import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeDom, tick } from './_setup.js'
import { createScope } from '../src/scope.js'

const PAGE = '<!DOCTYPE html><html><head><title>T</title></head><body>' +
  '<ul id="list"><li data-id="a">Item A</li><li data-id="b">Item B</li></ul>' +
  '<div id="field"><p>Hello</p></div>' +
  '<p id="plain">Plain</p>' +
  '</body></html>'

const read = (el) => el.innerHTML
const write = (el, html) => { el.innerHTML = html }

function page(opts = {}) {
  const dom = makeDom(PAGE)
  const doc = dom.window.document
  const scope = createScope({ scope: doc.body, idleWindowMs: 60_000, ...opts })
  scope.start()
  const field = doc.getElementById('field')
  const release = scope.trackContent(field, { read, write })
  return { doc, scope, field, release }
}

const type = (field, text) => { field.querySelector('p').firstChild.data += text }
const steps = (scope) => scope.describe(scope.history.at(-1).id).steps

test('two text changes inside a tracked root make one entry with one value step', async () => {
  const { scope, field } = page()
  type(field, ' wor')
  await tick(5)
  type(field, 'ld')
  await tick(5)
  scope.flush()
  assert.equal(scope.history.length, 1)
  const described = steps(scope)
  assert.deepEqual(described.map((s) => s.kind), ['value'])
  assert.equal(described[0].prop, 'content')
  assert.equal(described[0].before, '<p>Hello</p>')
  assert.equal(described[0].after, '<p>Hello world</p>')
})

test('undo writes the old HTML back, redo the new, and neither leaves an entry', async () => {
  const { scope, field } = page()
  type(field, ' world')
  await tick(5)
  scope.flush()
  assert.equal(scope.history.length, 1)

  const undone = scope.undo()
  assert.equal(undone.ok, true)
  assert.equal(field.innerHTML, '<p>Hello</p>')
  await tick(5)
  scope.flush()
  assert.equal(scope.history.length, 0, 'the replay left no entry of its own')

  const redone = scope.redo()
  assert.equal(redone.ok, true)
  assert.equal(field.innerHTML, '<p>Hello world</p>')
  await tick(5)
  scope.flush()
  assert.equal(scope.history.length, 1, 'the replay left no second entry')
})

test('a change while paused makes no entry and the next change records old value equal to the paused HTML', async () => {
  const { scope, field } = page()
  scope.pause()
  field.innerHTML = '<p>From a peer</p>'
  scope.resume()
  await tick(5)
  scope.flush()
  assert.equal(scope.history.length, 0)

  scope.pause()
  field.innerHTML = '<p>Late</p>'
  await tick(5)
  scope.resume()
  type(field, '!')
  await tick(5)
  scope.flush()
  assert.equal(scope.history.length, 1)
  assert.equal(steps(scope)[0].before, '<p>Late</p>')
  assert.equal(steps(scope)[0].after, '<p>Late!</p>')
})

test('commands mode: an unbracketed change makes no entry and moves the baseline', async () => {
  const { scope, field } = page({ recording: 'commands' })
  field.innerHTML = '<p>Foreign</p>'
  await tick(5)
  scope.flush()
  assert.equal(scope.history.length, 0)
  scope.commit('Type', () => { type(field, '?') })
  assert.equal(scope.history.length, 1)
  assert.equal(steps(scope)[0].before, '<p>Foreign</p>')
  assert.equal(steps(scope)[0].after, '<p>Foreign?</p>')
})

test('a change inside a command joins that command', async () => {
  const { doc, scope, field } = page()
  scope.command('Apply link', () => {
    field.querySelector('p').innerHTML = '<a href="x">Hello</a>'
    doc.getElementById('plain').setAttribute('data-linked', 'yes')
  })
  assert.equal(scope.history.length, 1)
  assert.deepEqual(steps(scope).map((s) => s.kind).sort(), ['attribute', 'value'])
  assert.equal(scope.undo().ok, true)
  assert.equal(field.innerHTML, '<p>Hello</p>')
  assert.equal(doc.getElementById('plain').hasAttribute('data-linked'), false)
})

test('typing, then a commit that removes a sibling: two entries, the typing first', async () => {
  const { doc, scope, field } = page()
  type(field, ' there')
  scope.commit('Remove item', () => doc.querySelector('[data-id="a"]').remove())
  assert.deepEqual(scope.history.map((e) => e.label), ['Edit', 'Remove item'])
  assert.equal(scope.undo().label, 'Remove item')
  assert.equal(doc.querySelectorAll('#list > li').length, 2)
  assert.equal(scope.undo().label, 'Edit')
  assert.equal(field.innerHTML, '<p>Hello</p>')
})

test('a change behind the scope makes the earlier entry refuse with content-changed, and the content stays', async () => {
  const { scope, field } = page()
  type(field, ' world')
  await tick(5)
  scope.flush()
  scope.pause()
  field.innerHTML = '<p>Overwritten</p>'
  scope.resume()
  const first = scope.undo()
  assert.equal(first.ok, false)
  assert.equal(first.code, 'content-changed')
  assert.equal(field.innerHTML, '<p>Overwritten</p>')
  const second = scope.undo()
  assert.equal(second.ok, false)
  assert.equal(second.code, 'content-changed')
  assert.equal(scope.history.length, 1)
})

test('an attribute change on the tracked root itself is recorded as an attribute step', async () => {
  const { scope, field } = page()
  field.setAttribute('data-state', 'on')
  await tick(5)
  scope.flush()
  assert.equal(scope.history.length, 1)
  const described = steps(scope)
  assert.deepEqual(described.map((s) => s.kind), ['attribute'])
  assert.equal(described[0].name, 'data-state')
  assert.equal(described[0].before, null)
  assert.equal(described[0].after, 'on')
  assert.equal(scope.undo().ok, true)
  assert.equal(field.hasAttribute('data-state'), false)
})

test('the release function and stop() both stop the tracking', async () => {
  const { scope, field, release } = page()
  release()
  type(field, ' x')
  await tick(5)
  scope.flush()
  assert.equal(scope.history.length, 1)
  assert.deepEqual(steps(scope).map((s) => s.kind), ['text'])

  scope.stop()
  scope.start()
  type(field, ' y')
  await tick(5)
  scope.flush()
  assert.equal(scope.history.length, 1)
  assert.deepEqual(steps(scope).map((s) => s.kind), ['text'])
})

test('a recorded change that only swaps plain spaces for non-breaking spaces makes no entry', async () => {
  const { scope, field } = page()
  scope.pause()
  field.innerHTML = '<p>a b</p>'
  scope.resume()
  await tick(5)
  scope.flush()
  assert.equal(scope.history.length, 0)
  field.innerHTML = '<p>a&nbsp;b</p>'
  await tick(5)
  scope.flush()
  assert.equal(scope.history.length, 0)
})

test('a non-breaking space in the field does not block the undo of a typing step', async () => {
  const { scope, field } = page()
  scope.pause()
  field.innerHTML = '<p>a b</p>'
  scope.resume()
  await tick(5)
  scope.flush()
  type(field, 'c')
  await tick(5)
  scope.flush()
  assert.equal(steps(scope)[0].before, '<p>a b</p>')
  assert.equal(steps(scope)[0].after, '<p>a bc</p>')

  scope.pause()
  field.innerHTML = '<p>a&nbsp;bc</p>'
  scope.resume()
  const undone = scope.undo()
  assert.deepEqual([undone.ok, undone.code], [true, undefined], 'the guard tolerated the non-breaking space')
  assert.equal(field.innerHTML, '<p>a b</p>')
})

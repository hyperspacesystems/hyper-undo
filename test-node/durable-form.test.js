import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeDom, tick } from './_setup.js'
import { createScope } from '../src/scope.js'

const PAGE = '<!DOCTYPE html><html><head><title>List</title></head><body>' +
  '<ul id="list">' +
  '<li data-id="a"><span class="field" data-owned runtime="on">Alpha</span></li>' +
  '<li data-id="b"><span class="field" data-owned>Beta</span></li>' +
  '</ul>' +
  '</body></html>'

const owned = (node) => (node.hasAttribute('data-owned') ? '' : undefined)

function page(opts = {}) {
  const dom = makeDom(PAGE)
  const doc = dom.window.document
  const scope = createScope({ scope: doc.body, idleWindowMs: 60_000, ...opts })
  scope.start()
  return { doc, scope }
}

const ids = (doc) => [...doc.querySelectorAll('#list > [data-id]')].map((el) => el.getAttribute('data-id'))

function wearOff(field) {
  field.removeAttribute('runtime')
  field.textContent = 'Alpha, edited while detached'
}

test('without a durable form, a removed subtree that changed while detached is refused', async () => {
  const { doc, scope } = page()
  const item = doc.querySelector('[data-id="a"]')
  scope.commit('Remove item', () => item.remove())
  wearOff(item.querySelector('.field'))
  await tick(5)
  const result = scope.undo()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'content-changed')
  assert.deepEqual(ids(doc), ['b'])
})

test('a durable form stands in for the markup of the node that owns it, on undo and on redo', async () => {
  const { doc, scope } = page({ durableForm: owned })
  const item = doc.querySelector('[data-id="a"]')
  scope.commit('Remove item', () => item.remove())
  wearOff(item.querySelector('.field'))
  await tick(5)
  assert.equal(scope.undo().ok, true)
  assert.deepEqual(ids(doc), ['a', 'b'])
  scope.pause()
  item.querySelector('.field').setAttribute('runtime', 'on')
  scope.resume()
  await tick(5)
  assert.equal(scope.redo().ok, true)
  assert.deepEqual(ids(doc), ['b'])
})

test('a durable form still lets a change outside the owned node refuse the step', async () => {
  const { doc, scope } = page({ durableForm: owned })
  const item = doc.querySelector('[data-id="a"]')
  scope.commit('Remove item', () => item.remove())
  item.setAttribute('data-note', 'changed while detached')
  await tick(5)
  const result = scope.undo()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'content-changed')
})

test('a form that throws or answers a non-string leaves the default projection in charge', async () => {
  for (const durableForm of [() => { throw new Error('no') }, () => 7, () => null]) {
    const { doc, scope } = page({ durableForm })
    const item = doc.querySelector('[data-id="a"]')
    scope.commit('Remove item', () => item.remove())
    await tick(5)
    assert.equal(scope.undo().ok, true)
    assert.deepEqual(ids(doc), ['a', 'b'])
  }
})

test('churn inside a subtree removed from a no-undo region leaves no entry', async () => {
  const { doc, scope } = page()
  const field = doc.querySelector('[data-id="a"] .field')
  field.setAttribute('no-undo', '')
  await tick(5)
  scope.flush()
  const before = scope.history.length
  const block = doc.createElement('div')
  field.appendChild(block)
  const mark = doc.createElement('input')
  block.appendChild(mark)
  block.removeChild(mark)
  field.removeChild(block)
  await tick(5)
  scope.flush()
  assert.equal(scope.history.length, before)
})

test('a description shows a durable form as its text, not as an internal token', async () => {
  const { doc, scope } = page({ durableForm: (node) => (node.hasAttribute('data-owned') ? '<b>Alpha saved</b>' : undefined) })
  scope.commit('Remove item', () => doc.querySelector('[data-id="a"]').remove())
  await tick(5)
  const entry = scope.history[scope.history.length - 1]
  const html = scope.describe(entry.id).steps.flatMap((step) => step.nodes || []).map((n) => n.html).join('')
  assert.match(html, /<b>Alpha saved<\/b>/)
  assert.doesNotMatch(html, /#form:/)
})

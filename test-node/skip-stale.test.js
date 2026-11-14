import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeDom } from './_setup.js'
import { createScope } from '../src/scope.js'

// `refused: 'skip'`: a step that can no longer be undone never blocks older
// ones. Preflight and apply refuse exactly as before, but with this option one
// undo() or redo() press removes the refused entry, announces it (with a
// plain-data description, captured while the entry is still on its stack) and
// goes on to the next entry in the same call.

function board(html, opts = {}) {
  const dom = makeDom(`<!DOCTYPE html><html><head><title>Board</title></head><body>${html}</body></html>`)
  const doc = dom.window.document
  const scope = createScope({ scope: doc.body, idleWindowMs: 20, ...opts })
  scope.start()
  return { dom, doc, scope }
}

const ids = (scope) => scope.history.map((e) => e.id)

// A peer/disk write: paused so it never enters this scope's history.
function peer(scope, fn) {
  scope.pause()
  try { fn() } finally { scope.resume() }
}

const THREE = '<div data-id="a">A</div><div data-id="b">B</div><div data-id="c">C</div>'

// Three entries, each a text change in its own element.
function threeEdits(opts = {}) {
  const fixture = board(THREE, opts)
  const a = fixture.doc.querySelector('[data-id="a"]')
  const b = fixture.doc.querySelector('[data-id="b"]')
  const c = fixture.doc.querySelector('[data-id="c"]')
  fixture.scope.commit('Edit A', () => { a.firstChild.data = 'A2' })
  fixture.scope.commit('Edit B', () => { b.firstChild.data = 'B2' })
  fixture.scope.commit('Edit C', () => { c.firstChild.data = 'C2' })
  const [aId, bId, cId] = ids(fixture.scope)
  return { ...fixture, a, b, c, aId, bId, cId }
}

function record(scope) {
  const events = { refused: [], skipped: [] }
  scope.on('refused', (e) => events.refused.push(e))
  scope.on('skipped', (e) => events.skipped.push(e))
  return events
}

test('default options: a refused top entry stays refused and an older entry is never applied', () => {
  const { scope, a, b, c, aId, bId, cId } = threeEdits()
  peer(scope, () => { c.firstChild.data = 'Peer C' })

  for (let press = 1; press <= 2; press++) {
    const result = scope.undo()
    assert.equal(result.ok, false, `press ${press} still refuses`)
    assert.equal(result.code, 'content-changed')
    assert.equal(result.entryId, cId, 'the same top entry is refused again')
  }

  assert.deepEqual(ids(scope), [aId, bId, cId], 'nothing left either stack')
  assert.equal(a.firstChild.data, 'A2', 'the older entry was never applied')
  assert.equal(b.firstChild.data, 'B2', 'the entry under the refused one was never applied')
  assert.equal(c.firstChild.data, 'Peer C', 'the refused entry kept the peer text')
})

test("refused: 'skip' drops the stale top entry and applies the next in the same press", () => {
  const { scope, a, b, c, aId, bId, cId } = threeEdits({ refused: 'skip' })
  const events = record(scope)
  peer(scope, () => { c.firstChild.data = 'Peer C' })

  const result = scope.undo()

  assert.equal(result.ok, true, 'the press applies the next entry')
  assert.equal(result.entryId, bId)
  assert.equal(result.skipped.length, 1, 'the press reports the skip')
  assert.equal(result.skipped[0].entryId, cId)
  assert.equal(result.skipped[0].code, 'content-changed')
  assert.ok(result.skipped[0].description, 'the skip carries a description')
  assert.equal(result.skipped[0].description.id, cId)

  assert.equal(b.firstChild.data, 'B', "B's change is undone")
  assert.equal(c.firstChild.data, 'Peer C', "C's element keeps its paused text")
  assert.equal(a.firstChild.data, 'A2', 'A is untouched')
  assert.deepEqual(ids(scope), [aId], 'history lists only A')

  assert.equal(events.refused.length, 0, 'a skipped entry is not refused')
  assert.equal(events.skipped.length, 1, 'one skipped event fired')
  assert.equal(events.skipped[0].entryId, cId)
  assert.equal(events.skipped[0].direction, 'undo')
})

test('two stale entries on top: one press skips both and applies the third', () => {
  const { scope, a, b, c, aId, bId, cId } = threeEdits({ refused: 'skip' })
  peer(scope, () => {
    c.firstChild.data = 'Peer C'
    b.firstChild.data = 'Peer B'
  })

  const result = scope.undo()

  assert.equal(result.ok, true)
  assert.equal(result.entryId, aId, 'the third entry applies')
  assert.deepEqual(result.skipped.map((s) => s.entryId), [cId, bId], 'both skips, newest first')
  assert.equal(result.skipped[0].code, 'content-changed')
  assert.equal(result.skipped[1].code, 'content-changed')

  assert.equal(a.firstChild.data, 'A')
  assert.equal(b.firstChild.data, 'Peer B')
  assert.equal(c.firstChild.data, 'Peer C')
  assert.deepEqual(ids(scope), [], 'nothing is left to undo')
})

test('every entry stale: the press reports empty and lists every skip', () => {
  const { scope, a, b, c, aId, bId, cId } = threeEdits({ refused: 'skip' })
  peer(scope, () => {
    c.firstChild.data = 'Peer C'
    b.firstChild.data = 'Peer B'
    a.firstChild.data = 'Peer A'
  })

  const result = scope.undo()

  assert.equal(result.ok, false)
  assert.equal(result.code, 'empty')
  assert.equal(result.direction, 'undo')
  assert.deepEqual(result.skipped.map((s) => s.entryId), [cId, bId, aId])
  assert.deepEqual(ids(scope), [], 'the stack is empty')
  assert.equal(scope.canUndo, false)
  assert.equal(scope.canRedo, false, 'a skipped entry goes to no other stack')
  assert.equal(a.firstChild.data, 'Peer A')
  assert.equal(b.firstChild.data, 'Peer B')
  assert.equal(c.firstChild.data, 'Peer C')
})

test("refused: 'skip' works the same on the redo stack", () => {
  const { scope, a, b, c, aId, bId, cId } = threeEdits({ refused: 'skip' })
  assert.equal(scope.undo().ok, true)
  assert.equal(scope.undo().ok, true)
  assert.equal(scope.undo().ok, true)
  assert.deepEqual(ids(scope), [])
  const events = record(scope)

  peer(scope, () => { a.firstChild.data = 'Peer A' })
  const result = scope.redo()

  assert.equal(result.ok, true, 'the press applies the next redo entry')
  assert.equal(result.entryId, bId)
  assert.equal(result.direction, 'redo')
  assert.equal(result.skipped.length, 1)
  assert.equal(result.skipped[0].entryId, aId)
  assert.equal(result.skipped[0].code, 'content-changed')
  assert.equal(result.skipped[0].description.id, aId)

  assert.equal(a.firstChild.data, 'Peer A', "A's element keeps its paused text")
  assert.equal(b.firstChild.data, 'B2', "B's change is redone")
  assert.equal(c.firstChild.data, 'C', 'C is untouched')
  assert.deepEqual(scope.future.map((e) => e.id), [cId], 'the redo stack lists only C')
  assert.equal(events.refused.length, 0)
  assert.equal(events.skipped.length, 1)
})

test('undo({ entryId }) on a stale top entry refuses and skips nothing', () => {
  const { scope, a, b, c, aId, bId, cId } = threeEdits({ refused: 'skip' })
  const events = record(scope)
  peer(scope, () => { c.firstChild.data = 'Peer C' })

  const result = scope.undo({ entryId: cId })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'content-changed')
  assert.equal(result.entryId, cId)
  assert.equal(events.skipped.length, 0, 'a named press never skips')
  assert.equal(events.refused.length, 1)
  assert.deepEqual(ids(scope), [aId, bId, cId], 'both stacks are unchanged')
  assert.equal(a.firstChild.data, 'A2')
  assert.equal(b.firstChild.data, 'B2')
  assert.equal(c.firstChild.data, 'Peer C')
})

test('holdReplay: the press is held, nothing is skipped and the stacks are unchanged', () => {
  const { scope, a, b, c, aId, bId, cId } = threeEdits({ refused: 'skip', holdReplay: () => true })
  const events = record(scope)
  peer(scope, () => { c.firstChild.data = 'Peer C' })

  const result = scope.undo()

  assert.equal(result.ok, false)
  assert.equal(result.code, 'held')
  assert.equal(events.skipped.length, 0)
  assert.equal(events.refused.length, 0)
  assert.deepEqual(ids(scope), [aId, bId, cId])
  assert.equal(scope.canRedo, false)
  assert.equal(c.firstChild.data, 'Peer C')
})

test('a structure refusal is skipped like a content change', () => {
  const { doc, scope } = board('<ul data-id="list"><li data-id="card">Alpha</li></ul>', { refused: 'skip' })
  const card = doc.querySelector('[data-id="card"]')
  scope.commit('Rename card', () => { card.setAttribute('data-title', 'Local') })
  const entryId = ids(scope).at(-1)
  const events = record(scope)

  peer(scope, () => { card.remove() })

  const result = scope.undo()

  assert.equal(result.ok, false)
  assert.equal(result.code, 'empty', 'the only entry was skipped, so the stack ran out')
  assert.equal(result.skipped.length, 1)
  assert.equal(result.skipped[0].entryId, entryId)
  assert.equal(result.skipped[0].code, 'target-detached')
  assert.equal(events.refused.length, 0)
  assert.equal(events.skipped.length, 1)
  assert.deepEqual(ids(scope), [])
  assert.equal(doc.querySelector('[data-id="card"]'), null)
})

test("the skipped entry's description is plain data and carries its label", () => {
  const { scope, c, bId, cId } = threeEdits({ refused: 'skip' })
  const events = record(scope)
  peer(scope, () => { c.firstChild.data = 'Peer C' })

  const result = scope.undo()
  assert.equal(result.entryId, bId)

  const skipped = result.skipped[0]
  assert.equal(skipped.label, 'Edit C')
  const json = JSON.stringify(skipped.description)
  assert.equal(typeof json, 'string', 'the description serializes')
  assert.match(json, /Edit C/, "the description carries the entry's label")
  assert.equal(skipped.description.id, cId)
  assert.deepEqual(skipped.description.refused.code, 'content-changed', 'the description records why it was refused')
  assert.deepEqual(events.skipped[0].description, skipped.description)
})

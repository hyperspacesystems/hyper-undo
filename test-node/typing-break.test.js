import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeDom, tick } from './_setup.js'
import { createScope } from '../src/scope.js'
import { endsSentence } from '../src/index.js'

// With `typingBreak: 'sentence'` one undo press undoes one sentence of typing:
// a step closes after the space or line break that follows `.`, `?` or `!`, at a
// field switch, at a switch between typing and deleting, after a command such as
// a paste or a format, when a selection is replaced, and at a caret jump. On
// every scope an open composition holds the idle step open. With the default
// (`typingBreak: null`) nothing changes.

const PAGE = '<!DOCTYPE html><html><head><title>T</title></head><body>' +
  '<div id="wrap">' +
  '<p id="plain" contenteditable="plaintext-only">Start</p>' +
  '<p id="second" contenteditable="plaintext-only">Second</p>' +
  '<div id="rich" no-undo contenteditable="true"><p>Rich</p></div>' +
  '<div id="editor" contenteditable="true"><p id="line">Hi</p></div>' +
  '</div>' +
  '<p id="outside" contenteditable="plaintext-only">Outside.</p>' +
  '</body></html>'

function page(opts = {}) {
  const dom = makeDom(PAGE)
  const doc = dom.window.document
  const scope = createScope({ scope: opts.scope || doc.body, idleWindowMs: 10_000, ...opts })
  scope.start()
  const rich = doc.getElementById('rich')
  scope.trackContent(rich, { read: (el) => el.innerHTML, write: (el, html) => { el.innerHTML = html } })
  return { dom, doc, scope, rich }
}

const SENTENCE = { typingBreak: 'sentence' }

async function empty(plain, scope) {
  plain.firstChild.data = ''
  await tick(2)
  scope.clear()
}

function beforeInput(dom, field, inputType, data = null) {
  field.dispatchEvent(new dom.window.InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType, data }))
}

function inputEvent(dom, field, inputType, data = null) {
  field.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true, inputType, data }))
}

async function typeOne(dom, field, inputType, data) {
  const doc = dom.window.document
  const node = field.firstChild
  doc.getSelection().collapse(node, node.data.length)
  beforeInput(dom, field, inputType, data)
  node.data += data == null ? '\n' : data
  inputEvent(dom, field, inputType, data)
  await tick(1)
}

async function typeText(dom, field, text) {
  for (const ch of text) {
    await typeOne(dom, field, ch === '\n' ? 'insertParagraph' : 'insertText', ch === '\n' ? null : ch)
  }
}

async function backspace(dom, field) {
  const doc = dom.window.document
  const node = field.firstChild
  doc.getSelection().collapse(node, node.data.length)
  beforeInput(dom, field, 'deleteContentBackward')
  node.data = node.data.slice(0, -1)
  inputEvent(dom, field, 'deleteContentBackward')
  await tick(1)
}

async function paste(dom, field, text) {
  const doc = dom.window.document
  const node = field.firstChild
  doc.getSelection().collapse(node, node.data.length)
  beforeInput(dom, field, 'insertFromPaste')
  node.data += text
  inputEvent(dom, field, 'insertFromPaste')
  await tick(1)
}

test('a sentence end closes the step after the space, so the space belongs to the sentence', async () => {
  const { dom, doc, scope } = page(SENTENCE)
  const plain = doc.getElementById('plain')
  await empty(plain, scope)
  await typeText(dom, plain, 'Hello world. Next one')
  scope.flush()
  assert.equal(scope.history.length, 2)
  scope.undo(); assert.equal(plain.textContent, 'Hello world. ')
  scope.undo(); assert.equal(plain.textContent, '')
  scope.stop()
})

test('the same holds for ? and !', async () => {
  for (const mark of ['?', '!']) {
    const { dom, doc, scope } = page(SENTENCE)
    const plain = doc.getElementById('plain')
    await empty(plain, scope)
    await typeText(dom, plain, `Hello world${mark} Next one`)
    scope.flush()
    assert.equal(scope.history.length, 2, mark)
    scope.undo(); assert.equal(plain.textContent, `Hello world${mark} `, mark)
    scope.stop()
  }
})

test('the rule is simple: an abbreviation breaks, a decimal does not', async () => {
  const abbr = page(SENTENCE)
  const aPlain = abbr.doc.getElementById('plain')
  await empty(aPlain, abbr.scope)
  await typeText(abbr.dom, aPlain, 'e.g. this')
  abbr.scope.flush()
  assert.equal(abbr.scope.history.length, 2)
  abbr.scope.stop()

  const dec = page(SENTENCE)
  const dPlain = dec.doc.getElementById('plain')
  await empty(dPlain, dec.scope)
  await typeText(dec.dom, dPlain, '3.5 percent')
  dec.scope.flush()
  assert.equal(dec.scope.history.length, 1)
  dec.scope.stop()
})

test('a closing quote is skipped over before the break', async () => {
  const { dom, doc, scope } = page(SENTENCE)
  const plain = doc.getElementById('plain')
  await empty(plain, scope)
  await typeText(dom, plain, 'He said "stop." Then')
  scope.flush()
  assert.equal(scope.history.length, 2)
  scope.undo(); assert.equal(plain.textContent, 'He said "stop." ')
  scope.stop()
})

test('a line break after a sentence breaks, and the break belongs to the first entry', async () => {
  for (const type of ['insertParagraph', 'insertLineBreak']) {
    const { dom, doc, scope } = page(SENTENCE)
    const plain = doc.getElementById('plain')
    await empty(plain, scope)
    await typeText(dom, plain, 'One two.')
    await typeOne(dom, plain, type, null)
    await typeText(dom, plain, 'Three four')
    scope.flush()
    assert.equal(scope.history.length, 2, type)
    scope.undo(); assert.equal(plain.textContent, 'One two.\n', type)
    scope.stop()
  }
})

test('a space that does not follow a sentence end does not break', async () => {
  const { dom, doc, scope } = page(SENTENCE)
  const plain = doc.getElementById('plain')
  await empty(plain, scope)
  await typeText(dom, plain, 'one two three four')
  scope.flush()
  assert.equal(scope.history.length, 1)
  scope.stop()
})

test('with the option off the same typing is one step', async () => {
  const { dom, doc, scope } = page()
  const plain = doc.getElementById('plain')
  await empty(plain, scope)
  await typeText(dom, plain, 'Hello world. Next one? Yes')
  scope.flush()
  assert.equal(scope.history.length, 1)
  scope.stop()
})

test('a composing space does not break', async () => {
  const { dom, doc, scope } = page(SENTENCE)
  const plain = doc.getElementById('plain')
  await empty(plain, scope)
  await typeText(dom, plain, 'Hello world.')
  const node = plain.firstChild
  doc.getSelection().collapse(node, node.data.length)
  plain.dispatchEvent(new dom.window.InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: ' ', isComposing: true }))
  node.data += ' '
  inputEvent(dom, plain, 'insertText', ' ')
  await tick(1)
  await typeText(dom, plain, 'Next')
  scope.flush()
  assert.equal(scope.history.length, 1)
  assert.equal(plain.textContent, 'Hello world. Next')
  scope.stop()
})

test('an event outside the scope root does not break', async () => {
  const dom = makeDom(PAGE)
  const doc = dom.window.document
  const scope = createScope({ scope: doc.getElementById('wrap'), idleWindowMs: 10_000, typingBreak: 'sentence' })
  scope.start()
  const plain = doc.getElementById('plain')
  const outside = doc.getElementById('outside')
  await empty(plain, scope)
  await typeText(dom, plain, 'Hello world.')
  const node = outside.firstChild
  doc.getSelection().collapse(node, node.data.length)
  beforeInput(dom, outside, 'insertText', ' ')
  node.data += ' '
  inputEvent(dom, outside, 'insertText', ' ')
  await tick(1)
  scope.flush()
  assert.equal(scope.history.length, 1)
  scope.stop()
})

test('an open composition holds the idle step open', async () => {
  const run = async (compose) => {
    const { dom, doc, scope } = page({ idleWindowMs: 30 })
    const plain = doc.getElementById('plain')
    if (compose) plain.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true }))
    plain.firstChild.data += 'a'
    await tick(80)
    plain.firstChild.data += 'b'
    if (compose) plain.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true }))
    await tick(80)
    const count = scope.history.length
    scope.stop()
    return count
  }
  assert.equal(await run(true), 1)
  assert.equal(await run(false), 2)
})

test('typing, deleting and typing again makes three steps', async () => {
  const { dom, doc, scope } = page(SENTENCE)
  const plain = doc.getElementById('plain')
  await empty(plain, scope)
  await typeText(dom, plain, 'abc')
  await backspace(dom, plain)
  await backspace(dom, plain)
  await backspace(dom, plain)
  await typeText(dom, plain, 'xy')
  scope.flush()
  assert.equal(scope.history.length, 3)
  scope.undo(); scope.undo()
  assert.equal(plain.textContent, 'abc')
  scope.stop()
})

test('a switch to another field and back makes a step each', async () => {
  const { dom, doc, scope } = page(SENTENCE)
  const plain = doc.getElementById('plain')
  const second = doc.getElementById('second')
  await empty(plain, scope)
  second.firstChild.data = ''
  await tick(2)
  scope.clear()
  await typeText(dom, plain, 'aaa')
  await typeText(dom, second, 'bbb')
  await typeText(dom, plain, 'ccc')
  scope.flush()
  assert.equal(scope.history.length, 3)
  scope.stop()
})

test('a paste in the middle of typing is one step of its own, unsplit by its sentences', async () => {
  const { dom, doc, scope } = page(SENTENCE)
  const plain = doc.getElementById('plain')
  await empty(plain, scope)
  await typeText(dom, plain, 'Before ')
  await paste(dom, plain, 'One. Two. Three. ')
  await typeText(dom, plain, 'after')
  scope.flush()
  assert.equal(scope.history.length, 3)
  scope.undo(); assert.equal(plain.textContent, 'Before One. Two. Three. ')
  scope.stop()
})

test('a format command is a step of its own', async () => {
  const { dom, doc, scope } = page(SENTENCE)
  const plain = doc.getElementById('plain')
  await empty(plain, scope)
  await typeText(dom, plain, 'abc')
  const node = plain.firstChild
  doc.getSelection().collapse(node, node.data.length)
  beforeInput(dom, plain, 'formatBold')
  plain.setAttribute('data-bold', '1')
  inputEvent(dom, plain, 'formatBold')
  await tick(1)
  scope.flush()
  assert.equal(scope.history.length, 2)
  scope.undo(); assert.equal(plain.hasAttribute('data-bold'), false)
  scope.stop()
})

test('a caret jump with the mouse or a navigation key closes the step', async () => {
  const mouse = page(SENTENCE)
  const mPlain = mouse.doc.getElementById('plain')
  await empty(mPlain, mouse.scope)
  await typeText(mouse.dom, mPlain, 'abc')
  mPlain.dispatchEvent(new mouse.dom.window.Event('pointerdown', { bubbles: true }))
  await typeText(mouse.dom, mPlain, 'de')
  mouse.scope.flush()
  assert.equal(mouse.scope.history.length, 2)
  mouse.scope.stop()

  const keys = page(SENTENCE)
  const kPlain = keys.doc.getElementById('plain')
  await empty(kPlain, keys.scope)
  await typeText(keys.dom, kPlain, 'abc')
  kPlain.dispatchEvent(new keys.dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowLeft' }))
  await typeText(keys.dom, kPlain, 'd')
  keys.scope.flush()
  assert.equal(keys.scope.history.length, 2)
  keys.scope.stop()
})

test('typing that replaces a selection closes the step first', async () => {
  const { dom, doc, scope } = page(SENTENCE)
  const plain = doc.getElementById('plain')
  await empty(plain, scope)
  await typeText(dom, plain, 'abc')
  const node = plain.firstChild
  doc.getSelection().setBaseAndExtent(node, 1, node, 2)
  beforeInput(dom, plain, 'insertText', 'X')
  node.data = 'aXc'
  inputEvent(dom, plain, 'insertText', 'X')
  await tick(1)
  scope.flush()
  assert.equal(scope.history.length, 2)
  scope.undo(); assert.equal(plain.textContent, 'abc')
  scope.stop()
})

test('an Enter a rich editor inserts itself still closes the step', async () => {
  const { dom, doc, scope } = page(SENTENCE)
  const editor = doc.getElementById('editor')
  const line = doc.getElementById('line')
  line.firstChild.data = ''
  await tick(2)
  scope.clear()
  line.addEventListener('beforeinput', (event) => {
    if (event.inputType !== 'insertParagraph') return
    event.preventDefault()
    const p = doc.createElement('p')
    p.textContent = 'Next'
    editor.appendChild(p)
  })
  await typeText(dom, line, 'One two.')
  doc.getSelection().collapse(line.firstChild, line.firstChild.data.length)
  beforeInput(dom, line, 'insertParagraph')
  await tick(1)
  assert.equal(scope.history.length, 1)
  scope.undo()
  assert.equal(editor.innerHTML, '<p id="line"></p>')
  scope.stop()
})

test('with the option off a field switch, a delete run and a caret jump are one step', async () => {
  const fields = page()
  const fPlain = fields.doc.getElementById('plain')
  const fSecond = fields.doc.getElementById('second')
  await empty(fPlain, fields.scope)
  fSecond.firstChild.data = ''
  await tick(2)
  fields.scope.clear()
  await typeText(fields.dom, fPlain, 'aaa')
  await typeText(fields.dom, fSecond, 'bbb')
  await typeText(fields.dom, fPlain, 'ccc')
  fields.scope.flush()
  assert.equal(fields.scope.history.length, 1, 'field switch')
  fields.scope.stop()

  const dels = page()
  const dPlain = dels.doc.getElementById('plain')
  await empty(dPlain, dels.scope)
  await typeText(dels.dom, dPlain, 'abc')
  await backspace(dels.dom, dPlain)
  await backspace(dels.dom, dPlain)
  await backspace(dels.dom, dPlain)
  await typeText(dels.dom, dPlain, 'xy')
  dels.scope.flush()
  assert.equal(dels.scope.history.length, 1, 'delete run')
  dels.scope.stop()

  const jumps = page()
  const jPlain = jumps.doc.getElementById('plain')
  await empty(jPlain, jumps.scope)
  await typeText(jumps.dom, jPlain, 'abc')
  jPlain.dispatchEvent(new jumps.dom.window.Event('pointerdown', { bubbles: true }))
  await typeText(jumps.dom, jPlain, 'de')
  jumps.scope.flush()
  assert.equal(jumps.scope.history.length, 1, 'caret jump')
  jumps.scope.stop()
})

test('endsSentence is exported', () => {
  assert.equal(endsSentence('Hello world.'), true)
  assert.equal(endsSentence('He said "stop."'), true)
  assert.equal(endsSentence('Hello world'), false)
})

test('events dispatched on window itself never throw in the typing watcher', () => {
  for (const opts of [{}, SENTENCE]) {
    const { dom, scope } = page(opts)
    const errors = []
    dom.window.addEventListener('error', (event) => errors.push(event.error || event.message))
    for (const type of ['keydown', 'pointerdown', 'compositionstart', 'compositionend', 'input']) {
      dom.window.dispatchEvent(new dom.window.Event(type, { bubbles: true, cancelable: true }))
    }
    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    dom.window.dispatchEvent(new dom.window.InputEvent('beforeinput', { inputType: 'insertText', data: ' ', bubbles: true, cancelable: true }))
    assert.deepEqual(errors, [])
    scope.stop()
  }
})

test("an editor's own normalization before the first keystroke joins that keystroke's step", async () => {
  const { dom, doc, scope } = page(SENTENCE)
  const plain = doc.getElementById('plain')
  await empty(plain, scope)
  plain.firstChild ? plain.firstChild.data = 'Bare' : plain.appendChild(doc.createTextNode('Bare'))
  await tick(2)
  scope.clear()
  const wrap = doc.createElement('div')
  wrap.appendChild(plain.firstChild)
  plain.appendChild(wrap)
  await tick(2)
  await typeText(dom, wrap, ' more')
  scope.flush()
  assert.equal(scope.history.length, 1, 'no invisible step of its own for the wrap')
  scope.stop()
})

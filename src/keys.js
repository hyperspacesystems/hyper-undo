// Is the key being pressed inside a native editable control (or an editable
// subtree)? The browser's own undo belongs there, not the page stack's.
const NO_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'range', 'color'])

function pathOf(event) {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : []
  return path.length > 0 ? path : chainFromTarget(event.target)
}

function inFormControl(event) {
  for (const node of pathOf(event)) {
    if (!node || node.nodeType !== 1) continue
    const tag = String(node.tagName || '').toUpperCase()
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true
    // An input that takes no typed text has no native undo of its own: a checkbox,
    // a radio or a button leaves the key to the page stack.
    if (tag === 'INPUT' && !NO_TEXT_INPUTS.has(String(node.type || node.getAttribute?.('type') || 'text').toLowerCase())) return true
  }
  return false
}

function inEditable(event) {
  for (const node of pathOf(event)) {
    if (!node || node.nodeType !== 1) continue
    if (node.isContentEditable === true) return true
    // jsdom (and older engines) do not resolve isContentEditable, so read the
    // declaration itself; an unset or explicit "false" is not editable.
    const declared = node.getAttribute && node.getAttribute('contenteditable')
    if (declared != null && String(declared).toLowerCase() !== 'false') return true
  }
  return false
}

function inAny(target, selectors) {
  if (!target || !target.closest || !Array.isArray(selectors)) return false
  for (const selector of selectors) {
    try { if (target.closest(selector)) return true }
    catch (_) { /* invalid selector, skip */ }
  }
  return false
}

// Does this history key or history input belong to someone other than the page
// stack? "page" owns editable content the scope records; a form control, an
// authored no-undo region or another in-page editor keeps its own undo.
function standsDown(event, scope) {
  if (inFormControl(event)) return true
  const config = scope._config
  const target = event.target
  if (config.editableKeys !== 'page') return inEditable(event) || inAny(target, config.shadowKeydownIn)
  if (inAny(target, config.ownKeysIn) || scope._tracksContentAt(target)) return false
  if (inAny(target, config.shadowKeydownIn)) return true
  return inEditable(event) && !scope._recordsAt(target)
}

function chainFromTarget(target) {
  const out = []
  for (let node = target; node; node = node.parentNode || (node.host ?? null)) out.push(node)
  return out
}

// Installs a single window-level keydown listener in capture phase.
// Returns a cleanup function.

export function installKeys(scope, onDetached) {
  const handler = (event) => {
    // If the scope root was removed from the document, release the global
    // binding and let native Cmd+Z through instead of undoing a detached tree.
    const scopeEl = scope.scope
    if (scopeEl && scopeEl.nodeType === 1 && scopeEl.isConnected === false) {
      if (onDetached) onDetached()
      return
    }

    // A key the page already handled belongs to whoever handled it.
    if (event.defaultPrevented) return
    // The IME owns keys while it composes.
    if (event.isComposing || event.keyCode === 229) return
    if (standsDown(event, scope)) return

    const mod = event.metaKey || event.ctrlKey
    if (!mod) return

    const key = (event.key || '').toLowerCase()

    if (key === 'z' && !event.shiftKey) {
      event.preventDefault(); event.stopPropagation()
      scope.undo()
      return
    }
    if (key === 'z' && event.shiftKey) {
      event.preventDefault(); event.stopPropagation()
      scope.redo()
      return
    }
    if (key === 'y' && !event.shiftKey) {
      event.preventDefault(); event.stopPropagation()
      scope.redo()
      return
    }
  }

  // Chrome delivers the Edit menu's Undo as a cancellable beforeinput event.
  // Owned by the same rule as the key, it moves the page stack instead.
  const onHistoryInput = (event) => {
    if (event.inputType !== 'historyUndo' && event.inputType !== 'historyRedo') return
    const scopeEl = scope.scope
    if (scopeEl && scopeEl.nodeType === 1 && scopeEl.isConnected === false) return
    if (event.defaultPrevented || event.isComposing) return
    if (standsDown(event, scope)) return
    event.preventDefault(); event.stopPropagation()
    if (event.inputType === 'historyRedo') scope.redo()
    else scope.undo()
  }

  const ownsInput = scope._config.editableKeys === 'page'
  window.addEventListener('keydown', handler, true)
  if (ownsInput) window.addEventListener('beforeinput', onHistoryInput, true)
  return () => {
    window.removeEventListener('keydown', handler, true)
    if (ownsInput) window.removeEventListener('beforeinput', onHistoryInput, true)
  }
}

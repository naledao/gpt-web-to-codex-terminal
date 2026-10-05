/** Read-only browser structure capture. No message text, link values or raw message keys are returned. */
module.exports = function captureAttachmentStructure(page, filenames) {
  const names = [...new Set(filenames.filter(name => typeof name === 'string' && name.length > 0))].slice(0, 8)
  const state = window.__attachmentStructureState || (window.__attachmentStructureState = {
    nodes: new WeakMap(), keys: new Map(), nextNode: 1, nextKey: 1
  })
  const alias = (node) => {
    if (!state.nodes.has(node)) state.nodes.set(node, state.nextNode++)
    return state.nodes.get(node)
  }
  const keyAlias = (name, value) => {
    const key = name + ':' + value
    if (!state.keys.has(key)) state.keys.set(key, state.nextKey++)
    return state.keys.get(key)
  }
  const matchNames = value => names.map((name, index) => String(value || '').includes(name) ? index : -1).filter(index => index !== -1)
  const query = (node, selector) => [...node.querySelectorAll(selector)]
  const matches = (node, selectors) => selectors.filter(selector => node.matches(selector))
  const composer = (page.composerSelectors || []).map(selector => document.querySelector(selector)).find(Boolean)
  const messageSelectors = page.messageSelectors || []
  const assistantSelectors = page.assistantReplySelectors || []
  const keyAttributes = ['data-content-search-unit-key', 'data-content-search-turn-key', 'data-chatgpt-search-unit-key', 'data-chatgpt-selection-message-id', 'data-chatgpt-search-message-ids', 'data-turn-key', 'data-message-id', 'data-virtual-list-item-key']
  const attributeShape = (attribute) => {
    const value = String(attribute.value || '')
    const result = { name: attribute.name, length: value.length }
    if (keyAttributes.includes(attribute.name)) {
      result.keyAlias = keyAlias(attribute.name, value)
      result.roleSuffix = /:user$/.test(value) ? 'user' : /:assistant$/.test(value) ? 'assistant' : 'none'
      result.numeric = /^[0-9]+$/.test(value)
    } else if (['role', 'data-message-author-role'].includes(attribute.name) && /^(user|assistant|button|article|group|list|listitem|document|textbox|img|presentation)$/.test(value)) result.semanticRole = value
    return result
  }
  const describe = (node) => ({
    nodeAlias: alias(node), tag: String(node.tagName || '').toLowerCase(),
    classes: String(typeof node.className === 'string' ? node.className : '').slice(0, 250),
    attributes: [...(node.attributes || [])].filter(attribute => attribute.name.startsWith('data-') || ['role', 'title', 'aria-label', 'alt', 'href', 'src'].includes(attribute.name)).slice(0, 24).map(attributeShape),
    children: node.children.length, textLength: String(node.textContent || '').length,
    filenameMatches: matchNames(node.textContent),
    labelMatches: matchNames([node.getAttribute('title'), node.getAttribute('aria-label'), node.getAttribute('alt')].filter(Boolean).join(' ')),
    messageMatches: matches(node, messageSelectors),
    userUnit: !!page.fileUserTurnSelector && node.matches(page.fileUserTurnSelector),
    assistantMarker: matches(node, assistantSelectors).length > 0,
    messageDescendants: [...new Set(messageSelectors.flatMap(selector => query(node, selector)))].length,
    assistantDescendants: [...new Set(assistantSelectors.flatMap(selector => query(node, selector)))].length,
    images: query(node, 'img').length,
    containsComposer: !!composer && node.contains(composer)
  })
  const ancestors = (node) => {
    const result = []
    for (let parent = node, depth = 0; parent && parent !== document.body && depth < 12; parent = parent.parentElement, depth++) result.push({ depth, ...describe(parent) })
    return result
  }
  const tree = (node, budget, depth = 0) => {
    if (budget.remaining-- <= 0) return { truncated: true }
    const result = describe(node)
    if (depth < 4) result.nodes = [...node.children].slice(0, 12).map(child => tree(child, budget, depth + 1))
    else result.truncated = node.children.length > 0
    return result
  }
  // Search by the requested filename, independent of the app's turn selectors.
  // A text match is recorded only at its innermost element; no text is copied.
  const candidates = names.length ? query(document.body, '*').filter(node => {
    if (node.closest('script,style,textarea,input,[contenteditable="true"]')) return false
    const text = matchNames(node.textContent)
    const label = matchNames([node.getAttribute('title'), node.getAttribute('aria-label'), node.getAttribute('alt')].filter(Boolean).join(' '))
    return label.length > 0 || (text.length > 0 && ![...node.children].some(child => matchNames(child.textContent).length > 0))
  }) : []
  const selectorCounts = [...new Set([...messageSelectors, ...assistantSelectors, ...(page.fileUserTurnSelector ? [page.fileUserTurnSelector] : []), ...keyAttributes.map(name => '[' + name + ']')])].map(selector => ({ selector, count: query(document, selector).length }))
  const messageNodes = [...new Set(messageSelectors.flatMap(selector => query(document, selector)))].slice(-8)
  return {
    schema: 1, requestedNames: names.length, candidateCount: candidates.length, selectorCounts,
    latestMessages: messageNodes.map(node => ({ ...describe(node), ancestors: ancestors(node) })),
    filenameNodes: candidates.slice(-16).map(node => ({
      ...describe(node), ancestors: ancestors(node),
      nearbyTree: tree(node.parentElement || node, { remaining: 60 })
    }))
  }
}

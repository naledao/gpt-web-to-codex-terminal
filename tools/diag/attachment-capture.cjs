/** Read-only browser observer. Serialized into the page; never clicks, types or submits. */
module.exports = function captureAttachments(page, sampleNames, options = {}) {
  const isGemini = options.platformId === 'gemini'
  const isChatGpt = options.platformId === 'chatgpt'
  const captureNameParts = isGemini || options.captureNameParts === true
  const stateKey = isGemini ? '__geminiAttachmentProbe' : isChatGpt ? '__chatgptAttachmentProbe' : '__claudeAttachmentProbe'
  const state = window[stateKey] || (window[stateKey] = {
    nodes: new WeakMap(), keys: new Map(), routes: new Map(), names: [], events: [],
    nextNode: 1, nextKey: 1, nextRoute: 1, sequence: 0, listening: false
  })
  const query = (root, selector) => [...root.querySelectorAll(selector)]
  const select = selectors => [...new Set(selectors.flatMap(selector => query(document, selector)))]
  const nodeAlias = node => {
    if (!state.nodes.has(node)) state.nodes.set(node, state.nextNode++)
    return state.nodes.get(node)
  }
  const keyAlias = (name, value) => {
    const key = name + ':' + value
    if (!state.keys.has(key)) state.keys.set(key, state.nextKey++)
    return state.keys.get(key)
  }
  // Filenames are used only inside the page to locate cards; arbitrary names never leave it.
  const rememberName = name => {
    if (name && !state.names.includes(name) && state.names.length < 32) state.names.push(name)
    return state.names.indexOf(name)
  }
  sampleNames.forEach(rememberName)
  const nameMatches = value => state.names.flatMap((name, index) => String(value || '').includes(name) ? [index] : [])
  // A site may render the basename and extension in separate children. These
  // flags discover that layout; a partial match is never an upload verdict.
  const namePartMatches = value => {
    const text = String(value || '').normalize('NFKC').toLowerCase()
    return state.names.flatMap((name, index) => {
      const dot = name.lastIndexOf('.')
      const stem = (dot > 0 ? name.slice(0, dot) : name).normalize('NFKC').toLowerCase()
      const extension = dot > 0 ? name.slice(dot + 1).normalize('NFKC').toLowerCase() : ''
      const stemMatch = !!stem && text.includes(stem)
      const extensionMatch = !!extension && text.includes(extension)
      const compactMatch = text.replace(/\s+/g, '').includes(name.normalize('NFKC').toLowerCase().replace(/\s+/g, ''))
      return stemMatch || extensionMatch || compactMatch ? [{ index, stemMatch, extensionMatch, compactMatch }] : []
    })
  }
  // Report truncated-name candidates as evidence, without returning the displayed text.
  const truncatedNameCandidates = value => {
    const parts = String(value || '').trim().split(/\u2026|\.{3}/)
    if (parts.length !== 2 || parts[0].length < (options.allowShortTruncation === true ? 3 : 12)) return []
    const prefix = parts[0].normalize('NFKC')
    const suffix = parts[1].normalize('NFKC')
    const indices = state.names.flatMap((name, index) => name.normalize('NFKC').startsWith(prefix) && name.normalize('NFKC').endsWith(suffix) ? [index] : [])
    return indices.map(index => ({ index, prefixLength: prefix.length, suffixLength: suffix.length, ambiguous: indices.length > 1 }))
  }
  const composers = select(page.composerSelectors)
  const composer = (isChatGpt && composers.find(node => node.contains(document.activeElement) && node.getClientRects().length > 0)) ||
    composers.find(node => node.getClientRects().length > 0) || composers[0]
  const messageSelectors = [...new Set([...page.messageSelectors, ...page.assistantSelectors, ...(page.fileUserTurnSelector ? [page.fileUserTurnSelector] : [])])]
  const messageNodes = [...new Set(select(messageSelectors).map(node => page.fileUserTurnSelector ? node.closest(page.fileUserTurnSelector) || node : node))]
  const assistantNodes = select(page.assistantSelectors)
  const matchesAny = (node, selectors) => selectors.some(selector => node.matches(selector))
  const controlSelector = 'button,[role="button"],[role="menuitem"],label'
  const visible = node => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden'
  const disabled = node => node.disabled === true || node.getAttribute('aria-disabled') === 'true'
  const testId = value => /^[a-z][a-z0-9_-]{0,79}$/i.test(value || '') &&
    !/[a-f0-9]{8}-[a-f0-9-]{27,}/i.test(value) && nameMatches(value).length === 0 ? value : undefined
  const semanticTokens = value => {
    const text = String(value || '').toLowerCase()
    return ['upload', 'attach', 'file', 'remove', 'delete', 'send', 'stop', 'retry', 'cancel', 'loading', 'error', 'failed', 'unsupported', 'invalid', 'computer', 'device', 'drive', '上传', '附件', '文件', '移除', '删除', '发送', '停止', '重试', '取消', '失败', '不支持', '无效', '本地', '计算机', '设备', '云盘']
      .filter(word => text.includes(word))
  }
  const attributeShape = attribute => {
    const value = String(attribute.value || '')
    const shape = { name: attribute.name, length: value.length }
    if ((attribute.name === 'id' || /^data-.*(?:id|key|uuid|index|position)$/.test(attribute.name)) && !/^data-test-?id$/.test(attribute.name) && value) {
      shape.keyAlias = keyAlias(attribute.name, value)
      shape.numeric = /^[0-9]+$/.test(value)
      if (shape.numeric && /(?:index|position)$/.test(attribute.name) && Number.isSafeInteger(Number(value))) shape.position = Number(value)
    }
    if (['data-testid', 'data-test-id'].includes(attribute.name)) shape.marker = testId(value)
    if (attribute.name === 'role' && /^(button|menuitem|menu|dialog|status|alert|progressbar|textbox|img|list|listitem|group|article|presentation|tooltip)$/.test(value)) shape.semantic = value
    if (['data-state', 'data-is-streaming', 'aria-busy', 'aria-disabled', 'contenteditable', 'type'].includes(attribute.name) && /^(true|false|open|closed|loading|complete|error|file|button|submit)$/.test(value)) shape.semantic = value
    return shape
  }
  const referenceEvidence = node => ['aria-describedby', 'aria-labelledby'].flatMap(attribute =>
    String(node.getAttribute(attribute) || '').trim().split(/\s+/).filter(Boolean).slice(0, 8).map(id => {
      const target = document.getElementById(id)
      return {
        attribute, keyAlias: keyAlias('id', id), found: !!target,
        ...(target ? {
          nodeAlias: nodeAlias(target), tag: target.tagName.toLowerCase(), visible: visible(target),
          textLength: String(target.textContent || '').length, textNameMatches: nameMatches(target.textContent),
          namePartMatches: namePartMatches(target.textContent)
        } : {})
      }
    }))
  const imageShape = node => {
    const src = String(node.getAttribute('src') || '')
    return {
      sourceKind: !src ? 'empty' : /^blob:/i.test(src) ? 'blob' : /^data:/i.test(src) ? 'data' : /^https?:/i.test(src) ? 'http' : 'other',
      complete: node.complete === true,
      width: Number(node.width) || 0, height: Number(node.height) || 0,
      naturalWidth: Number(node.naturalWidth) || 0, naturalHeight: Number(node.naturalHeight) || 0
    }
  }
  const describe = node => ({
    nodeAlias: nodeAlias(node), tag: node.tagName.toLowerCase(),
    classes: String(typeof node.className === 'string' ? node.className : '').split(/\s+/)
      .filter(value => !nameMatches(value).length && !/https?:|[a-f0-9]{16,}|[a-f0-9]{8}-[a-f0-9-]{27,}/i.test(value)).join(' ').slice(0, 400),
    attributes: [...node.attributes].filter(attribute => /^data-|^aria-|^(role|title|alt|href|src|id|contenteditable|type)$/.test(attribute.name)).slice(0, 32).map(attributeShape),
    visible: visible(node), disabled: disabled(node), childCount: node.children.length,
    textLength: String(node.textContent || '').length,
    textNameMatches: nameMatches(node.textContent),
    truncatedNameCandidates: truncatedNameCandidates(node.textContent),
    labelNameMatches: nameMatches([node.getAttribute('title'), node.getAttribute('aria-label'), node.getAttribute('alt')].filter(Boolean).join(' ')),
    ...(captureNameParts ? {
      namePartMatches: namePartMatches(node.textContent), references: referenceEvidence(node),
      labelNamePartMatches: namePartMatches([node.getAttribute('title'), node.getAttribute('aria-label'), node.getAttribute('alt')].filter(Boolean).join(' ')),
      nameLayout: {
        lineBreakCount: (String(node.textContent || '').match(/[\r\n]/g) || []).length,
        ellipsisCount: (String(node.textContent || '').match(/…|\.{3}/g) || []).length
      },
      ...(node.tagName.toLowerCase() === 'img' ? { image: imageShape(node) } : {})
    } : {}),
    controlTokens: node.matches(controlSelector) ? semanticTokens(node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent) : [],
    messageMatches: messageSelectors.filter(selector => node.matches(selector)),
    messageCount: messageNodes.filter(message => node === message || node.contains(message)).length,
    assistantDescendants: assistantNodes.filter(message => node !== message && node.contains(message)).length,
    containsComposer: !!composer && (node === composer || node.contains(composer)),
    images: query(node, 'img').length,
    progressCount: query(node, '[role="progressbar"],[aria-busy="true"]').length
  })
  const ancestors = (node, limit = 10) => {
    const rows = []
    for (let parent = node, depth = 0; parent && parent !== document.body && depth < limit; parent = parent.parentElement, depth++) rows.push({ depth, ...describe(parent) })
    return rows
  }
  const tree = (node, budget, depth = 0, maxDepth = 5) => {
    if (budget.left-- <= 0) return { truncated: true }
    const result = describe(node)
    if (node === composer || node.matches('input,textarea,script,style')) return result
    if (depth < maxDepth) result.nodes = [...node.children].slice(0, 16).map(child => tree(child, budget, depth + 1, maxDepth))
    else result.truncated = node.children.length > 0
    return result
  }
  const inputShape = input => ({
    ...describe(input), accept: input.accept, multiple: input.multiple, disabled: input.disabled,
    files: [...(input.files || [])].map(file => ({
      nameIndex: rememberName(file.name), nameLength: file.name.length, size: file.size,
      mimeType: /^(?:text\/[a-z0-9.+-]+|image\/[a-z0-9.+-]+|application\/(?:pdf|json|octet-stream|javascript))$/i.test(file.type) ? file.type : '',
      mimeTypeLength: file.type.length
    })),
    ancestors: ancestors(input, 6)
  })
  const record = (kind, details) => {
    state.events.push({ sequence: ++state.sequence, kind, ...details })
    if (state.events.length > 80) state.events.shift()
  }
  // The composer may be replaced during navigation; listeners use the latest snapshot helpers.
  state.describe = describe
  state.inputShape = inputShape
  // Custom Angular elements may have no ARIA progress semantics. These are
  // discovery candidates, never interpreted as proof of an upload or failure.
  const customStatusNodes = () => isGemini ? query(document, '*').filter(node =>
    (/(?:progress|spinner|loading|error)/i.test(node.tagName) && node.tagName.includes('-')) ||
    /(?:progress|spinner|loading|uploading|error|invalid)/i.test(typeof node.className === 'string' ? node.className : '')) : []
  state.quickMarkers = () => [...new Set([...query(document, '[role="progressbar"],[aria-busy="true"],[role="alert"]'), ...customStatusNodes()])].slice(-12).map(describe)
  state.quickFileInputs = () => query(document, 'input[type="file"]').map(inputShape)
  const inputSignature = inputs => JSON.stringify(inputs.map(input => ({ nodeAlias: input.nodeAlias, accept: input.accept, multiple: input.multiple, disabled: input.disabled })))
  if (isGemini && state.lastFileInputs === undefined) state.lastFileInputs = inputSignature(state.quickFileInputs())
  if (!state.listening) {
    state.listening = true
    // Capture FileList synchronously, before the site's handlers can reset the native input.
    document.addEventListener('change', event => {
      if (event.target?.matches?.('input[type="file"]')) record('file-selection', { input: state.inputShape(event.target) })
    }, true)
    document.addEventListener('click', event => {
      const control = event.target?.closest?.(controlSelector)
      if (control) record('control-click', { control: state.describe(control) })
    }, true)
    document.addEventListener('keydown', event => {
      if (event.key === 'Enter' && event.target?.closest?.(page.composerSelectors.join(','))) record('composer-enter', { shift: event.shiftKey, composing: event.isComposing })
    }, true)
    // Uploads can finish between polling ticks. Observe semantic marker transitions without
    // touching the DOM or adding any second webRequest listener.
    const observer = new MutationObserver(() => {
      const markers = state.quickMarkers()
      const signature = JSON.stringify(markers)
      if (signature !== state.lastQuickMarkers) {
        state.lastQuickMarkers = signature
        record('upload-markers', { markers })
      }
      if (isGemini) {
        const inputs = state.quickFileInputs()
        const signature = inputSignature(inputs)
        if (signature !== state.lastFileInputs) {
          state.lastFileInputs = signature
          record('file-inputs', { inputs })
        }
      }
    })
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['role', 'aria-busy', 'aria-disabled', 'data-state', ...(isGemini ? ['class', 'disabled', 'aria-invalid', 'hidden', 'accept', 'multiple', 'type', 'aria-describedby', 'aria-labelledby'] : [])] })
  }
  const fileInputs = query(document, 'input[type="file"]')
  fileInputs.forEach(input => [...(input.files || [])].forEach(file => rememberName(file.name)))
  const composerAncestors = composer ? ancestors(composer, 10) : []
  const composerRoots = []
  for (let parent = composer?.parentElement, depth = 1; parent && parent !== document.body && depth < 10; parent = parent.parentElement, depth++) {
    if (messageNodes.some(message => parent === message || parent.contains(message))) break
    composerRoots.push(parent)
  }
  const region = composerRoots[composerRoots.length - 1] || composer
  const hasNameEvidence = node => nameMatches(node.textContent).length > 0 || truncatedNameCandidates(node.textContent).length > 0 ||
    (captureNameParts && namePartMatches(node.textContent).some(match => match.stemMatch || match.compactMatch))
  const candidates = state.names.length ? query(document, '*').filter(node => {
    if (node.closest('script,style,input,textarea,[contenteditable="true"]')) return false
    const label = nameMatches([node.getAttribute('title'), node.getAttribute('aria-label'), node.getAttribute('alt')].filter(Boolean).join(' '))
    const partialLabel = captureNameParts && namePartMatches([node.getAttribute('title'), node.getAttribute('aria-label'), node.getAttribute('alt')].filter(Boolean).join(' ')).some(match => match.stemMatch || match.compactMatch)
    return label.length > 0 || partialLabel || (hasNameEvidence(node) && ![...node.children].some(hasNameEvidence))
  }) : []
  const statuses = [...new Set([...query(document, '[role="progressbar"],[role="status"],[role="alert"],[aria-busy="true"]'), ...customStatusNodes()])]
  const route = location.origin + location.pathname
  if (!state.routes.has(route)) state.routes.set(route, state.nextRoute++)
  const markerCounts = new Map()
  query(document, '[data-testid],[data-test-id]').forEach(node => {
    for (const attr of ['data-testid', 'data-test-id']) {
      const value = testId(node.getAttribute(attr))
      if (value) markerCounts.set(attr + ':' + value, (markerCounts.get(attr + ':' + value) || 0) + 1)
    }
  })
  const customTags = new Map()
  if (isGemini) query(document, '*').forEach(node => {
    const tag = node.tagName.toLowerCase()
    if (tag.includes('-')) customTags.set(tag, (customTags.get(tag) || 0) + 1)
  })
  return {
    schema: 1,
    page: { origin: location.origin, routeAlias: state.routes.get(route), pathKind: (isGemini ? /^\/app\/[^/]+\/?$/.test(location.pathname) : isChatGpt ? /^\/c\//.test(location.pathname) : /^\/chat\//.test(location.pathname)) ? 'conversation' : location.pathname === (isGemini ? '/app' : isChatGpt ? '/' : '/new') ? 'new' : 'other', readyState: document.readyState },
    ...(isChatGpt ? { viewport: { width: innerWidth, height: innerHeight, devicePixelRatio } } : {}),
    selectors: [...new Set([...page.composerSelectors, ...page.sendButtonSelectors, ...page.stopButtonSelectors, ...messageSelectors])].map(selector => ({ selector, count: query(document, selector).length })),
    markers: [...markerCounts].map(([marker, count]) => ({ marker, count })).sort((a, b) => b.count - a.count).slice(0, 80),
    customTags: [...customTags].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count).slice(0, 80),
    composer: composer ? { ...describe(composer), draftLength: String(composer.value ?? composer.innerText ?? '').length, draftEmpty: !String(composer.value ?? composer.innerText ?? '').trim(), ancestors: composerAncestors } : null,
    sendControls: select(page.sendButtonSelectors).map(describe), stopControls: select(page.stopButtonSelectors).map(describe),
    fileInputs: fileInputs.map(inputShape),
    composerRegion: region ? { root: describe(region), tree: tree(region, { left: isChatGpt ? 180 : 100 }, 0, isChatGpt ? 9 : 5), controls: query(region, controlSelector).slice(-30).map(describe) } : null,
    ...(isGemini ? { attachmentDetails: {
      // Start at the observed native card roots so outer Angular wrappers don't
      // consume the depth budget. Sent images stay inside a user-query carousel.
      draft: region ? query(region, 'uploader-file-preview').slice(-6).map(node => ({ ancestors: ancestors(node, 8), tree: tree(node, { left: 160 }, 0, 10) })) : [],
      sent: query(document, 'user-query-file-carousel').filter(node => node.closest('user-query')).slice(-4).map(node => ({ ancestors: ancestors(node, 12), tree: tree(node, { left: 240 }, 0, 10) }))
    } } : {}),
    menus: query(document, '[role="menu"],[role="dialog"],[data-state="open"]').filter(visible).slice(-8).map(node => ({ ...describe(node), tree: tree(node, { left: 60 }) })),
    statusNodes: statuses.slice(-20).map(node => ({ ...describe(node), statusTokens: semanticTokens(node.textContent), ancestors: ancestors(node, 4) })),
    messages: messageNodes.slice(-8).map(node => ({ ...describe(node), assistant: matchesAny(node, page.assistantSelectors) || (isGemini && page.assistantSelectors.some(selector => node.querySelector(selector))), ancestors: ancestors(node, 10), tree: tree(node, { left: 70 }) })),
    filenameNodes: candidates.slice(-18).map(node => ({ ...describe(node), ancestors: ancestors(node, 16), tree: tree(node.parentElement || node, { left: 55 }) })),
    knownFilenameCount: state.names.length, eventSequence: state.sequence, events: state.events.splice(0)
  }
}

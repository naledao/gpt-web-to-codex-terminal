/** Content-free request classification for the user-driven Gemini attachment probe. */
module.exports = function describeGeminiAttachmentRequest(details) {
  let url
  try { url = new URL(details.url) } catch { return { observe: false } }
  const headers = new Map(Object.entries(details.requestHeaders || {}).map(([key, value]) => [key.toLowerCase(), String(value)]))
  const method = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(details.method) ? details.method : 'other'
  const firstParty = url.origin === 'https://gemini.google.com'
  const googleService = /(^|\.)(google\.com|googleapis\.com|googleusercontent\.com|gstatic\.com)$/.test(url.hostname)
  const fileRelatedPath = /upload|attachment|files?/i.test(url.pathname)
  const uploadBody = /multipart\/form-data|application\/octet-stream|image\//i.test(headers.get('content-type') || '')
  const protocol = headers.get('x-goog-upload-protocol') || ''
  const commandParts = (headers.get('x-goog-upload-command') || '').split(',').map(value => value.trim())
  const uploadCommand = commandParts.length <= 3 && commandParts.every(value => ['start', 'upload', 'finalize', 'query', 'cancel'].includes(value)) ? commandParts.join(',') : ''
  const resumableUpload = headers.has('x-goog-upload-command') || headers.has('x-goog-upload-protocol') || headers.has('x-goog-upload-offset')
  const observe = ((firstParty || googleService) && ['POST', 'PUT', 'PATCH'].includes(method)) || method === 'PUT' ||
    (method === 'POST' && (uploadBody || resumableUpload || fileRelatedPath))
  return {
    observe, method,
    resourceType: ['mainFrame', 'subFrame', 'stylesheet', 'script', 'image', 'font', 'object', 'xhr', 'ping', 'cspReport', 'media', 'webSocket', 'other'].includes(details.resourceType) ? details.resourceType : 'other',
    firstParty, googleService, fileRelatedPath, uploadBody, resumableUpload,
    uploadProtocol: ['resumable', 'multipart', 'raw'].includes(protocol) ? protocol : '',
    uploadCommand, hasUploadOffset: headers.has('x-goog-upload-offset')
  }
}

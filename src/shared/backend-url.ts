/** Validate an API base address without contacting the server. Empty clears it. */
export function normalizeBackendUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('后端地址必须是文本。')
  const input = value.trim()
  if (!input) return ''
  if (/[\s\u0000-\u001f\u007f]/u.test(input) || input.includes('\\')) {
    throw new Error('后端地址不能包含空白、控制字符或反斜杠。')
  }
  const authority = input.match(/^https?:\/\/([^/?#]+)/i)?.[1]
  if (!authority) throw new Error('请填写以 http:// 或 https:// 开头的后端地址。')
  if (authority.includes('@')) throw new Error('后端地址不能包含用户名或密码。')
  if (input.includes('?') || input.includes('#')) {
    throw new Error('请填写后端基础地址，不要包含查询参数或 # 片段。')
  }
  const port = authority.match(/:(\d*)$/)?.[1]
  if (port !== undefined && (port === '' || Number(port) < 1 || Number(port) > 65535)) {
    throw new Error('端口必须是 1 到 65535 的整数。')
  }
  let address: URL
  try {
    address = new URL(input)
  } catch {
    throw new Error('后端地址格式无效，请检查主机、端口和部署路径。')
  }
  if (!address.hostname || !['http:', 'https:'].includes(address.protocol)) {
    throw new Error('后端地址缺少有效的 HTTP 或 HTTPS 主机。')
  }
  return address.origin + (address.pathname === '/' ? '' : address.pathname)
}

/** An absent or corrupt stored value must not prevent the desktop app opening. */
export function readBackendUrl(value: unknown): string {
  try {
    return normalizeBackendUrl(value ?? '')
  } catch {
    return ''
  }
}

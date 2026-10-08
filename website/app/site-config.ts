const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? ''

export const assetPath = (path: string): string => `${basePath}${path}`

export const REPOSITORY_URL = 'https://github.com/naledao/gpt-web-to-codex-terminal'
export const LATEST_RELEASE_URL = `${REPOSITORY_URL}/releases/latest`
export const WINDOWS_DOWNLOAD_URL = `${LATEST_RELEASE_URL}/download/GPT-Web-to-Codex-Terminal-Setup.exe`
export const LINUX_AGENT_DOWNLOAD_URL = `${LATEST_RELEASE_URL}/download/web2term-linux-amd64`
export const WEB2TERM_GUIDE_URL = `${REPOSITORY_URL}/blob/main/docs/web2term-desktop-connection.md`
export const LINUX_AGENT_GUIDE_URL = `${REPOSITORY_URL}/blob/main/agents/linux/README.md`

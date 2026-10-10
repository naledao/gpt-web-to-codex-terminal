import { app, session, shell } from "electron"
import { autoUpdater } from "electron-updater"
import type { UpdateStatus } from "../shared/types"

/**
 * Electron session partition the updater pins its network requests to.
 *
 * electron-updater creates its own session (see its ElectronHttpExecutor),
 * so a proxy set on the embed partitions never reaches it. This one does.
 * The unsigned macOS update checker also uses this partition for GitHub API
 * requests so the configured update proxy behaves consistently.
 */
const UPDATER_PARTITION = "electron-updater"
const RELEASE_API_URL = "https://api.github.com/repos/naledao/gpt-web-to-codex-terminal/releases/latest"
const MAC_DOWNLOAD_URL = "https://github.com/naledao/gpt-web-to-codex-terminal/releases/latest/download/GPT-Web-to-Codex-Terminal.dmg"

let broadcast: (status: UpdateStatus) => void = () => {}

let status: UpdateStatus = {
  phase: "idle",
  version: "",
  percent: 0,
  message: ""
}

function setStatus(patch: Partial<UpdateStatus>): void {
  status = { ...status, ...patch }
  broadcast(status)
}

export function getUpdateStatus(): UpdateStatus {
  return { ...status }
}

export function setUpdaterBroadcast(fn: (status: UpdateStatus) => void): void {
  broadcast = fn
}

/**
 * Point the updater session at the configured proxy.
 *
 * Called at startup and whenever the setting is saved. An empty string means
 * direct, matching how the embed proxy treats it.
 */
export async function applyUpdateProxy(proxy: string): Promise<void> {
  const updaterSession = session.fromPartition(UPDATER_PARTITION)
  try {
    if (proxy === "") await updaterSession.setProxy({ mode: "direct" })
    else await updaterSession.setProxy({ proxyRules: proxy })
    await updaterSession.closeAllConnections()
  } catch (error) {
    console.warn("[updater] failed to apply proxy:", (error as Error).message)
  }
}

let wired = false

function wireEvents(): void {
  if (wired) return
  wired = true

  // Download only when the user asks: a metered or proxied link should not
  // start pulling tens of megabytes the moment a check finds a new version.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on("checking-for-update", () => {
    setStatus({ phase: "checking", message: "" })
  })
  autoUpdater.on("update-available", (info) => {
    setStatus({ phase: "available", version: info.version, percent: 0, message: "" })
  })
  autoUpdater.on("update-not-available", () => {
    setStatus({ phase: "idle", version: "", percent: 0, message: "已是最新版本" })
  })
  autoUpdater.on("download-progress", (progress) => {
    setStatus({ phase: "downloading", percent: Math.round(progress.percent) })
  })
  autoUpdater.on("update-downloaded", (info) => {
    setStatus({ phase: "downloaded", version: info.version, percent: 100, message: "" })
  })
  autoUpdater.on("error", (error) => {
    setStatus({ phase: "error", message: error.message })
  })
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] => value.replace(/^v/i, "").split(".").map((part) => Number.parseInt(part, 10) || 0)
  const a = parse(left)
  const b = parse(right)
  const count = Math.max(a.length, b.length)
  for (let index = 0; index < count; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

async function checkUnsignedMacUpdate(): Promise<UpdateStatus> {
  setStatus({ phase: "checking", message: "" })
  try {
    const updaterSession = session.fromPartition(UPDATER_PARTITION)
    const response = await updaterSession.fetch(RELEASE_API_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `gpt-web-to-codex-terminal/${app.getVersion()}`
      }
    })
    if (!response.ok) throw new Error(`GitHub 更新检查失败：HTTP ${response.status}`)

    const release = (await response.json()) as { tag_name?: string }
    const latestVersion = release.tag_name?.replace(/^v/i, "") ?? ""
    if (!latestVersion) throw new Error("GitHub 最新 Release 缺少版本号")

    if (compareVersions(latestVersion, app.getVersion()) > 0) {
      setStatus({ phase: "available", version: latestVersion, percent: 0, message: "macOS 版本需下载 DMG 手动覆盖安装" })
    } else {
      setStatus({ phase: "idle", version: "", percent: 0, message: "已是最新版本" })
    }
  } catch (error) {
    setStatus({ phase: "error", message: (error as Error).message })
  }
  return getUpdateStatus()
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  if (!app.isPackaged) {
    setStatus({ phase: "error", message: "开发模式下不检查更新，请用打包后的应用测试。" })
    return getUpdateStatus()
  }

  // This project intentionally ships unsigned macOS builds. Squirrel.Mac /
  // electron-updater cannot safely install an unsigned replacement, so macOS
  // only checks GitHub Releases and hands the DMG download to the browser.
  if (process.platform === "darwin") return checkUnsignedMacUpdate()

  wireEvents()
  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    setStatus({ phase: "error", message: (error as Error).message })
  }
  return getUpdateStatus()
}

export async function downloadUpdate(): Promise<UpdateStatus> {
  if (process.platform === "darwin") {
    try {
      await shell.openExternal(MAC_DOWNLOAD_URL)
      setStatus({
        phase: "idle",
        percent: 0,
        message: "已在浏览器打开 macOS 安装包下载；下载 DMG 后请手动覆盖安装。"
      })
    } catch (error) {
      setStatus({ phase: "error", message: (error as Error).message })
    }
    return getUpdateStatus()
  }

  wireEvents()
  try {
    await autoUpdater.downloadUpdate()
  } catch (error) {
    setStatus({ phase: "error", message: (error as Error).message })
  }
  return getUpdateStatus()
}

export function installUpdate(): void {
  if (process.platform === "darwin") {
    void shell.openExternal(MAC_DOWNLOAD_URL)
    return
  }
  autoUpdater.quitAndInstall()
}

/** How often a running app re-checks for a new release. */
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000

let scheduleTimer: ReturnType<typeof setInterval> | null = null

/**
 * Check for updates now, then every 30 minutes while the app runs.
 *
 * Skipped in development: checkForUpdates refuses to run unpackaged, and a
 * timer would otherwise set the error state over and over with nothing to show.
 * The timer is unref-ed so it never keeps the process alive on its own.
 */
export function startUpdateSchedule(): void {
  if (!app.isPackaged || scheduleTimer !== null) return

  void checkForUpdates()

  scheduleTimer = setInterval(() => {
    // A Windows download in flight (or one already finished waiting to install)
    // is not something a background check should stomp on.
    if (status.phase === "downloading" || status.phase === "downloaded") return
    void checkForUpdates()
  }, UPDATE_CHECK_INTERVAL_MS)

  // Do not hold the event loop open just for this.
  scheduleTimer.unref?.()
}

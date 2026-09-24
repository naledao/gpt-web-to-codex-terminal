import { app, session } from "electron"
import { autoUpdater } from "electron-updater"
import type { UpdateStatus } from "../shared/types"

/**
 * Electron session partition the updater pins its network requests to.
 *
 * electron-updater creates its own session (see its ElectronHttpExecutor),
 * so a proxy set on the embed partitions never reaches it. This one does.
 */
const UPDATER_PARTITION = "electron-updater"

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
  autoUpdater.autoInstallOnAppQuit = true

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

export async function checkForUpdates(): Promise<UpdateStatus> {
  if (!app.isPackaged) {
    setStatus({ phase: "error", message: "开发模式下不检查更新，请用打包后的应用测试。" })
    return getUpdateStatus()
  }
  wireEvents()
  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    setStatus({ phase: "error", message: (error as Error).message })
  }
  return getUpdateStatus()
}

export async function downloadUpdate(): Promise<UpdateStatus> {
  wireEvents()
  try {
    await autoUpdater.downloadUpdate()
  } catch (error) {
    setStatus({ phase: "error", message: (error as Error).message })
  }
  return getUpdateStatus()
}

export function installUpdate(): void {
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
    // A download in flight (or one already finished waiting to install) is not
    // something a background check should stomp on.
    if (status.phase === 'downloading' || status.phase === 'downloaded') return
    void checkForUpdates()
  }, UPDATE_CHECK_INTERVAL_MS)

  // Do not hold the event loop open just for this.
  scheduleTimer.unref?.()
}

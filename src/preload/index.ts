import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { IpcChannels } from '../shared/types'
import type {
  AppApi,
  AppInfo,
  AppSettings,
  AppSettingsPatch,
  AutomationState,
  Conversation,
  EmbedAuthState,
  EmbedBounds,
  EmbedCommand,
  EmbedState,
  EnvironmentInfo,
  ExecutionMode,
  ExecutionRecord,
  ExternalAuthNotice,
  InterceptorStatus,
  ManagedSessionSummary,
  WorkspaceState,
  SessionImportDraft,
  SessionImportResult,
  SshHost,
  SshHostDraft,
  SshFileEntry,
  SshDownloadTask,
  SshUploadTask,
  SshTransferDirection,
  SshTransferTask,
  SshState,
  TerminalNotes,
  TerminalState,
  UpdateStatus
} from '../shared/types'

/**
 * The bridge exposed to the renderer. It is typed as `AppApi`, so removing or
 * changing a signature here fails the typecheck instead of breaking the UI.
 */
const api: AppApi = {
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke(IpcChannels.getAppInfo),

  listManagedSessions: (): Promise<ManagedSessionSummary[]> =>
    ipcRenderer.invoke(IpcChannels.managerSessionsList),

  createManagedSession: (kind: 'local' | 'ssh'): Promise<ManagedSessionSummary | null> =>
    ipcRenderer.invoke(IpcChannels.managerSessionCreate, kind),

  openManagedSession: (id: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.managerSessionOpen, id),

  renameManagedSession: (id: string, title: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.managerSessionRename, id, title),

  destroyManagedSession: (id: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.managerSessionDestroy, id),

  switchSessionPlatform: (platformId: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.sessionSwitchPlatform, platformId),

  onManagedSessionsChanged: (listener: (items: ManagedSessionSummary[]) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, items: ManagedSessionSummary[]): void => listener(items)
    ipcRenderer.on(IpcChannels.managerSessionsChanged, handler)
    return () => ipcRenderer.removeListener(IpcChannels.managerSessionsChanged, handler)
  },

  getWorkspaceState: (): Promise<WorkspaceState> => ipcRenderer.invoke(IpcChannels.workspaceGetState),

  showWorkspaceManager: (): Promise<boolean> => ipcRenderer.invoke(IpcChannels.workspaceShowManager),

  setWorkspaceSshDialogOpen: (open: boolean): void => {
    ipcRenderer.send(IpcChannels.workspaceSetOpenSshDialog, open)
  },

  onWorkspaceChanged: (listener: (state: WorkspaceState) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, state: WorkspaceState): void => listener(state)
    ipcRenderer.on(IpcChannels.workspaceChanged, handler)
    return () => ipcRenderer.removeListener(IpcChannels.workspaceChanged, handler)
  },

  getSshTransfers: (): Promise<SshTransferTask[]> =>
    ipcRenderer.invoke(IpcChannels.sshTransfersGet),

  cancelSshTransfer: (sessionId: string, direction: SshTransferDirection, id: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.sshTransferCancel, sessionId, direction, id),

  onSshTransfersChanged: (listener: (items: SshTransferTask[]) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, items: SshTransferTask[]): void => listener(items)
    ipcRenderer.on(IpcChannels.sshTransfersChanged, handler)
    return () => ipcRenderer.removeListener(IpcChannels.sshTransfersChanged, handler)
  },

  setEmbedBounds: (bounds: EmbedBounds): void => {
    ipcRenderer.send(IpcChannels.embedSetBounds, bounds)
  },

  setEmbedVisible: (visible: boolean): void => {
    ipcRenderer.send(IpcChannels.embedSetVisible, visible)
  },

  sendEmbedCommand: (command: EmbedCommand): void => {
    ipcRenderer.send(IpcChannels.embedCommand, command)
  },

  navigateEmbed: (url: string): void => {
    ipcRenderer.send(IpcChannels.embedNavigate, url)
  },

  getEmbedState: (): Promise<EmbedState> => ipcRenderer.invoke(IpcChannels.embedGetState),

  getExternalAuthNotice: (): Promise<ExternalAuthNotice | null> =>
    ipcRenderer.invoke(IpcChannels.embedGetExternalAuth),

  onExternalAuth: (listener: (notice: ExternalAuthNotice) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, notice: ExternalAuthNotice): void => listener(notice)
    ipcRenderer.on(IpcChannels.embedExternalAuth, handler)
    return () => {
      ipcRenderer.removeListener(IpcChannels.embedExternalAuth, handler)
    }
  },

  loginWithEmail: (): void => {
    ipcRenderer.send(IpcChannels.embedLoginWithEmail)
  },

  importSession: (draft: SessionImportDraft): Promise<SessionImportResult> =>
    ipcRenderer.invoke(IpcChannels.embedImportSession, draft),

  previewSessionImport: (draft: SessionImportDraft): Promise<SessionImportResult> =>
    ipcRenderer.invoke(IpcChannels.embedPreviewSession, draft),

  getEmbedAuthState: (): Promise<EmbedAuthState> =>
    ipcRenderer.invoke(IpcChannels.embedGetAuthState),

  openChatgptExternal: (): void => {
    ipcRenderer.send(IpcChannels.openChatgptExternal)
  },

  listConversations: (): Promise<Conversation[]> =>
    ipcRenderer.invoke(IpcChannels.conversationsList),

  syncConversations: (): Promise<Conversation[]> =>
    ipcRenderer.invoke(IpcChannels.conversationsSync),

removeConversation: (id: string): Promise<Conversation[]> =>
    ipcRenderer.invoke(IpcChannels.conversationsRemove, id),

  moveConversation: (id: string, projectId: string): Promise<Conversation[]> =>
    ipcRenderer.invoke(IpcChannels.conversationsMove, id, projectId),

  onConversationsChanged: (listener: (items: Conversation[]) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, items: Conversation[]): void => listener(items)
    ipcRenderer.on(IpcChannels.conversationsChanged, handler)
    return () => {
      ipcRenderer.removeListener(IpcChannels.conversationsChanged, handler)
    }
  },

  getInterceptorStatus: (): Promise<InterceptorStatus> =>
    ipcRenderer.invoke(IpcChannels.interceptorGetState),

  setInterceptorEnabled: (enabled: boolean): Promise<InterceptorStatus> =>
    ipcRenderer.invoke(IpcChannels.interceptorSetEnabled, enabled),

  endTask: (): Promise<InterceptorStatus> => ipcRenderer.invoke(IpcChannels.interceptorEndTask),

  onInterceptorEvent: (listener: (status: InterceptorStatus) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, status: InterceptorStatus): void => listener(status)
    ipcRenderer.on(IpcChannels.interceptorEvent, handler)
    return () => {
      ipcRenderer.removeListener(IpcChannels.interceptorEvent, handler)
    }
  },

  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IpcChannels.settingsGet),

  updateSettings: (patch: AppSettingsPatch): Promise<AppSettings> =>
    ipcRenderer.invoke(IpcChannels.settingsUpdate, patch),

  getEnvironment: (): Promise<EnvironmentInfo> => ipcRenderer.invoke(IpcChannels.environmentGet),

  onEnvironmentChanged: (listener: (info: EnvironmentInfo) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, info: EnvironmentInfo): void => listener(info)
    ipcRenderer.on(IpcChannels.environmentChanged, handler)
    return () => {
      ipcRenderer.removeListener(IpcChannels.environmentChanged, handler)
    }
  },

  listSshHosts: (): Promise<SshHost[]> => ipcRenderer.invoke(IpcChannels.sshListHosts),

  connectSsh: (draft: SshHostDraft): Promise<SshState> =>
    ipcRenderer.invoke(IpcChannels.sshConnect, draft),

  disconnectSsh: (): Promise<SshState> => ipcRenderer.invoke(IpcChannels.sshDisconnect),

  dismissSsh: (): Promise<SshState> => ipcRenderer.invoke(IpcChannels.sshDismiss),

  removeSshHost: (id: string): Promise<SshHost[]> =>
    ipcRenderer.invoke(IpcChannels.sshRemoveHost, id),

  getSshState: (): Promise<SshState> => ipcRenderer.invoke(IpcChannels.sshGetState),

  sendSshInput: (text: string): Promise<SshState> =>
    ipcRenderer.invoke(IpcChannels.sshInput, text),

  uploadSshFiles: (): Promise<SshState> => ipcRenderer.invoke(IpcChannels.sshUploadFiles),

  getSshUploads: (): Promise<SshUploadTask[]> => ipcRenderer.invoke(IpcChannels.sshUploadsGet),

  cancelSshUpload: (id: string): Promise<boolean> => ipcRenderer.invoke(IpcChannels.sshUploadCancel, id),

  onSshUploadsChanged: (listener: (items: SshUploadTask[]) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, items: SshUploadTask[]): void => listener(items)
    ipcRenderer.on(IpcChannels.sshUploadsChanged, handler)
    return () => ipcRenderer.removeListener(IpcChannels.sshUploadsChanged, handler)
  },

  listSshFiles: (path: string): Promise<SshFileEntry[]> =>
    ipcRenderer.invoke(IpcChannels.sshListFiles, path),

  downloadSshFile: (path: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.sshDownloadFile, path),

  getSshDownloads: (): Promise<SshDownloadTask[]> =>
    ipcRenderer.invoke(IpcChannels.sshDownloadsGet),

  cancelSshDownload: (id: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.sshDownloadCancel, id),

  onSshDownloadsChanged: (listener: (items: SshDownloadTask[]) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, items: SshDownloadTask[]): void => listener(items)
    ipcRenderer.on(IpcChannels.sshDownloadsChanged, handler)
    return () => ipcRenderer.removeListener(IpcChannels.sshDownloadsChanged, handler)
  },

  onSshChanged: (listener: (state: SshState) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, state: SshState): void => listener(state)
    ipcRenderer.on(IpcChannels.sshChanged, handler)
    return () => {
      ipcRenderer.removeListener(IpcChannels.sshChanged, handler)
    }
  },

  getAutomationState: (): Promise<AutomationState> =>
    ipcRenderer.invoke(IpcChannels.automationGetState),

  setAutomationMode: (mode: ExecutionMode): Promise<AutomationState> =>
    ipcRenderer.invoke(IpcChannels.automationSetMode, mode),

  setAutomationPaused: (paused: boolean): Promise<AutomationState> =>
    ipcRenderer.invoke(IpcChannels.automationSetPaused, paused),

  checkLastReply: (): Promise<AutomationState> =>
    ipcRenderer.invoke(IpcChannels.automationCheckNow),

  onAutomationChanged: (listener: (state: AutomationState) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, state: AutomationState): void => listener(state)
    ipcRenderer.on(IpcChannels.automationChanged, handler)
    return () => {
      ipcRenderer.removeListener(IpcChannels.automationChanged, handler)
    }
  },

  listExecutions: (conversationId: string): Promise<ExecutionRecord[]> =>
    ipcRenderer.invoke(IpcChannels.executionList, conversationId),

  runExecution: (messageId: string): Promise<ExecutionRecord[]> =>
    ipcRenderer.invoke(IpcChannels.executionRun, messageId),

  skipExecution: (messageId: string): Promise<ExecutionRecord[]> =>
    ipcRenderer.invoke(IpcChannels.executionSkip, messageId),

  onExecutionChanged: (listener: (records: ExecutionRecord[]) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, records: ExecutionRecord[]): void => listener(records)
    ipcRenderer.on(IpcChannels.executionChanged, handler)
    return () => {
      ipcRenderer.removeListener(IpcChannels.executionChanged, handler)
    }
  },

  getTerminalState: (): Promise<TerminalState> => ipcRenderer.invoke(IpcChannels.terminalGetState),

  sendTerminalInput: (text: string): Promise<TerminalState> =>
    ipcRenderer.invoke(IpcChannels.terminalInput, text),

  interruptTerminal: (): Promise<TerminalState> => ipcRenderer.invoke(IpcChannels.terminalInterrupt),
  resetTerminal: (): Promise<TerminalState> => ipcRenderer.invoke(IpcChannels.terminalReset),

  setTerminalCwd: (path: string): Promise<TerminalState> =>
    ipcRenderer.invoke(IpcChannels.terminalSetCwd, path),

  setTerminalSendDelay: (seconds: number): Promise<TerminalState> =>
    ipcRenderer.invoke(IpcChannels.terminalSetSendDelay, seconds),

  onTerminalChanged: (listener: (state: TerminalState) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, state: TerminalState): void => listener(state)
    ipcRenderer.on(IpcChannels.terminalChanged, handler)
    return () => {
      ipcRenderer.removeListener(IpcChannels.terminalChanged, handler)
    }
  },

  getTerminalNotes: (): Promise<TerminalNotes> =>
    ipcRenderer.invoke(IpcChannels.terminalNotesGet),

  setTerminalNotes: (text: string): Promise<TerminalNotes> =>
    ipcRenderer.invoke(IpcChannels.terminalNotesSet, text),

  onTerminalNotesChanged: (listener: (notes: TerminalNotes) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, notes: TerminalNotes): void => listener(notes)
    ipcRenderer.on(IpcChannels.terminalNotesChanged, handler)
    return () => {
      ipcRenderer.removeListener(IpcChannels.terminalNotesChanged, handler)
    }
  },

  onEmbedState: (listener: (state: EmbedState) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, state: EmbedState): void => listener(state)
    ipcRenderer.on(IpcChannels.embedState, handler)
    return () => {
      ipcRenderer.removeListener(IpcChannels.embedState, handler)
    }
  },

  getUpdateStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke(IpcChannels.updateGetState),
  checkForUpdates: (): Promise<UpdateStatus> => ipcRenderer.invoke(IpcChannels.updateCheck),
  downloadUpdate: (): Promise<UpdateStatus> => ipcRenderer.invoke(IpcChannels.updateDownload),
  installUpdate: (): Promise<void> => ipcRenderer.invoke(IpcChannels.updateInstall),

  onUpdateChanged: (listener: (status: UpdateStatus) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, status: UpdateStatus): void => listener(status)
    ipcRenderer.on(IpcChannels.updateChanged, handler)
    return () => {
      ipcRenderer.removeListener(IpcChannels.updateChanged, handler)
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error('[preload] failed to expose the API:', error)
  }
} else {
  // contextIsolation is enabled in this project; this is only a defensive fallback.
  ;(globalThis as unknown as { api: AppApi }).api = api
}

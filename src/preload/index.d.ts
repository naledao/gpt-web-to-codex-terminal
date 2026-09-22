import type { AppApi } from '../shared/types'

declare global {
  interface Window {
    /** Injected by `src/preload/index.ts` via `contextBridge`. */
    api: AppApi
  }
}

export {}

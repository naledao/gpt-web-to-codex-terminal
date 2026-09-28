import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    plugins: [react()],
    build: {
      // electron-vite leaves minification off by default for all three targets.
      // The renderer ships to users, so minify it; main/preload stay readable
      // (they are only a couple of kB and readable stack traces are worth more).
      minify: 'esbuild',
      rollupOptions: {
        // Two HTML entries: the workspace UI, and the standalone splash window
        // that covers the gap between window creation and the embedded chat
        // page finishing its first load. The splash has no script of its own
        // (pure CSS animation), so it costs one extra static file.
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          // Lives in the renderer root so the dev server serves it at /splash.html too.
          splash: resolve(__dirname, 'src/renderer/splash.html')
        }
      }
    }
  }
})
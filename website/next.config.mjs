import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = path.dirname(fileURLToPath(import.meta.url))
const basePath = (process.env.SITE_BASE ?? '').replace(/\/+$/, '')
const isPagesBuild = Boolean(process.env.SITE_BASE)

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: appRoot,
  basePath,
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
  ...(isPagesBuild ? { output: 'export', distDir: 'dist', trailingSlash: true } : {}),
  images: { unoptimized: true }
}

export default nextConfig

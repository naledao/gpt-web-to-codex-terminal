import { defineConfig } from 'astro/config'

const base = process.env.SITE_BASE || '/'
const site = process.env.SITE_URL || undefined

export default defineConfig({
  base,
  site,
  output: 'static',
})

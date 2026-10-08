import type { Metadata } from 'next'
import './globals.css'
import { assetPath } from './site-config'

export const metadata: Metadata = {
  title: 'GPT Web to Codex Terminal — 让对话抵达终端',
  description: '把 AI 对话、本机、SSH 与 web2term 远程终端放进同一个桌面工作区，配合 Git、MySQL、Redis 和 Nacos 工具箱完成开发任务。',
  icons: {
    icon: assetPath('/brand-icon.png'),
    shortcut: assetPath('/brand-icon.png'),
    apple: assetPath('/brand-icon.png'),
  },
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  )
}

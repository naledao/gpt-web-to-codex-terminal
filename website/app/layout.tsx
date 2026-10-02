import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'GPT Web to Codex Terminal — 让对话抵达终端',
  description: '把 AI 对话、终端和项目上下文放进同一个桌面工作区。',
  icons: {
    icon: '/brand-icon.png',
    shortcut: '/brand-icon.png',
    apple: '/brand-icon.png',
  },
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  )
}

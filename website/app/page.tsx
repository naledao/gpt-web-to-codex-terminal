'use client'

import { useState } from 'react'

type Step = {
  eyebrow: string
  title: string
  body: string
  command: string
  result: string
  tone: string
}

const steps: Step[] = [
  {
    eyebrow: '01 / INTENT',
    title: '把目标交给熟悉的模型。',
    body: '继续使用 ChatGPT、Claude、Gemini 或 DeepSeek。对话留在你已经习惯的界面里，工作区负责把上下文带到下一步。',
    command: '“检查这个项目为什么构建变慢。”',
    result: '模型读懂目标，开始提出可执行的检查。',
    tone: 'gold',
  },
  {
    eyebrow: '02 / COMMAND',
    title: '每条命令都在你眼前。',
    body: '终端自动捕获模型提出的下一条命令。你可以手动执行，也可以让它按步骤推进，随时暂停或结束任务。',
    command: '› npm run build -- --profile',
    result: '命令进入真实的本机或 SSH 环境。',
    tone: 'blue',
  },
  {
    eyebrow: '03 / RESULT',
    title: '结果回到同一段对话。',
    body: '退出码、输出和状态会回传给模型。它看见刚刚发生的事，下一步建议不再依赖猜测。',
    command: '✓ exit 0  ·  18.4s  ·  0 errors',
    result: '从“试试看”变成可检查、可继续的工作流。',
    tone: 'mint',
  },
]

const LATEST_RELEASE_URL = 'https://github.com/naledao/gpt-web-to-codex-terminal/releases/latest'
const WINDOWS_DOWNLOAD_URL = 'https://github.com/naledao/gpt-web-to-codex-terminal/releases/latest/download/GPT-Web-to-Codex-Terminal-Setup.exe'

const features = [
  {
    title: '一个工作区，四种模型入口',
    body: 'ChatGPT、Claude、Gemini 和 DeepSeek 各自保留登录态与对话，不用在浏览器标签之间来回找。',
    tag: 'MODEL SURFACES',
  },
  {
    title: '本机与 SSH，保持同一条线',
    body: '从当前项目目录开始，也可以切到远程主机。终端、文件和 Git 信息都围绕当前任务展开。',
    tag: 'LOCAL + REMOTE',
  },
  {
    title: '手动或自动，你掌握节奏',
    body: '要逐条确认，就用手动执行；想让任务连续推进，就打开自动模式。暂停、结束、检查上一条都在侧栏里。',
    tag: 'CONTROL LOOP',
  },
]

const modelPlatforms = [
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    icon: '/models/chatgpt.svg',
    detail: '内置网页会话 · 独立登录态',
    tone: 'blue',
  },
  {
    id: 'claude',
    name: 'Claude',
    icon: '/models/claude.svg',
    detail: '内置网页会话 · 独立登录态',
    tone: 'amber',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    icon: '/models/deepseek.svg',
    detail: '内置网页会话 · 独立登录态',
    tone: 'mint',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    icon: '/models/gemini.svg',
    detail: '支持导入浏览器登录态',
    tone: 'violet',
  },
]

function ArrowIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.5 8h10M8.5 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 2.5v7M5.25 7.75 8 10.5l2.75-2.75M3 12.5h10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function TerminalIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect x="2.3" y="3.1" width="15.4" height="13.8" rx="2.4" fill="none" stroke="currentColor" strokeWidth="1.35" />
      <path d="m5.3 7.2 2.4 2.3-2.4 2.3M9.4 12h4.1" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function Mark() {
  return <img className="brand-mark" src="/brand-icon.png" alt="" aria-hidden="true" />
}

export default function Home() {
  const [activeStep, setActiveStep] = useState(1)
  const [menuOpen, setMenuOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const step = steps[activeStep]

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setMenuOpen(false)
  }

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText('npm run build -- --profile')
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setCopied(false)
    }
  }

  return (
    <main className="site-shell">
      <div className="ambient ambient--left" aria-hidden="true" />
      <div className="ambient ambient--right" aria-hidden="true" />

      <header className="site-header">
        <button className="brand" onClick={() => scrollTo('top')} aria-label="回到首页">
          <Mark />
          <span className="brand-copy">
            <strong>GPT → Codex</strong>
            <span>TERMINAL WORKSPACE</span>
          </span>
        </button>
        <button className="menu-toggle" onClick={() => setMenuOpen((open) => !open)} aria-expanded={menuOpen} aria-label="打开导航">
          <span />
          <span />
        </button>
        <nav className={menuOpen ? 'site-nav site-nav--open' : 'site-nav'} aria-label="主导航">
          <button onClick={() => scrollTo('models')}>AI 平台</button>
          <button onClick={() => scrollTo('workflow')}>工作流</button>
          <button onClick={() => scrollTo('capabilities')}>能力</button>
          <button onClick={() => scrollTo('download')}>下载</button>
          <button className="nav-cta" onClick={() => scrollTo('download')}>
            开始使用 <ArrowIcon />
          </button>
        </nav>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <p className="hero-overline"><span className="live-dot" /> AI × 本机执行环境</p>
          <h1>让对话<br /><em>抵达终端。</em></h1>
          <p className="hero-lede">GPT Web to Codex Terminal 把模型对话、真实命令和项目上下文放进同一个工作区。少一次切换，多一条能走完的线。</p>
          <div className="hero-actions">
            <a className="button button--primary" href={WINDOWS_DOWNLOAD_URL} download>下载最新 Windows 版 <DownloadIcon /></a>
            <button className="text-link" onClick={() => scrollTo('workflow')}>先看它怎么工作 <ArrowIcon /></button>
          </div>
          <div className="platform-note"><span>Windows</span><small>· 当前仅提供 Windows 版本</small></div>
        </div>

        <div className="hero-demo" aria-label="对话到终端的工作流演示">
          <div className="sun-halo sun-halo--one" />
          <div className="sun-halo sun-halo--two" />
          <div className="hero-demo__topline"><span>WORKSPACE / LIVE</span><span><i className="status-dot" /> LOCAL · C:\\project</span></div>
          <div className="hero-demo__body">
            <div className="demo-sidebar">
              <span className="demo-sidebar__label">SESSIONS</span>
              <div className="session session--active"><span className="session-pulse" /><span>Build profile</span><small>now</small></div>
              <div className="session"><span className="session-line" /><span>SSH · staging</span><small>2m</small></div>
              <div className="session"><span className="session-line" /><span>Refactor API</span><small>1h</small></div>
              <div className="demo-sidebar__foot"><span className="avatar">K</span><span>workspace</span></div>
            </div>
            <div className="demo-main">
              <div className="demo-main__title"><span>对话</span><span className="demo-mode">TERMINAL MODE <b>ON</b></span></div>
              <div className="chat-line chat-line--human"><span className="chat-avatar">K</span><p>查一下这个项目的构建时间，顺便找出最慢的步骤。</p></div>
              <div className="chat-line chat-line--model"><span className="model-avatar"><TerminalIcon /></span><div><p>我先运行一次带 profile 的构建，拿到真实数据。</p><div className="command-line"><span>›</span><code>npm run build -- --profile</code><button onClick={copyCommand} aria-label="复制命令">{copied ? '已复制' : '复制'}</button></div></div></div>
              <div className="demo-terminal"><div className="demo-terminal__head"><span><i className="term-dot term-dot--red" /><i className="term-dot term-dot--yellow" /><i className="term-dot term-dot--green" /></span><span>OUTPUT / 18.4s</span></div><div className="terminal-lines"><p><span className="dim">01</span> vite v7.3.6 building for production...</p><p><span className="dim">02</span> transforming <b>128 modules</b></p><p><span className="dim">03</span> rendering chunks...</p><p className="terminal-success"><span className="dim">04</span> ✓ built in 18.4s</p></div></div>
            </div>
          </div>
          <div className="hero-demo__caption"><span><b>01</b> 目标</span><span className="caption-line" /><span><b>02</b> 命令</span><span className="caption-line" /><span><b>03</b> 结果回传</span></div>
        </div>
      </section>

      <section className="model-deck" id="models" aria-labelledby="models-title">
        <div className="model-deck__intro">
          <p className="section-mark">MODEL ROUTES</p>
          <h2 id="models-title">你可以选择<br /><span>哪一个 AI。</span></h2>
          <p>不绑定单一模型。把你已经在用的 AI 带进同一个终端工作区，让对话、命令和结果沿着同一条线继续。</p>
          <div className="model-deck__count"><strong>04</strong><span>可用 AI 平台</span></div>
        </div>
        <div className="model-deck__list">
          {modelPlatforms.map((model, index) => (
            <article className={`model-entry model-entry--${model.tone}`} key={model.id}>
              <span className="model-entry__index">0{index + 1}</span>
              <span className="model-entry__icon"><img src={model.icon} alt="" /></span>
              <span className="model-entry__copy"><strong>{model.name}</strong><small>{model.detail}</small></span>
              <ArrowIcon />
            </article>
          ))}
          <p className="model-deck__note"><span className="status-dot" /> Gemini 需要先从浏览器导入登录态；其余平台可在工作区内直接登录。</p>
        </div>
      </section>

      <section className="workflow section" id="workflow">
        <div className="section-intro">
          <p className="section-mark">THE LOOP</p>
          <h2>从一句话，<br /><span>走到一个结果。</span></h2>
          <p>没有黑箱，也不需要记住下一步该去哪里。工作区把一次任务拆成看得见的三个瞬间。</p>
        </div>
        <div className="workflow-panel">
          <div className="workflow-tabs" role="tablist" aria-label="工作流步骤">
            {steps.map((item, index) => <button key={item.eyebrow} role="tab" aria-selected={activeStep === index} className={activeStep === index ? 'workflow-tab workflow-tab--active' : 'workflow-tab'} onClick={() => setActiveStep(index)}><span>{item.eyebrow}</span><strong>{item.title.replace('。', '')}</strong></button>)}
          </div>
          <div className={`workflow-detail workflow-detail--${step.tone}`}>
            <div className="workflow-detail__copy"><p className="detail-overline">{step.eyebrow}</p><h3>{step.title}</h3><p>{step.body}</p><div className="detail-result"><span className="result-mark">↳</span><span>{step.result}</span></div></div>
            <div className="workflow-detail__terminal"><span className="terminal-label">LIVE TRANSCRIPT</span><p className="terminal-prompt">{step.command}</p><div className="terminal-cursor" /></div>
          </div>
        </div>
      </section>

      <section className="capabilities section" id="capabilities">
        <div className="capabilities-heading"><p className="section-mark">THE WORKSPACE</p><h2>把上下文<br /><span>留在手边。</span></h2></div>
        <div className="feature-rail">{features.map((feature, index) => <article className="feature-row" key={feature.tag}><span className="feature-index">0{index + 1}</span><div className="feature-content"><p>{feature.tag}</p><h3>{feature.title}</h3><span>{feature.body}</span></div><ArrowIcon /></article>)}</div>
      </section>

      <section className="preview section">
        <div className="preview-heading"><p className="section-mark">A REAL WINDOW</p><h2>不只是把网页<br /><span>放在旁边。</span></h2><p>左边是正在发生的命令，中间是模型的上下文，右边是控制和历史。它们围绕同一个任务，而不是各自占一个标签页。</p></div>
        <div className="preview-frame"><div className="preview-frame__top"><span className="preview-dots"><i /><i /><i /></span><span>GPT Web to Codex Terminal</span><span className="preview-shortcut">⌘ 1 / workspace</span></div><img src="/workspace.png" alt="GPT Web to Codex Terminal 工作区界面" width="1920" height="1009" loading="lazy" /></div>
      </section>

      <section className="download section" id="download">
        <div className="download-orbit" aria-hidden="true"><span /><span /><span /></div>
        <div className="download-copy"><p className="section-mark">YOUR NEXT SESSION</p><h2>把下一次<br /><span>工作跑起来。</span></h2><p>下载桌面版，登录你已经在用的模型，选择一个项目。从第一条命令开始，保持在同一条线上。</p><div className="download-actions"><a className="button button--primary" href={WINDOWS_DOWNLOAD_URL} download>下载最新 Windows 版 <DownloadIcon /></a><a className="button button--secondary" href={LATEST_RELEASE_URL} target="_blank" rel="noreferrer">查看 Release 说明 <ArrowIcon /></a></div><small>当前仅提供 Windows 版本 · 下载源：GitHub 最新 Release</small></div>
        <div className="download-terminal"><div className="download-terminal__head"><span>QUICK START</span><span className="terminal-status"><i /> READY</span></div><p><span className="terminal-prompt-symbol">$</span> open codex-terminal</p><p className="download-terminal__muted">workspace restored · 3 sessions</p><div className="download-terminal__rule" /><p className="download-terminal__muted">模型在对话里，结果在终端里。</p></div>
      </section>

      <footer className="site-footer"><div className="footer-brand"><Mark /><div><strong>GPT → Codex Terminal</strong><span>CONVERSATION, MEET EXECUTION.</span></div></div><div className="footer-links"><button onClick={() => scrollTo('models')}>AI 平台</button><button onClick={() => scrollTo('workflow')}>工作流</button><button onClick={() => scrollTo('capabilities')}>能力</button><button onClick={() => scrollTo('download')}>下载</button><a href={WINDOWS_DOWNLOAD_URL} download>Windows 下载 <ArrowIcon /></a></div><span className="footer-note">© 2026 · Built for the next command.</span></footer>
    </main>
  )
}





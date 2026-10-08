'use client'

import { useState } from 'react'
import { assetPath, LATEST_RELEASE_URL, WINDOWS_DOWNLOAD_URL, LINUX_AGENT_DOWNLOAD_URL, WEB2TERM_GUIDE_URL, LINUX_AGENT_GUIDE_URL } from './site-config'

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
    result: '命令进入选定的本机、SSH 或 web2term 设备。',
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

const features = [
  {
    title: '一个工作区，四种模型入口',
    body: 'ChatGPT、Claude、Gemini 和 DeepSeek 各自保留登录态与对话，不用在浏览器标签之间来回找。',
    tag: 'MODEL SURFACES',
  },
  {
    title: '本机、SSH、web2term，选择执行环境',
    body: '在本机 PowerShell、SSH 主机或 web2term 设备上执行命令。每个会话绑定自己的环境，对话与结果继续留在一起。',
    tag: 'LOCAL + REMOTE',
  },
  {
    title: '手动或自动，你掌握节奏',
    body: '要逐条确认，就用手动执行；想让任务连续推进，就打开自动模式。暂停、结束、检查上一条都在侧栏里。',
    tag: 'CONTROL LOOP',
  },
]

const toolboxTools = [
  {
    id: 'git',
    name: 'Git 管理',
    summary: '文件差异与提交记录',
    title: '看清改了哪里，也看清怎么改过来。',
    body: '浏览当前项目的文件改动，切换统一或并排 diff，沿提交图查看分支、标签与历史记录。',
    scope: 'Git 面板读取本机目录。SSH 与 web2term 远端仓库可在对应终端运行 git 命令。',
  },
  {
    id: 'mysql',
    name: 'MySQL 连接',
    summary: '表数据、列注释与 DDL',
    title: '从数据库，看到表里的具体数据。',
    body: '保存连接，浏览数据库和表，查看表数据、列注释与实际执行的 SQL。需要确认结构时，打开 DDL 页查看并复制建表语句。',
    scope: '当前提供数据与结构查看；表数据按条数上限读取。',
  },
  {
    id: 'redis',
    name: 'Redis 连接',
    summary: '只读浏览键、值与 TTL',
    title: '找到一个键，读懂它现在的状态。',
    body: '测试并保存连接，切换数据库、搜索键名，查看数据类型和 TTL。支持 String、Hash、List、Set、ZSet 与 Stream，以及字符串的 JSON 格式化。',
    scope: '只读浏览，按批次加载键与数据。当前不支持 Redis Cluster。',
  },
  {
    id: 'nacos',
    name: 'Nacos 连接',
    summary: '保存连接与内置控制台',
    title: '把常用的控制台，留在工作区里。',
    body: '为不同环境保存名称、控制台地址与命名空间，在独立页签中打开 Nacos 控制台，继续使用它的配置管理与服务发现界面。',
    scope: '控制台使用 Nacos 自身的登录与权限。',
  },
] as const

type ToolboxId = (typeof toolboxTools)[number]['id']

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
  return <img className="brand-mark" src={assetPath('/brand-icon.png')} alt="" aria-hidden="true" />
}

function ToolboxPreview({ tool }: { tool: ToolboxId }) {
  if (tool === 'git') {
    return (
      <div className="tool-preview tool-preview--git">
        <div className="tool-preview__bar"><code>main</code><span>文件改动 · 统一 diff</span></div>
        <p className="tool-preview__path">src/config.ts</p>
        <pre className="tool-preview__diff"><code><span className="diff-line diff-line--removed">- const executionTarget = &apos;local&apos;</span><span className="diff-line diff-line--added">+ const executionTarget = &apos;web2term&apos;</span></code></pre>
        <div className="tool-preview__foot">文件改动与提交记录，在同一处查看。</div>
      </div>
    )
  }
  if (tool === 'mysql') {
    return (
      <div className="tool-preview tool-preview--mysql">
        <div className="tool-preview__bar"><code>app.projects</code><span>表数据 / DDL</span></div>
        <p className="tool-preview__query"><code>SELECT * FROM `app`.`projects` LIMIT 201</code></p>
        <div className="tool-preview__table-scroll">
          <table><caption>项目表 · 示例数据</caption><thead><tr><th scope="col">id<small>项目编号</small></th><th scope="col">name<small>项目名称</small></th><th scope="col">environment<small>运行环境</small></th></tr></thead><tbody><tr><td>1</td><td>web-api</td><td>staging</td></tr><tr><td>2</td><td>worker</td><td>production</td></tr></tbody></table>
        </div>
      </div>
    )
  }
  if (tool === 'redis') {
    return (
      <div className="tool-preview tool-preview--redis">
        <div className="tool-preview__bar"><code>DB 0</code><span>只读浏览</span></div>
        <dl className="redis-example"><div><dt>键名</dt><dd><code>app:config</code></dd></div><div><dt>类型</dt><dd><code>string</code></dd></div><div><dt>TTL</dt><dd>不过期</dd></div></dl>
        <pre className="tool-preview__json"><code>{'{\n  "environment": "staging",\n  "feature_enabled": true\n}'}</code></pre>
        <div className="tool-preview__foot">JSON 格式化预览 · TTL 为最近一次读取时的值</div>
      </div>
    )
  }
  return (
    <div className="tool-preview tool-preview--nacos">
      <div className="tool-preview__bar"><span>Nacos 控制台连接</span><span>独立页签</span></div>
      <dl className="nacos-example"><div><dt>连接名称</dt><dd>本地开发</dd></div><div><dt>控制台地址</dt><dd><code>http://localhost:8848/nacos</code></dd></div><div><dt>命名空间</dt><dd><code>public</code></dd></div></dl>
      <div className="tool-preview__foot">保存连接信息后，在工作区内打开控制台。</div>
    </div>
  )
}

export default function Home() {
  const [activeStep, setActiveStep] = useState(1)
  const [menuOpen, setMenuOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [activeTool, setActiveTool] = useState<ToolboxId>('redis')
  const step = steps[activeStep]
  const tool = toolboxTools.find((item) => item.id === activeTool)!

  const scrollTo = (id: string) => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    document.getElementById(id)?.scrollIntoView({ behavior: reducedMotion ? 'instant' : 'smooth', block: 'start' })
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
        <button className="menu-toggle" onClick={() => setMenuOpen((open) => !open)} aria-expanded={menuOpen} aria-controls="site-navigation" aria-label={menuOpen ? '关闭导航' : '打开导航'}>
          <span />
          <span />
        </button>
        <nav id="site-navigation" className={menuOpen ? 'site-nav site-nav--open' : 'site-nav'} aria-label="主导航">
          <button onClick={() => scrollTo('models')}>AI 平台</button>
          <button onClick={() => scrollTo('workflow')}>工作流</button>
          <button onClick={() => scrollTo('web2term')}>web2term</button>
          <button onClick={() => scrollTo('toolbox')}>工具箱</button>
          <button onClick={() => scrollTo('download')}>下载</button>
          <button className="nav-cta" onClick={() => scrollTo('download')}>
            开始使用 <ArrowIcon />
          </button>
        </nav>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <p className="hero-overline"><span className="live-dot" /> AI × 本机与远程终端</p>
          <h1>让对话<br /><em>抵达终端。</em></h1>
          <p className="hero-lede">GPT Web to Codex Terminal 把模型对话与本机、SSH、web2term 设备上的命令执行放进同一个工作区。代码、数据和配置，也有随手可用的工具箱。</p>
          <div className="hero-actions">
            <a className="button button--primary" href={WINDOWS_DOWNLOAD_URL} download>下载最新 Windows 版 <DownloadIcon /></a>
            <button className="text-link" onClick={() => scrollTo('workflow')}>先看它怎么工作 <ArrowIcon /></button>
          </div>
          <div className="platform-note"><span>Windows</span><small>· 当前仅提供 Windows 版本</small></div>
        </div>

        <div className="hero-demo" aria-label="对话到终端的工作流演示">
          <div className="sun-halo sun-halo--one" />
          <div className="sun-halo sun-halo--two" />
          <div className="hero-demo__topline"><span>WORKSPACE / 功能示意</span><span><i className="status-dot" /> LOCAL · C:\\project</span></div>
          <div className="hero-demo__body">
            <div className="demo-sidebar">
              <span className="demo-sidebar__label">SESSIONS</span>
              <div className="session session--active"><span className="session-pulse" /><span>Build profile</span><small>now</small></div>
              <div className="session"><span className="session-line" /><span>SSH · staging</span><small>2m</small></div>
              <div className="session"><span className="session-line" /><span>web2term · dev-linux</span><small>1h</small></div>
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
              <span className="model-entry__icon"><img src={assetPath(model.icon)} alt="" /></span>
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

      <section className="connections section" id="web2term" aria-labelledby="web2term-title">
        <div className="connections-intro">
          <h2 id="web2term-title">你的 Linux 设备，<br /><span>接进同一段对话。</span></h2>
          <p>通过 web2term 连接账号下的设备，继续在原来的会话里输入命令、让模型执行并接收结果。设备端提供终端，无需运行 SSH 服务。</p>
          <p className="connections-platform">Windows 桌面端 + Linux x86_64 设备工具</p>
          <a className="text-link" href={WEB2TERM_GUIDE_URL} target="_blank" rel="noreferrer">查看桌面连接指南 <ArrowIcon /></a>
          <details className="connection-notes">
            <summary>连接前要知道</summary>
            <ul>
              <li>同一设备最多同时运行 3 个独立终端。每个会话保留自己的目录、变量和终端历史。</li>
              <li>当前桌面端共享一条设备连接。切换设备会断开原设备通道，原会话保留历史，可手动重新连接。</li>
              <li>应用重启后需要手动重新连接。连接失败或断线时，命令不会自动改到本机执行。</li>
            </ul>
          </details>
        </div>
        <div className="connection-guide">
          <ol className="connection-route" aria-label="web2term 连接路径">
            <li><strong>桌面工作区</strong><span>选择账号下的设备</span><ArrowIcon /></li>
            <li><strong>后端服务</strong><span>两端使用同一账号</span><ArrowIcon /></li>
            <li><strong>Linux 设备</strong><span>web2term 提供终端</span></li>
          </ol>
          <ol className="connection-steps">
            <li>
              <h3>在设备上安装并启动工具</h3>
              <p>下载 Linux x86_64 工具，安装到 PATH。配置后端地址并完成邮箱验证码登录，再用同一 Linux 用户启动后台进程。</p>
              <pre className="connection-commands" aria-label="Linux 设备安装与启动命令"><code>{'sudo install -m 0755 web2term-linux-amd64 /usr/local/bin/web2term\nweb2term set server\nweb2term login\nweb2term run\nweb2term status'}</code></pre>
              <p>当 <code>web2term status</code> 显示设备已在线、服务端已确认心跳时，再到桌面端连接。</p>
              <div className="connection-actions"><a className="text-link" href={LINUX_AGENT_DOWNLOAD_URL} download>下载 Linux 工具 <DownloadIcon /></a><a className="text-link" href={LINUX_AGENT_GUIDE_URL} target="_blank" rel="noreferrer">工具使用说明 <ArrowIcon /></a></div>
            </li>
            <li><h3>在桌面端登录同一后端与账号</h3><p>打开 <strong>设置 → 后端服务</strong>，填写与设备工具一致的后端地址并登录。</p></li>
            <li><h3>选择设备，等待终端就绪</h3><p>点击会话栏 <strong>＋ → web2term 连接</strong>，在“我的设备”中选择设备并连接。右侧出现“设备终端已就绪”后，即可直接输入命令或使用模型执行流程。</p></li>
          </ol>
          <p className="connection-scope">当前桌面通道支持命令执行与结果回传；全屏交互程序、SFTP 文件传输和 Git 文件界面尚未接入。读取文件或操作 Git 可使用终端命令。</p>
        </div>
      </section>

      <section className="capabilities section" id="capabilities">
        <div className="capabilities-heading"><p className="section-mark">THE WORKSPACE</p><h2>把上下文<br /><span>留在手边。</span></h2></div>
        <div className="feature-rail">{features.map((feature, index) => <article className="feature-row" key={feature.tag}><span className="feature-index">0{index + 1}</span><div className="feature-content"><p>{feature.tag}</p><h3>{feature.title}</h3><span>{feature.body}</span></div><ArrowIcon /></article>)}</div>
      </section>

      <section className="toolbox section" id="toolbox" aria-labelledby="toolbox-title">
        <div className="toolbox-heading"><h2 id="toolbox-title">代码、数据、配置，<br /><span>工具箱就在手边。</span></h2><p>从终端顶部打开“工具箱”。检查一次改动、读一张表、查一个缓存键，或打开配置控制台，再回到正在进行的任务。</p></div>
        <div className="toolbox-workbench">
          <div className="toolbox-selector" role="group" aria-label="选择工具箱功能">
            {toolboxTools.map((item) => (
              <button type="button" key={item.id} className={activeTool === item.id ? 'toolbox-choice toolbox-choice--active' : 'toolbox-choice'} aria-pressed={activeTool === item.id} aria-controls="toolbox-detail" onClick={() => setActiveTool(item.id)}><span><strong>{item.name}</strong><small>{item.summary}</small></span><ArrowIcon /></button>
            ))}
          </div>
          <div className="toolbox-detail" id="toolbox-detail" role="region" aria-labelledby="toolbox-detail-title" aria-live="polite">
            <div className="toolbox-detail__header"><span>{tool.name}</span><small>功能示意 · 示例数据</small></div>
            <h3 id="toolbox-detail-title">{tool.title}</h3>
            <p className="toolbox-detail__body">{tool.body}</p>
            <ToolboxPreview tool={activeTool} />
            <p className="toolbox-detail__scope">{tool.scope}</p>
          </div>
        </div>
        <p className="toolbox-note">MySQL、Redis 与 Nacos 使用各自保存的连接配置，目标地址需可从桌面端访问。它们不会通过 web2term 设备转发。</p>
      </section>

      <section className="preview section">
        <div className="preview-heading"><p className="section-mark">A REAL WINDOW</p><h2>不只是把网页<br /><span>放在旁边。</span></h2><p>左侧是会话与终端，中间是模型对话，右侧是执行控制和历史。连接方式与工具箱都从这个工作区进入，围绕同一个任务继续。</p></div>
        <div className="preview-frame"><div className="preview-frame__top"><span className="preview-dots"><i /><i /><i /></span><span>GPT Web to Codex Terminal</span><span className="preview-shortcut">Windows / workspace</span></div><img src={assetPath('/workspace.png')} alt="GPT Web to Codex Terminal 工作区：会话列表、命令终端、模型对话与执行控制" width="1920" height="1009" loading="lazy" /></div>
      </section>

      <section className="download section" id="download">
        <div className="download-orbit" aria-hidden="true"><span /><span /><span /></div>
        <div className="download-copy"><p className="section-mark">YOUR NEXT SESSION</p><h2>把下一次<br /><span>工作跑起来。</span></h2><p>下载 Windows 桌面版，登录你已经在用的模型，选择本机、SSH 或 web2term 设备。需要连接 Linux 设备时，再安装配套的 web2term 工具。</p><div className="download-actions"><a className="button button--primary" href={WINDOWS_DOWNLOAD_URL} download>下载最新 Windows 版 <DownloadIcon /></a><a className="button button--secondary" href={LATEST_RELEASE_URL} target="_blank" rel="noreferrer">查看 Release 说明 <ArrowIcon /></a><a className="text-link" href={LINUX_AGENT_DOWNLOAD_URL} download>下载 web2term · Linux x86_64 <DownloadIcon /></a></div><small>桌面端：Windows · 设备工具：Linux x86_64 · 下载源：GitHub 最新 Release</small></div>
        <div className="download-terminal"><div className="download-terminal__head"><span>SESSION SETUP</span><span>工作区入口</span></div><dl className="download-environments"><div><dt>执行环境</dt><dd>本机 / SSH / web2term</dd></div><div><dt>工具箱</dt><dd>Git / MySQL / Redis / Nacos</dd></div><div><dt>模型</dt><dd>ChatGPT / Claude / Gemini / DeepSeek</dd></div></dl></div>
      </section>

      <footer className="site-footer"><div className="footer-brand"><Mark /><div><strong>GPT → Codex Terminal</strong><span>CONVERSATION, MEET EXECUTION.</span></div></div><div className="footer-links"><button onClick={() => scrollTo('models')}>AI 平台</button><button onClick={() => scrollTo('workflow')}>工作流</button><button onClick={() => scrollTo('web2term')}>web2term</button><button onClick={() => scrollTo('toolbox')}>工具箱</button><button onClick={() => scrollTo('download')}>下载</button><a href={WINDOWS_DOWNLOAD_URL} download>Windows 下载 <ArrowIcon /></a></div><span className="footer-note">© 2026 · Built for the next command.</span></footer>
    </main>
  )
}





# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

React + Next.js, as requested by the user. The existing product runtime remains a React + Electron desktop application; this surface is a separate marketing site within the repository.

## Users

Inferred from the product documentation: developers and technical teams who want an AI conversation and a persistent local or SSH terminal in the same working context.

## Product Purpose

GPT Web to Codex Terminal brings an AI web conversation, a persistent local or SSH terminal, project files, and Git context into one desktop workspace. The product helps a developer move from intent to inspected command output without losing the thread between the model and the machine.

## Positioning

The product keeps the model conversation and the real execution surface in one session: the model proposes one command at a time, the app runs it on the selected machine, and the resulting output, exit code, and status return to the conversation.

## Operating Context

Users work inside a desktop workspace with sessions, embedded ChatGPT / DeepSeek / Claude / Gemini pages, a local or remote terminal, project files, Git information, execution controls, and conversation history.

## Capabilities and Constraints

- Embedded model pages retain their own login state and conversation context.
- Local and SSH terminal workflows support manual and automatic execution modes.
- Terminal output includes command, output, notice, error, exit code, and execution status.
- Project file browsing, Git views, prompt tools, settings, diagnostics, and update checks are part of the desktop product.
- The marketing surface should explain the product without claiming unverified benchmarks, customers, pricing, or security guarantees.
- The current repository builds with `npm run build`; the existing Electron product must remain intact.
- Current desktop installers support Windows x64 and macOS Apple Silicon (arm64); the public download source is the repository's latest GitHub Release. The macOS DMG is ad-hoc signed without Developer ID signing or Apple notarization, and updates use manual DMG replacement. No Intel Mac installer is currently published.

## Brand Commitments

The product name is GPT Web to Codex Terminal. Existing repository assets include the product icon and platform marks for ChatGPT, Claude, DeepSeek, and Gemini. The product voice can be direct, technical, and concrete.

## Evidence on Hand

- Product overview and capabilities: `README.md`.
- Existing workspace screenshot: `docs/screenshots/workspace.png`.
- Existing brand icon: `src/renderer/src/assets/brand-icon.png`.
- Platform marks: `src/renderer/src/assets/*.svg` and `svg/*.svg`.
- No customer testimonials, external press, benchmark results, or pricing facts are present in the repository.

## Product Principles

- Keep intent and execution in one visible loop.
- Show the real command and its real result.
- Preserve context across model, machine, project, and session.
- Make control and inspection explicit.
- Prefer concrete product truth over inflated claims.

## Accessibility & Inclusion

The marketing site should use semantic HTML, visible keyboard focus, readable contrast, reduced-motion support, and responsive layouts for desktop and mobile web.


---
name: GPT Web to Codex Terminal
description: Conversation, meet execution.
colors:
  ink: "#0b1014"
  ink-deep: "#070a0d"
  ink-soft: "#121a20"
  paper: "#f2ede2"
  paper-muted: "#c0bcad"
  paper-dim: "#878b83"
  amber: "#f4b544"
  amber-soft: "#ffd479"
  signal-blue: "#88a7ff"
  signal-mint: "#91d8ae"
  signal-red: "#fb7666"
typography:
  display:
    fontFamily: "Avenir Next, Trebuchet MS, Segoe UI, sans-serif"
    fontSize: "clamp(4rem, 7.7vw, 8.4rem)"
    fontWeight: 500
    lineHeight: 0.89
    letterSpacing: "-0.085em"
  title:
    fontFamily: "Avenir Next, Trebuchet MS, Segoe UI, sans-serif"
    fontSize: "clamp(1.7rem, 3vw, 3rem)"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "-0.065em"
  body:
    fontFamily: "Aptos, Segoe UI, Arial, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.72
  label:
    fontFamily: "SFMono-Regular, Cascadia Code, Roboto Mono, Consolas, monospace"
    fontSize: "0.66rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.18em"
rounded:
  sm: "0px"
  md: "0px"
  pill: "999px"
spacing:
  xs: "8px"
  sm: "16px"
  md: "24px"
  lg: "48px"
  xl: "92px"
components:
  button-primary:
    backgroundColor: "{colors.amber}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "0 18px"
    height: "48px"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.paper}"
    rounded: "{rounded.sm}"
    padding: "0 18px"
    height: "48px"
---

# Design System: GPT Web to Codex Terminal

## Overview

**Creative North Star: "The Indoor Weather Workbench"**

The site treats a developer session like weather moving through a large room: warm amber light marks the active line of thought, cool blue describes the interface around it, and mint green confirms that a real result has landed. The page stays dark and quiet so the working loop can carry the attention. A broad horizon, thin rings, and reflected light imply the room without turning it into decoration.

The visual language is editorial and instrument-like. Large, condensed display type establishes the thesis; small mono labels pin the work to a real state; terminal snippets keep the promise concrete. Surfaces are rectangular, lightly ruled, and mostly flat. One soft ambient shadow is reserved for the actual workspace preview and demo, giving the product window a physical presence without building a card grid.

**Key Characteristics:**
- Near-black room with paper-white type and one warm amber signal.
- Conversation, command, and result shown as one visible line.
- Thin rules and mono labels create instrument precision.
- Wide compositions collapse into stacked reading order on mobile.

## Colors

The palette is a sodium-amber signal system inside a cool, near-black workroom. Accent colors name states and roles rather than decorating every surface.

### Primary
- **Sodium Amber** (#f4b544): active intent, primary calls to action, the live line in the work loop.

### Secondary
- **Signal Blue** (#88a7ff): model context, workspace framing, and the cool reflected side of the room.
- **Signal Mint** (#91d8ae): successful execution, ready states, and confirmed results.

### Tertiary
- **Signal Red** (#fb7666): terminal stop/error signal, used sparingly in the product-window chrome.

### Neutral
- **Deep Ink** (#0b1014): page ground and the surrounding room.
- **Ink Deep** (#070a0d): terminal fields and the deepest recesses.
- **Ink Soft** (#121a20): raised work surfaces.
- **Paper** (#f2ede2): primary reading color.
- **Paper Muted** (#c0bcad): supporting copy and descriptions.
- **Paper Dim** (#878b83): metadata and quiet navigation.

### Named Rules

**The One Signal Rule.** Amber marks the current action. Blue and mint explain context and outcome; they never compete with the primary line.

## Typography

**Display Font:** Avenir Next (with Trebuchet MS, Segoe UI, sans-serif)
**Body Font:** Aptos (with Segoe UI, Arial, sans-serif)
**Label/Mono Font:** SFMono-Regular (with Cascadia Code, Roboto Mono, Consolas, monospace)

**Character:** Display type is large, compressed, and slightly tense; body text is open and calm; mono labels make every state feel measured. The three voices are intentionally distinct so a visitor can read the thesis, the explanation, and the system state in one glance.

### Hierarchy
- **Display** (500, `clamp(4rem, 7.7vw, 8.4rem)`, 0.89): the hero thesis and major section statements.
- **Headline** (500, `clamp(3.5rem, 6.2vw, 7.5rem)`, 0.9): section-level statements.
- **Title** (500, `clamp(1.7rem, 3vw, 3rem)`, 1): workflow and feature titles.
- **Body** (400, 1rem, 1.72): explanations and supporting copy, kept near a 65–75ch measure where possible.
- **Label** (600, 0.66rem, 1.2, 0.18em): mono state labels, uppercase metadata, and section marks.

### Named Rules

**The Three Voices Rule.** Display type carries the promise, body type carries the explanation, and mono carries the state. Do not use mono for prose or display type for metadata.

## Layout

The desktop shell uses a two-column hero: a copy field on the left and a working window on the right. Sections use the same wide container, `min(1400px, calc(100% - 72px))`, with a generous vertical rhythm between statements. The workflow section pairs a narrow intro with a larger interactive panel; the capability section gives the feature rail more width than its heading. At `1050px` the columns stack. At `720px` the navigation becomes a compact menu, the workbench hides its session rail, and every two-column detail becomes a reading-order stack.

## Elevation & Depth

Depth comes from tonal layering and one soft shadow language. Thin rules separate regions; the near-black room, ink-soft work surfaces, and transparent terminal fields provide hierarchy. The workspace preview and hero demo use soft ambient shadows with offset and blur (`0 25px 90px rgba(0,0,0,.4)`), never a hard offset block shadow. The amber orbit at the download close is an atmospheric light source, not a surface elevation.

### Shadow Vocabulary
- **Workspace ambient** (`0 25px 90px rgba(0,0,0,.4)`): physical presence for the product window.
- **Download ambient** (`0 25px 80px rgba(0,0,0,.28)`): separates the quick-start transcript from the dark room.

### Named Rules

**The Flat Workbench Rule.** Resting surfaces stay flat and ruled. Shadow appears only where a real product window needs to separate from the room.

## Shapes

The form language is rectangular and exact, with square corners for primary surfaces and controls. Pills are reserved for status dots and tiny identity marks. Borders are one pixel, mostly transparent, and used as measurement lines rather than decoration. Rings and horizon circles can be soft because they belong to the indoor-weather material; panels themselves stay crisp.

## Components

Buttons are direct instruments: short labels, a clear action, and a single arrow or download mark. The amber primary button is square and tactile; the secondary button is transparent with a one-pixel rule. The top navigation remains quiet until hover or focus, then picks up amber.

The signature component is the workflow window: a real transcript with session state, model context, command, and output. Its state is expressed through color and mono labels rather than badges stacked on cards.

## Do's and Don'ts

### Do:
- **Do** show a real command and a real-looking result wherever the page makes a product promise.
- **Do** use amber as the active signal and reserve mint for confirmed outcomes.
- **Do** keep rules thin, spacing generous, and the page rhythm editorial.
- **Do** preserve visible focus rings and respect reduced-motion preferences.

### Don't:
- **Don't** turn the page into a grid of identical icon cards.
- **Don't** use gradients as text, glass blur as a default surface, or hard offset shadows.
- **Don't** use mono as a costume for ordinary prose.
- **Don't** invent customer logos, benchmarks, pricing, or security claims.


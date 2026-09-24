---
name: VibeGet
description: Leilões de eletrônicos lacrados onde cada Get perdido vira GetCoin; o site é a carteira de vidro do token.
colors:
  ember-black: "#0e0906"
  ember-ink: "#fff4ea"
  ember-ink-soft: "#e9d6c6"
  ash: "#b89f8c"
  hairline: "rgba(255, 214, 180, 0.12)"
  hairline-lit: "rgba(255, 214, 180, 0.22)"
  glass: "rgba(255, 226, 200, 0.055)"
  glass-lit: "rgba(255, 226, 200, 0.09)"
  getcoin-gold: "#ffb23f"
  getcoin-flare: "#ff7a1a"
  ember: "#ff5a1f"
  live-red: "#ef3d36"
  live-red-ink: "#ff8a84"
  rim-violet: "#6a4dff"
  plate-cream: "#fffaf3"
  plate-sand: "#f3e3d2"
  coin-shadow: "#2a1102"
typography:
  display:
    fontFamily: "Bricolage Grotesque Variable, Onest Variable, sans-serif"
    fontSize: "clamp(2.8rem, 6.4vw, 5.8rem)"
    fontWeight: 750
    lineHeight: 0.96
    letterSpacing: "-0.04em"
  headline:
    fontFamily: "Bricolage Grotesque Variable, Onest Variable, sans-serif"
    fontSize: "clamp(2rem, 4vw, 3.4rem)"
    fontWeight: 700
    lineHeight: 1.02
    letterSpacing: "-0.03em"
  title:
    fontFamily: "Bricolage Grotesque Variable, Onest Variable, sans-serif"
    fontSize: "1.15rem"
    fontWeight: 650
    letterSpacing: "-0.02em"
  numeral-display:
    fontFamily: "Bricolage Grotesque Variable, Onest Variable, sans-serif"
    fontSize: "clamp(3rem, 5vw, 4.6rem)"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "-0.06em"
  body:
    fontFamily: "Onest Variable, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.55
  lede:
    fontFamily: "Onest Variable, system-ui, sans-serif"
    fontSize: "clamp(1.05rem, 1.3vw, 1.2rem)"
    fontWeight: 400
    lineHeight: 1.55
  figure:
    fontFamily: "Martian Mono Variable, ui-monospace, monospace"
    fontWeight: 400
    letterSpacing: "-0.02em"
    fontFeature: "tnum"
  label-live:
    fontFamily: "Onest Variable, system-ui, sans-serif"
    fontSize: "0.72rem"
    fontWeight: 700
    letterSpacing: "0.08em"
rounded:
  pill: "999px"
  shell: "40px"
  lg: "32px"
  md: "24px"
  plate: "20px"
  sm: "16px"
spacing:
  gutter: "clamp(16px, 4vw, 48px)"
  section: "clamp(80px, 11vw, 144px)"
  xs: "8px"
  sm: "16px"
  md: "24px"
  lg: "32px"
  xl: "48px"
components:
  button-coin:
    backgroundColor: "{colors.getcoin-gold}"
    textColor: "{colors.coin-shadow}"
    rounded: "{rounded.pill}"
    padding: "0 22px"
    height: "48px"
  button-coin-lg:
    backgroundColor: "{colors.getcoin-gold}"
    textColor: "{colors.coin-shadow}"
    rounded: "{rounded.pill}"
    padding: "0 28px"
    height: "58px"
  button-ghost:
    backgroundColor: "rgba(255, 226, 200, 0.04)"
    textColor: "{colors.ember-ink}"
    rounded: "{rounded.pill}"
    padding: "0 22px"
    height: "48px"
  button-glass:
    backgroundColor: "rgba(255, 226, 200, 0.08)"
    textColor: "{colors.ember-ink}"
    rounded: "{rounded.pill}"
    padding: "0 22px"
    height: "48px"
  chip:
    backgroundColor: "{colors.glass}"
    textColor: "{colors.ember-ink-soft}"
    rounded: "{rounded.pill}"
    padding: "0 8px 0 18px"
    height: "44px"
  chip-active:
    backgroundColor: "{colors.ember-ink}"
    textColor: "#1a0e08"
    rounded: "{rounded.pill}"
  nav-bar:
    backgroundColor: "rgba(22, 13, 9, 0.62)"
    textColor: "{colors.ember-ink-soft}"
    rounded: "{rounded.pill}"
    padding: "0 12px 0 22px"
    height: "68px"
  live-badge:
    backgroundColor: "rgba(239, 61, 54, 0.14)"
    textColor: "{colors.live-red-ink}"
    typography: "{typography.label-live}"
    rounded: "{rounded.pill}"
    padding: "6px 12px"
  wallet-panel:
    rounded: "{rounded.lg}"
    padding: "22px"
  vibe-card:
    rounded: "{rounded.lg}"
    padding: "10px"
  product-plate:
    backgroundColor: "{colors.plate-cream}"
    rounded: "{rounded.plate}"
---

# Design System: VibeGet

## Overview

**Creative North Star: "The Glass Wallet"**

GetCoin is a token and the site is its wallet. The world is a warm near-black floor lit like banked embers, with frosted glass panels floating over pools of amber light and a single cold violet rim far above. Money is physical here: the GetCoin is a minted amber-gold disc, figures are set in tabular monospace, and the one choreographed moment is the coin being struck as the Get changes.

Density is confident and card-led: large display headlines on the left, instrument-like glass panels on the right, generous section breaks. Everything that can be touched is a pill; everything that holds content is a softly rounded pane. Warmth comes from light, not from fill: surfaces stay dark and translucent, and color arrives as glow, rims, and the coin itself.

Product photography is never placed raw on the dark floor. It sits on a warm cream plate, like merchandise on a lit pedestal, so real catalog shots read as premium goods inside the wallet world.

**Key Characteristics:**
- Warm ember-black floor with fixed radial light (amber top-right, violet top-left, red low-center).
- Frosted glass panes with a brighter top edge, always with a light source behind them.
- GetCoin gold as the only action color; red strictly a live/win signal.
- Tabular monospace for every amount, timer, and count.
- Pills for controls, 16–40px rounded panes for containers.
- One authored motion: the GetCoin mint.

## Colors

A monochrome ember ramp carrying one metallic accent (GetCoin gold), one signal (live red), and one cold light (violet) that never touches a control.

### Primary
- **GetCoin Gold** (getcoin-gold): The token. Primary buttons (as a top-lit gradient from #ffd07a through gold to flare), coin artwork, amounts earned in GetCoin, step numerals, section icons, links, focus ring, selection highlight, range-slider fill.
- **GetCoin Flare** (getcoin-flare): The hot end of the coin gradient, the checked toggle track, and the colored glow under coin buttons.
- **Ember** (ember): The warm start of progress meters (ember to gold).

### Secondary
- **Live Red** (live-red): The brand's red flame, used as a signal only: the pulsing live dot, AO VIVO badge, the ticker's live label, a closing-soon timer, and the Champion Get outcome. **Live Red Ink** (live-red-ink) is its legible text tint on dark.

### Tertiary
- **Rim Violet** (rim-violet): Cold counter-light. Appears only as low-alpha atmosphere, the wallet's gradient rim, and the tint inside the locked Viber tier card.

### Neutral
- **Ember Black** (ember-black): The floor, the scrollbar track, theme-color.
- **Ember Ink** (ember-ink): Primary text and the active-chip fill.
- **Ember Ink Soft** (ember-ink-soft): Secondary text, nav links, labels, ledes.
- **Ash** (ash): Muted meta text, dt labels, fine print.
- **Hairline / Hairline Lit** (hairline, hairline-lit): Panel borders and dividers; the lit variant marks top edges and ghost-button outlines.
- **Glass / Glass Lit** (glass, glass-lit): Panel fills, stacked as a top-to-bottom gradient.
- **Plate Cream / Plate Sand** (plate-cream, plate-sand): The product pedestal radial (cream center to sand, fading to #e5c9ae).
- **Coin Shadow** (coin-shadow): Text on gold surfaces and on the selection highlight.

### Named Rules
**The Red Is Live Rule.** Live Red marks only what is happening now or winning: AO VIVO, closing timers, Champion Get. It never styles a general CTA, a price, or a decoration. At low alpha it may tint background light (atmosphere floor glow, hero glow), never a control.

**The Violet Is Light Rule.** Violet is a light source, not a paint. It lives in the atmosphere, the wallet rim, and the locked tier's tint; it never fills or outlines a button, chip, link, or input.

**The One Coin Rule.** Gold is the only action color. If something is clickable and primary, it is gold; if it is gold and not clickable, it is a GetCoin amount or the coin itself.

## Typography

**Display Font:** Bricolage Grotesque Variable (with Onest Variable, sans-serif)
**Body Font:** Onest Variable (with system-ui)
**Label/Mono Font:** Martian Mono Variable (with ui-monospace)

**Character:** A squat, characterful variable grotesque at heavy weights and tight tracking for headlines, a clean humanist sans for reading, and a wide technical mono that makes every figure look like a ledger entry.

### Hierarchy
- **Display** (750, clamp(2.8rem, 6.4vw, 5.8rem), 0.96): Hero headline only. A trailing clause may drop to 500 weight at 0.62em in GetCoin Gold. Fixed 2.45rem under 600px.
- **Headline** (700, clamp(2rem, 4vw, 3.4rem), 1.02): Section h2s; the closing band uses clamp(2.2rem, 4.6vw, 4rem) at 18ch max.
- **Title** (650, 1.15–1.3rem): Card and step h3s, wallet product name (1.2rem), tier names (700, clamp(1.6rem, 2.4vw, 2.2rem)).
- **Numeral Display** (400, clamp(3rem, 5vw, 4.6rem), -0.06em): Step numbers in gold. Light weight at big size is the contrast to the heavy headlines.
- **Body** (400, 17px / 16px under 600px, 1.55): Ledes at clamp(1.05rem, 1.3vw, 1.2rem), 56ch max; FAQ answers 65ch max.
- **Figure** (Martian Mono, tabular, -0.02em): Every R$ amount, GetCoin count, timer, date, and chip count. Prices at 700.
- **Live Label** (700, 0.72rem, 0.08em, uppercase): Reserved for the AO VIVO badge and the ticker's live label.

### Named Rules
**The Ledger Rule.** Any number a user could compare (money, GetCoin, time, count) is set in Martian Mono with tabular figures. Prose numbers in running text are the only exception.

**The Uppercase Is Live Rule.** Tracked uppercase exists only for live labels. Headings carry no eyebrow or kicker above them.

## Layout

Content sits in a 1320px max container with a fluid gutter (clamp(16px, 4vw, 48px)); sections open with clamp(80px, 11vw, 144px) of top space. The hero is a two-column grid (1.1fr / 0.9fr) with the copy and proof stacked left and the wallet spanning both rows right, filling roughly the first viewport (100svh minus 170px). Split sections (GetCoin, Levels) use two columns with a clamp(32px, 6vw, 96px) gap. Section heads put the h2 and its sentence left and an arrow link right, wrapping on narrow widths.

Grids: Vibe cards 4 columns, 2 at 1120px, 1 at 600px; steps rail 4 / 2 / 1; trust strip 5 / 3 / 2 columns divided by hairlines. At 900px all split sections collapse to one column and the hero orders copy, wallet, proof. At 600px CTAs go full-width and the secondary hero CTA becomes a gold underlined text link.

Spacing rhythm steps 8 / 16 / 24 / 32 / 48, with 10–14px inside compact controls and 22–24px inside panels.

## Elevation & Depth

Depth is made of light and glass, not stacked shadows. Panels are translucent (glass gradient, 22px backdrop blur at 150% saturation) with a 1px hairline whose top edge is brighter, an inset top highlight, and one long soft drop shadow. Colored glow shadows belong to gold and red actions only. Each major glass composition has an ember radial pseudo-element behind it (hero, GetCoin section), and the fixed atmosphere layer supplies the ambient light everywhere else.

### Shadow Vocabulary
- **Pane** (`box-shadow: 0 1px 0 rgba(255, 236, 214, 0.08) inset, 0 24px 60px -24px rgba(0, 0, 0, 0.7)`): Every glass panel.
- **Coin glow** (`box-shadow: 0 1px 0 rgba(255, 255, 255, 0.6) inset, 0 10px 28px -10px rgba(255, 122, 26, 0.75)`): Gold buttons at rest; hover deepens to `0 16px 40px -12px rgba(255, 122, 26, 0.95)` with a 1px lift.
- **Tier glow** (`box-shadow: 0 30px 60px -30px rgba(255, 122, 26, 0.8)`): The unlocked gold tier card.
- **Coin drop** (`filter: drop-shadow(0 4px 10px rgba(255, 122, 26, 0.3))`, large stage `0 18px 40px rgba(255, 122, 26, 0.4)`): Coin artwork.

### Named Rules
**The Lit Glass Rule.** Glass never sits on a flat floor. A new glass composition gets an ember radial light behind it (a blurred circular pseudo-element, amber at ~0.3–0.42 alpha fading out by 65–70%) so the blur has something to refract.

**The Warm Shadow Rule.** Only gold and live red cast colored glow. Neutral panels cast black, long, and soft.

## Shapes

Two families. Controls are full pills (999px): buttons, chips, nav bar, badges, tags, meters, toggles, sliders. Containers are softly rounded panes: 16px for inner tiles (toggles, outcomes, menu rows), 20px for product plates (18px small), 24px for tier cards, FAQ items and the menu sheet, 32px for the wallet, Vibe cards, steps rail and trust strip, 40px for the closing band (28px on mobile). The GetCoin is a perfect disc with an inner ring and a lightning stroke, echoed by the favicon. The wallet carries a 1px gradient rim (amber at top-left fading to violet at bottom-right) drawn with a masked pseudo-element. Ledger totals separate on a dashed hairline; everything else divides with solid hairlines.

## Components

### Buttons
Tactile pills lit from above.
- **Shape:** full pill (999px); heights 40 / 48 / 58px.
- **Primary (Coin):** vertical gradient #ffd07a to gold to flare, coin-shadow text, 600 weight, inset top highlight plus amber glow. Hover lifts 1px and deepens the glow; trailing arrow icons nudge 3px right; active scales to 0.98.
- **Ghost:** hairline-lit border, 4% cream fill, brightens to 10% on hover. Secondary actions next to a coin button.
- **Glass:** 8% cream fill with hairline-lit border; hover warms to gold at 16% fill and 50% border. Card-level actions when the item is not urgent.
- **Rule:** a Vibe card's action turns from glass to coin when that Vibe is closing.

### Chips
- **Style:** 44px pill, glass fill, hairline border, ink-soft text, with a mono count bubble at the trailing end.
- **State:** active chip inverts to an Ember Ink fill with dark text and a gold count bubble. Overlay chips on product plates (GetCoin amount, timer) are dark 80% pills with 8px blur; a closing timer gets a gold inset ring and the live dot.

### Cards / Containers
- **Corner Style:** 32px panes (see Shapes).
- **Background:** glass gradient, glass-lit to glass.
- **Shadow Strategy:** Pane shadow (see Elevation).
- **Border:** 1px hairline, brighter top edge.
- **Internal Padding:** 10px around a plate-led Vibe card, 22–24px for text panels.
- **Hover (Vibe card):** lifts 4px, border warms to gold at 35%, product image scales to 1.05.

### Inputs / Fields
- **Range slider:** 10px pill track filled flare-to-gold up to the value, cream-transparent after; 28px coin-textured thumb (radial #fff0c8 to gold to #b8480b) with a cream ring and amber shadow.
- **Toggle:** a 16px-rounded tile with a 46x28 pill switch; checked track goes flare, knob slides 18px on the house ease.
- **Focus:** 2px gold outline, 3px offset, everywhere.

### Navigation
A floating glass pill (68px, 60px on mobile) sticky 12px from the top: logo left, pill-hover text links centered in ink-soft, language pill, ghost Entrar and coin Criar conta right. Below 1120px links collapse into a round menu button that opens a rounded glass sheet of full-width rows with trailing arrows.

### Product Plate
Warm cream pedestal (radial plate-cream to plate-sand to #e5c9ae) with an inset white hairline; the product image is contained with 10% padding and multiplied onto the cream so white-ground photos lose their box. A dark plate (#0c0b0d, image covers, no blend) is an interim exception carried only by the Galaxy S24 Ultra photo, which was shot on dark ground; it is not a variant to reuse, and it goes away once a white-ground asset replaces that photo.

### Wallet (Signature)
The simulator pane: 32px glass with a warm-to-violet diagonal tint and gradient rim, holding a live badge and mono timer, a small plate with the product, the Get slider, the GetCoin toggle, a mini ledger with a dashed total, a standing line, and two outcome tiles (red-tinted Champion Get, gold-tinted GetCoin back). The active outcome gets a 2px inset ring in its own color.

### GetCoin Mint (Signature motion)
When the Get changes, the GetCoin-back figure counts up over 600ms (ease-out quartic) while a stack of up to seven coins strikes in: each coin drops from -18px at 1.25 scale to rest over 0.55s on the house ease, staggered 45ms. This is the only choreographed animation; everything else is state feedback (hover, the live dot's 1.8s pulse, the 48s ticker marquee that pauses on hover). All motion collapses under reduced-motion.

## Do's and Don'ts

### Do:
- **Do** put an ember radial light behind any new glass composition (The Lit Glass Rule).
- **Do** set every amount, timer, and count in Martian Mono with tabular figures.
- **Do** make the primary action a gold coin pill, and only one gold pill per group.
- **Do** place product photos on the cream plate with multiply blend; use a white-ground asset whenever one exists.
- **Do** keep controls as full pills and containers as 16–40px rounded panes.
- **Do** reserve the minting motion for moments where GetCoin is actually earned or spent.

### Don't:
- **Don't** use Live Red on anything that is not live, closing, or a Champion Get (The Red Is Live Rule).
- **Don't** put violet on a button, chip, link, input, or border of a control (The Violet Is Light Rule).
- **Don't** place a raw product photo directly on the ember-black floor.
- **Don't** add eyebrows or kickers above headings; tracked uppercase is for live labels only.
- **Don't** add new choreographed entrance animations; state transitions use the house ease (cubic-bezier(0.16, 1, 0.3, 1)) at 0.3–0.5s.
- **Don't** fill large surfaces with opaque color; the gold tier card is the single solid-gold panel.

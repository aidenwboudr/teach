# Figures in Teach: the contract

Every figure in a lesson has to look like part of the app: chalk's visual language (the dark Manim ground, the
3b1b colours, the stage serif, real TeX), never a white box with a plotting library's defaults. The app themes a
figure for you, so a figure brings **only its geometry and class names**. Colour, fonts, stroke widths, arrowheads,
the background and the math typesetting come from the app, which also switches them between dark and light.
`show` and `render` refuse a figure that paints its own (a background, colour codes, fonts, matplotlib/plotly output).

## Pick the kind

1. **Something that moves or that they should poke** (a quantity changing over time, a knob that matters, a
   build-up in steps): a **scene** (the `scene` tool, chalk's scene engine), when the app has it. Same renderer as
   chalk's own visuals.
2. **A still diagram** (a circuit, a field, a geometry, a labelled setup): an **SVG** to the contract below, checked
   with `render`, shown with `show` or as `![caption](/abs/path.svg)` in a note.
3. **A small interactive tool** a scene can't do (a drill, a K-map to fill in, a custom simulator): an **HTML page**
   with `show`, using the kit below.

Never matplotlib, plotly or any charting library's default output, and never a raster screenshot of one.

## SVG figures

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 460 280">
  <g class="blue small"><text x="40" y="58">×</text> …</g>           <!-- B into the page -->
  <line class="thick" x1="40" y1="170" x2="420" y2="170"/>           <!-- the wire, in ink -->
  <line class="yellow arrow" x1="160" y1="196" x2="260" y2="196"/>
  <text class="yellow" x="272" y="202">$I,\ \vec L$</text>
  <line class="red arrow thick" x1="210" y1="160" x2="210" y2="70"/>
  <text class="red" x="224" y="96">$\vec F = I\vec L\times\vec B$</text>
</svg>
```

- **viewBox** always (about 420-560 wide, 240-360 high). No width/height needed, **no background rect**: the
  card behind it is the ground.
- **Colour by class** on a shape, a text or a `<g>`: `blue yellow teal green gold red orange purple pink grey dim`
  (default: ink). Never `fill="#…"`, `stroke="white"`, `style="color:…"`. One colour per quantity, the same in
  the formula and the drawing (B blue, F red, I yellow, …).
- **Shapes** are stroked in their colour and unfilled. Add `fill` (solid), `soft` (a tint, for regions), `thin`,
  `thick`, `dash`, `dot`. `class="arrow"` on a line or path puts chalk's arrowhead at its end; `arrow2` on both ends.
- **Text** is the stage serif at 15 units; `small` (13), `big` (19), `ui` (sans), `mono`. Write math as `$…$`
  inside a `<text>`: the app typesets it with KaTeX at that spot (`text-anchor` works). No `font-family`.
- **Layout**: every label inside the viewBox with ~12 units to spare; labels never on a line, an arrow or another
  label (each label gets a halo, but don't rely on it); at most ~12 words besides one formula.
- `render` returns the PNG the board will show **and a list of problems** (labels past the frame, on each other, on a
  line; any colour code or background). Fix every one and render again until it says none.

## HTML pages (interactive)

The app injects its theme kit into the page, so leave the look to it:

- No `background`, `color`, `font-family` or colour codes in your CSS. Use the variables when you need a colour:
  `var(--ink) var(--ink-2) var(--stage-dim) var(--blue) var(--yellow) var(--teal) var(--green) var(--gold) var(--red)
  var(--card) var(--ground) var(--edge)`, fonts `var(--font-math) var(--font-ui) var(--font-mono)`.
- Canvas: `TF.color("blue")`, `TF.color("ink")`, `TF.font(15)` (the stage serif), `TF.font(13, "mono")`. Leave the
  canvas transparent (no fillRect of a background).
- Sliders, buttons, labels and readouts are already styled like chalk's (a yellow slider, the readout in mono).
  `$…$` in the page's text is typeset; after changing text from code, call `TF.typeset(el)`.
- Self-contained: no network, no libraries from a CDN.

## Scenes

The `scene` tool's format is chalk's (its scene.md). Leave `theme` out (the app sets it), use the palette names for
colours, keep every label inside `size` with 16 units of margin, and don't put a filled rect under everything.

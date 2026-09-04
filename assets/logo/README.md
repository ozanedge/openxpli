# OpenXPLI logo

The mark is a loop: an inner pass that has closed and settled, and an outer
pass still running, ending in a head that points the way it is travelling.
The dot at the centre is the thing under test. It is drawn on a 24-unit grid
with the loop centred on (12, 12) and shifted 0.22 units down, so the head's
overshoot reads optically centred.

## Files

| File | Use |
| --- | --- |
| `openxpli-mark.svg` | Primary mark. Light backgrounds. |
| `openxpli-mark-inverse.svg` | Dark backgrounds. |
| `openxpli-mark-mono.svg` | One colour, inherits `currentColor`. Print, stamps, embroidery. |
| `openxpli-icon.svg` | Small-size cut: one pass, heavier stroke, no inner ring. Use at or below 20px. |
| `openxpli-favicon.svg` | The small cut on a near-black tile. Holds on light and dark tab bars. |
| `openxpli-lockup-horizontal.svg` | Mark + wordmark, one line. Needs Inter. |
| `openxpli-lockup-stacked.svg` | Mark over wordmark. Needs Inter. |
| `openxpli-favicon-16.png` · `-32.png` | Raster favicons. |
| `openxpli-apple-touch-icon-180.png` | iOS home screen. |
| `openxpli-icon-512.png` | Store / social / README hero. |
| `openxpli-mark-256.png` | Transparent raster mark. |
| `openxpli-lockup-*.png` | Lockups at 3x, type already outlined into pixels. |

## Colour

| Role | Hex | Notes |
| --- | --- | --- |
| Live pass, head | `#0072BE` | `--azure-deep` in the console |
| Live pass on dark | `#3FAEFF` | `--azure` lightened for contrast on `#1D1D1D` |
| Settled pass | `#6F6F6F` | `--text-2`; 45% white on dark, 38% `currentColor` in mono |
| Object | `#1D1D1D` | `--text`; white on dark |

Do not recolour the live pass to anything but azure — it is the only element
carrying brand colour, and the mark stops meaning anything if the two passes
read as the same weight.

## Sizes

- Full mark: **20px minimum**. Below that the settled pass closes up against
  the centre dot and you lose the second ring — switch to `openxpli-icon.svg`.
- Horizontal lockup: **96px wide minimum**.
- Stacked lockup: **44px wide minimum**.

## Clear space

Keep clear space on all sides equal to **half the mark's height**. For the
lockups, measure from the mark, not the wordmark's ascender.

## Wordmark

Inter 700, tracked `-0.022em`. The lockup SVGs reference Inter by name and
will fall back to the system sans if it is not installed; use the PNGs where
you cannot guarantee the font.

## Don't

- Don't rotate the mark. The head's position is the reading — turn it and the
  loop points somewhere meaningless.
- Don't add a second head to the inner pass.
- Don't put the full mark on a busy photograph; use the favicon tile.
- Don't rebuild the head as a stroke with a `marker-end`; it is a filled
  triangle sized against the arc, and markers will not match it.

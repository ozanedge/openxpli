# OpenXPLI identity

The mark is a **tapered spiral**: a loop that comes back round, but wider and
further out than it started. It is the product in one shape — an experimentation
engine does not repeat a cycle, it advances one. The ribbon begins thin at the
tail, gains weight as it travels, and resolves into a head that points on into
the next pass. The solid dot at the centre is the thing under test, held steady
while the loop moves around it.

## Files

| File | Use |
| --- | --- |
| `openxpli-mark.svg` | Primary mark. Light backgrounds. |
| `openxpli-mark-inverse.svg` | Dark backgrounds. |
| `openxpli-mark-mono.svg` | One colour, inherits `currentColor`. Print, stamps, embroidery. |
| `openxpli-icon.svg` | Same geometry on its native 24-unit grid. |
| `openxpli-favicon.svg` | Inverse mark inset on an ink tile. Holds on light and dark tab bars. |
| `openxpli-lockup-horizontal.svg` | Mark + wordmark on one line. |
| `openxpli-lockup-horizontal-inverse.svg` | The same for dark surfaces. |
| `openxpli-lockup-stacked.svg` | Centred, wordmark beneath the mark. |
| PNG exports | 16/32 favicons, 180 touch icon, 512 app icon, 256 mark, 8× lockups. |
| `preview.html`, `openxpli-brand-preview.png` | The identity at every size, light and dark. |

The wordmark is Helvetica Neue Medium converted to outlines, so no lockup
depends on an installed font, a network request or an external stylesheet.
Keep the product name **OpenXPLI** in prose; lowercase **openxpli** is the
visual wordmark.

## Colours

| Role | Colour |
| --- | --- |
| Ribbon | `#0072BE` |
| Object under test | `#151515` |
| Ribbon on dark surfaces | `#3FAEFF` |
| Object on dark surfaces | `#FFFFFF` |
| Favicon tile | `#101418` |

## Geometry

Drawn on a 24-unit grid, centred on (12, 12).

| | |
| --- | --- |
| Ribbon radius | 6.3 → 8.6 (advances 2.3 units per turn) |
| Ribbon width | 2.6 → 4.0 |
| Sweep | −18° to 271°, clockwise |
| Head | 5.05 long, 3.30 half-width — 1.65× the ribbon at its widest |
| Object | radius 2.80 |

**The counter is the constraint.** The clear space between the object and the
ribbon's inner edge is what fails first as the mark shrinks, and it is tightest
at the thin end of the taper: 2.20 units, about 1.5px at 16px. Every other
number is tuned around holding that. Changing the radii, the ribbon width or the
object without rechecking it will silently clog the mark at small sizes.

Because one ribbon and one object carry the whole idea, there is no separate
small-size cut — the primary mark is legible down to 16px. Do not add gradients,
shadows, outlines, a second ring, or any detail inside the counter.

---
name: diagrams
description: Create or revise an editable flowchart, system map, process diagram, or other connected diagram on Screens.
---

# Diagrams

Load `get_guide` for how the tools work. Identify the audience, the question the diagram answers, the nodes, relationships, direction and any essential labels. Simplify the story without dropping important branches or implying relationships not in the source.

1. Choose a layout that makes the reading order obvious. Lay out boxes on a regular row and column pitch, reserving space for connectors and labels. Size each box for its longest word and wrapped label; use fewer columns, a larger object or shorter wording before shrinking text. Use consistent sizes for nodes of the same kind.
2. Build the diagram inside an object. Give every box its own HTML element and `data-pid` so a person can move or retype it; make connector segments and labels separate pieces as useful. Do not flatten the entire diagram into one SVG. Use flex or grid for simple chains, or a positioned host for maps that need routed connectors. Keep the bundle self-contained and offline.
3. Calculate arrows from box edge midpoints and route through clear gaps, not through boxes or labels. Use separate straight segments for bends and a shared bus for branches. Place arrow labels clear of strokes and nodes. If a box moves or changes size, recalculate its connectors; they do not follow automatically.
4. Inspect the poster after each meaningful section and give one-line verdicts for spacing, typography, contrast, alignment, fit and repetition. Fix targeted issues, at most two correction rounds. Use `read_object` for exact source geometry, not the poster. Check that the visual reading order, direction and branch labels match the source, and report any unverified relationships.

If a poster is unavailable, report that visual review is blocked; do not claim the result was inspected.

## References

- Read [geometry](references/geometry.md) when laying out boxes, calculating connectors, or routing branches and loops.

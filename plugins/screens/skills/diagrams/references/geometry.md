# Diagram geometry

Record each box's left `x`, top `y`, width `w` and height `h` before drawing connectors. On a grid, equal-kind boxes share sizes; align row centers and column centers. Leave at least 48px between boxes, more when a route or label needs it. Make the host large enough for its contents and margins. Give every box enough width for its longest word plus padding; let labels wrap without clipping.

The right edge midpoint is `(x + w, y + h/2)`; the left is `(x, y + h/2)`; the bottom is `(x + w/2, y + h)`; the top is `(x + w/2, y)`. Start and end connectors at these points, with the arrow tip just short of the destination edge. If two connectors must share an edge, use distinct points such as one-third and two-thirds. A straight arrow needs aligned endpoints; otherwise route orthogonal segments through the gaps. Put the arrowhead on the last segment only.

For one-to-many relationships, run a stem to a shared bus in the gap, then branches to the children. Route loops outside the boxes along a clear strip. Keep labels at least 8px from lines and nodes. Draw background bands behind connectors and boxes; keep text in a logical reading order and describe the relationship in words as well as arrows. Inspect every endpoint, bend, label and overlap after changes. A visual poster checks the result; the source supplies the coordinates.

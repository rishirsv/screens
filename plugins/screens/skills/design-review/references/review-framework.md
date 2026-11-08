# Review framework

Start with the design's purpose and first impression. Trace the intended task and reading order: what draws attention, whether the right content wins, whether grouping and spacing help scanning, and whether controls and states are understandable. Check consistency against the actual design system, not a personal preference. Assess visible text legibility and contrast, and verify accessibility or behavior claims only with appropriate evidence.

For an audit, score layout and hierarchy, typography, color, interaction and states, motion, and copy separately out of 10. Use whole numbers with one line of evidence per score. As anchors, 10 is deliberate and robust for the inspected scope, 7 is sound with a few shortcomings, 4 materially impairs understanding or use, and 1 makes the area unusable or misleading. Mark an unseen or inapplicable area `Not rated` and say why. Never average the scores.

Rank findings by impact, not taste:

- **HIGH:** blocks a task, misleads, hides content or controls, risks data loss, or causes a repeated systemic failure.
- **MEDIUM:** meaningfully harms comprehension, efficiency, adaptability or consistency.
- **LOW:** isolated polish with limited task impact.

Confirmed inaccessible content, an unrecoverable error, a destructive action without an appropriate safeguard, or a misleading semantic color are high-impact findings. Name every confirmed location for a shared cause in one finding. Number findings so the person can refer to them. Propose the smallest effective correction, preferring deletion, platform behavior or an existing component before a new element.

For a ship-readiness audit, end `Block` if a HIGH finding remains, or `Approve` if none remains within the inspected scope. Name what was not reviewed. A static poster cannot establish that controls work, focus is visible, motion respects preferences, or contrast meets a numerical threshold; distinguish those unknowns from confirmed failures. For an open-ended critique, a prioritized recommendation is enough unless the person asked for a verdict.

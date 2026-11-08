---
name: explore-directions
description: Explore, compare, or propose several distinct visual directions for a design on Screens.
---

# Explore directions

Load `get_guide` for how the tools work. Ground the exploration in the same subject, audience, task, content and intended viewport. Inspect the Screen's existing identity and preserve it unless a new style is requested.

1. Define the decision the person needs to make. Pick a primary axis such as structure, density, emphasis, typography or voice. Sketch 2–4 genuinely different answers, defaulting to three, and name each for its concept rather than a letter or number. A color swap alone is not a direction. Adapt the depth of each to the decision: a focused first view for an early concept, more detail or interaction when needed to compare it.
2. Before the first `add_object`, post the design brief in chat unless the Screen or request already sets the style: mood candidates, the chosen mood and why it is not the first instinct, 5–6 hex colors with roles, type faces, weights and size scale, and a one-line direction. If the person named a mood, use it. For distinct palettes, state the mood and palette for each direction. Continue without waiting for approval.
3. Create each direction as a separate titled object. Use `set_status` with `new` as you begin each, and keep the names stable across turns. On an infinite canvas use `arrange_items` to make comparison easy; on a Presentation or Document use the page order instead. Keep rationale in chat, never inside the designs. Preserve existing work.
4. Review each hero before extending it. After each section, inspect the poster and give one-line verdicts for spacing, typography, contrast, alignment, fit and repetition; make targeted fixes, at most two rounds per section. Use `look: true` with `edit_object` or `get_poster` as needed, and `read_object` for exact source values. Keep each option legible, self-contained and offline, with bundled assets or system fonts and editable `data-pid` pieces. Never draw an iOS status bar or fake OS chrome.
5. Compare the named options in chat: how each answers the brief, when it works, its tradeoff and your recommendation. Name the viewport used. If the request is exploration only, leave the options for the person to choose; if they asked you to choose and build, continue with the best-supported direction.

If a poster is unavailable, report that visual review is blocked; do not claim the result was inspected.

## References

- Read [comparison](references/comparison.md) when selecting axes, setting the depth of exploration, or combining feedback.

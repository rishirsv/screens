---
name: design
description: Design, build, refine, or recreate a product screen, webpage, or other visual on Screens.
---

# Design

Load `get_guide` for how the tools work. Design for the person's brief and the Screen's established style; Screens' own interface is not the design system for the work on it.

1. Identify the subject, audience, primary job, intended effect, content and constraints. Inspect the relevant existing work and references. Infer a concrete subject and audience if needed; ask only when the answer would materially change the design. Respect an existing identity and the person's explicit direction.
2. Plan the hierarchy, composition, palette, type, and interaction. Review the plan against the brief and revise any choice that could have been applied to an unrelated subject. Open with the most characteristic content or interaction for this subject. Use realistic content, not filler.
3. Unless the Screen or request already sets the style, post a short brief in chat before the first `add_object`: 3–5 mood candidates, the chosen mood and why it is not your first instinct, 5–6 hex colors with roles, type faces, weights and size scale, and a one-line direction. If the person named a mood, use it rather than inventing alternatives. Continue without waiting for approval.
4. Set a working status with `set_status`, using `new` before adding an object. Build the hero or first major section first and review it before extending the design. For a watched build aim for 2–4 calls: `add_object`, then `edit_object` to write the rest in meaningful sections. Inert piece edits are cheap. Choose an existing object when the request calls for changing it; preserve its identity and stable pieces.
5. After each section, inspect the returned poster. `add_object` and `update_object` return one; request `look: true` on `edit_object`, or use `get_poster` for the whole object. Give a one-line verdict for each: spacing, typography, contrast, alignment, fit and repetition. Fix the most consequential issues before moving on. Use `read_object` for exact source values, never estimate them from a poster. Make targeted edits instead of restarting mostly-good work. Limit yourself to two correction rounds per section, then report remaining issues and uncertainty.
6. Inspect the finished object at its intended size. Check clipping, realistic content, hierarchy, contrast and the primary path or states that the request needs. Report the result and any limits on what was actually verified.

Build self-contained, offline bundles. Use system font stacks with close metrics or bundle font files and declare `@font-face`; never use web fonts or CDNs. Bundle images or use Media, never hotlink them. Put `data-pid` on pieces likely to change, and use flex or grid with `gap` so piece edits survive. Never draw an iOS status bar or fake OS chrome: mobile designs show only the app's own UI.

Keep the composition restrained: group with space and alignment before borders and cards; reserve boldness for what matters. Avoid generic kits of identical cards, decorative gradients and glows, all-caps eyebrows, arbitrary numbered labels, and accenting one word in every headline unless the brief has a reason. Use clear, specific copy and action labels; empty and error states should say what to do next. Preserve the primary task and make required controls and content legible and reachable.

If a poster is unavailable, report that visual review is blocked; do not claim the result was inspected.

## References

- Read [layout and type](references/layout-type.md) when shaping hierarchy, repeated rows, responsive behavior, or typography.
- Read [color](references/color.md) when choosing a palette or mood.
- Read [landing pages](references/landing.md) for a conversion or campaign page.
- Read [recreation and QA](references/recreate-qa.md) when matching a reference or checking fidelity to an accepted design.

---
name: design-review
description: Critique, audit, or assess a design on a Screen, including requests such as “what do you think?”
---

# Design review

Load `get_guide` for how the tools work. A request for critique authorizes a review, not design edits or comment changes.

1. Identify the target, audience, primary task, constraints and stage from the request and Screen. Use `get_view` as context, not permission to change work. Inspect the target's full poster with `get_poster` and its structure or source with `read_object`. Inspect relevant states or sizes if available; do not infer behavior or exact values from a picture. State missing context and scope.
2. Say what works and what the eye meets first, then assess whether hierarchy supports the task. Examine usability, layout, typography, color and contrast, consistency, accessibility, copy and relevant interaction or motion. Match the depth to the stage: early concepts need direction and task clarity; finished work needs detailed craft and states.
3. Report evidence-based findings in impact order. For each, name the object and piece or visible location, what is wrong, the user consequence and a concrete correction. Distinguish an observed problem from a preference or a hypothesis. Consolidate repeated symptoms with the same cause. Prefer removal or reuse before adding complexity.
4. For an audit, rate only inspected areas using the score anchors and severity in the reference. Mark inaccessible or inapplicable areas as not rated; never average the scores. End with a verdict scoped to what you actually inspected and the most valuable next changes. Do not edit the design or reply to comments unless separately asked.

## References

- Read [review framework](references/review-framework.md) when rating an audit, assigning severity, or writing a concrete finding.

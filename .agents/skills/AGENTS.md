# Managing project skills

Project skills live here, in `.agents/skills/<name>/SKILL.md`. `.claude/skills` is a symlink to this folder, so Claude Code and Codex read the same files. Edit them only here.

- **verify-screens**: how to prove a change works by driving the real surface. Use it after every user-visible change.
- **maintain-verify-screens**: the upkeep pass for verify-screens. Run it when a surface lands or changes, or when asked.
- **screens-performance**: tracked metrics and how to measure and improve them. Use only on request. Measurements stay in the gitignored `.perf/` folder.

Rules:

- **Every skill needs frontmatter**, with `name` matching the folder and a `description` that says when to use it. Without frontmatter the skill never registers.
- **A skill's scripts live in its own `scripts/` folder.** Each must be executable, have no dependencies where possible, and be shown with its invocation in the skill body.
- **Prove a skill change by running it.** Run the changed steps end to end before committing. A skill nobody ran is a draft.
- **Keep instructions with their owner.** Project rules live in AGENTS.md, procedures in skills, and measurements in the gitignored `.perf/` folder.
- **Add a new skill as a folder here.** Never add a second copy under `.claude/`.
- **Every `AGENTS.md` gets a `CLAUDE.md` symlink beside it.** Never write a separate CLAUDE.md.
- **App-driving code belongs in `packages/cli`.** Skills hold recipes (the `screens` blocks in verify-screens' features) and the separate host and performance probes.

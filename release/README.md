# Screens

A local canvas where you and your coding agent create, arrange, and comment on HTML designs. Works with Codex and Claude Code.

See the [installation instructions](https://github.com/rishirsv/screens#install) for the Screens plugin. To run the MCP server directly:

```sh
npx -y @rishirsv/screens mcp --host codex
```

Use `--host claude` for Claude Code. Requires Node.js 24 or later. Previews need Chrome or Chromium. On Linux, install Chromium with `npx playwright-core install --with-deps chromium`.

Run `npx @rishirsv/screens open` to open the library, `npx @rishirsv/screens doctor` to check the service, or `npx @rishirsv/screens stop` to stop it.

The library lives in `~/.screens` unless `SCREENS_HOME` is set. Your agent provider may receive prompts, tool calls, and results.

This project does not accept contributions or pull requests. Licensed under MIT.

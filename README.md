# Screens

A local canvas where you and your coding agent create, arrange, and comment on HTML designs. Works with Codex and Claude Code.

![App designs arranged on a Screens canvas](.github/assets/canvas.jpg)

Compare design directions, interact with prototypes, and leave comments for your agent. Add reference images, edit layers, or build a presentation or document.

![A presentation in Screens](.github/assets/slides.jpg)

## Install

Requires Node.js 24 or later and Chrome or Chromium for previews. Start with Codex or Claude Code already installed and configured.

```sh
git clone https://github.com/rishirsv/screens.git
cd screens
npm ci
npm run release
```

Install in your host.

### Codex

```sh
codex plugin marketplace add "$HOME/.local/share/screens/marketplace"
codex plugin add screens@screens-local
```

Open Screens from the sidebar or as a chat tab.

### Claude Code

```sh
claude plugin marketplace add "$HOME/.local/share/screens/marketplace"
claude plugin install screens@screens-local
node release/claude-desktop.mjs
```

Restart Claude Desktop after registration. In a Claude Desktop chat, `open_screen` opens the interactive canvas. It opens the library by default or a specific Screen when given its ID.

Claude Desktop registers the interactive `open_screen` tool. Its connection forwards actions from the widget to the local service. Code tab sessions do not receive this registration. The Claude Code marketplace plugin supplies agent tools and `open_screen_in_browser` for the Code tab, terminal sessions or browser fallback. The local release installer (`--install`) also updates the Desktop registration.

The Code tab can show a widget from a server that Claude Code starts, but it does not deliver the widget's actions to that server. In that case the widget shows the local URL and an Open in browser button.

In either host, use the returned local URL when a browser is needed. Pass `openBrowser: true` to launch the system browser explicitly.

Try this prompt:

> Design three directions for a sign-in screen in Screens.

Leave a comment on a design, then ask your agent to address it.

## Local data

Screens stores its library in `~/.screens`. Set `SCREENS_HOME` to use another folder. Your agent provider may receive prompts, tool calls, and results.

## Run from source

```sh
npm ci
SCREENS_HOME=.screens-dev npm start
```

Open the URL the service prints. The checkout's `.mcp.json` connects your agent to the development library.

```sh
npm run typecheck
npm run release:build
npm run release:verify
```

Repository skills live in [`.agents/skills`](.agents/skills). This project does not accept contributions or pull requests.

## License

[MIT](LICENSE). Third-party notices ship with the release package.

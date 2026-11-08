#!/usr/bin/env node
// screens mcp [--host claude|codex] starts the stdio MCP server; every other command goes to the service CLI.
await import(process.argv[2] === "mcp" ? "./mcp.js" : "./service.js");

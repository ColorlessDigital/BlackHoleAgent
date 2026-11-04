# BlackHole MCP Integration

BlackHole supports MCP as both a host-side client and a server.

## External MCP Servers

Create `.blackhole/mcp.json` in the workspace:

```json
{
  "enabled": true,
  "defaultPermission": "ask",
  "servers": {
    "context7": {
      "enabled": true,
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"]
    },
    "playwright": {
      "enabled": true,
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    },
    "github": {
      "enabled": true,
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}"
      }
    }
  },
  "permissions": {
    "*": "ask",
    "context7/*": "allow",
    "playwright/*": "ask",
    "github/*": "ask"
  }
}
```

BlackHole also reads the `mcp:` block from `.blackhole/config.yaml` or `.blackhole/config.yml`.

Stdio uses the standard newline-delimited JSON transport. Incoming legacy
`Content-Length` messages are also accepted, and the BlackHole server replies
using the incoming format. To connect to a legacy-only external server, add
`"framing": "content-length"` to that server's configuration. This changes only
wire framing, not tool permissions. EOF, invalid messages, and child-process
errors fail pending requests immediately; tool calls are not replayed.

Stopping a chat, cancelling a direct tool-call API request, or reaching a request
deadline stops local waiting and sends `notifications/cancelled` for that request.
Late replies are ignored. Other requests and the reusable server connection stay
active. Cancellation also works during tool discovery. The shared `initialize`
handshake is not cancelled; a stopped consumer stops waiting without interrupting
other consumers, while the existing connection timeout still applies.

An external server may not support cancellation, so stopping cannot guarantee
that its remote work has stopped or undo effects already committed. BlackHole
does not automatically replay the call. As an MCP server, BlackHole passes
cancellation and stdin EOF to its existing cancellable executors, cleans up
pending work, and suppresses results for cancelled requests. Tool permissions
and approval requirements are unchanged. See the official
[cancellation requirements](https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation).

Discovered tools are registered as:

```text
mcp__serverName__toolName
```

Example JSON tool call:

```json
{
  "tool_calls": [
    {
      "tool": "mcp__context7__resolve-library-id",
      "params": {
        "libraryName": "react"
      }
    }
  ]
}
```

## Permissions

Permission values:

- `allow`: execute without extra confirmation.
- `ask`: require confirmation even in autonomous mode.
- `block`: deny the tool.

Supported permission keys:

- Exact proxy name: `mcp__context7__resolve-library-id`
- Server/tool: `context7/resolve-library-id`
- Server wildcard: `context7/*`
- Global wildcard: `*`

## API

- `GET /api/mcp/config`
- `GET /api/mcp/tools`
- `POST /api/mcp/reload`
- `POST /api/mcp/tools/:proxyName/call`

## BlackHole As MCP Server

Expose BlackHole internal tools to an external MCP host:

```powershell
cd <repo>\blackhole
<repo>\node-v24.21.0-win-x64\node.exe src\mcp\blackholeMcpServer.js
```

Or:

```powershell
npm run mcp:server
```

The server exposes BlackHole's internal ToolRegistry through MCP `tools/list` and `tools/call`.

# BlackHole Coding Standard

Keep the project structured around product surfaces:

- Agent core owns planning, tool execution, verification, repair, memory, and model routing.
- Runtime code owns llama.cpp process discovery, startup, health checks, and model listing.
- Workspace code owns file, terminal, path, and project-root behavior.
- MCP code owns external MCP clients and BlackHole MCP server exposure.
- Frontend components must avoid duplicated navigation surfaces and must keep compact panels readable.

Machine-readable PR directives:

- require-file: package.json
- require-file: frontend/package.json
- require-file: src/config/workspaceConfig.js
- forbid-path: src/**/*.bak
- forbid-path: frontend/src/**/*.bak
- forbid-text: "<<<<<<<"
- forbid-text: ">>>>>>>"

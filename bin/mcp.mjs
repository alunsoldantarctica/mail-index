#!/usr/bin/env node
// mail-index MCP bin target: self-update check (detached) then the real server.
import { launch } from './launch.mjs';
await launch('mcp');

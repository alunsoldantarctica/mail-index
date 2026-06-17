#!/usr/bin/env node
// mail-index CLI bin target: self-update check (detached) then the real CLI.
import { launch } from './launch.mjs';
await launch('cli');

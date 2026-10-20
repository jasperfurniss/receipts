#!/usr/bin/env node
// Committed shim so pnpm can link the bin before `pnpm build` creates dist/.
import "../dist/index.js";

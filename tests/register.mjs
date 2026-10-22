/**
 * `node --test` entry point: installs the TypeScript resolver hook and nothing
 * else. See tests/README.md for what is covered and what is deliberately not.
 */

import { register } from "node:module";

register(new URL("./resolve-hooks.mjs", import.meta.url));

/**
 * Resolver hook so the tests can import the app's TypeScript directly.
 *
 * Three things Node does not do on its own: extensionless relative imports
 * (`./types`), the `@/` alias from tsconfig, and JSON modules imported without
 * the `type: "json"` attribute the ESM loader requires (the bundler accepts the
 * bare form, so the source stays as it is and the attribute is added here).
 * This keeps the regression suite dependency-free — it runs on any machine
 * with Node, no bundler, no test framework and no Android SDK.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const EXTENSIONS = [".ts", ".tsx", ".mts", ".js"];

function candidates(target) {
  return [...EXTENSIONS.map((extension) => `${target}${extension}`), ...EXTENSIONS.map((extension) => path.join(target, `index${extension}`))];
}

/**
 * `import dictionary from "./player-names.json"` is what the bundler wants and
 * what `node` rejects (`ERR_IMPORT_ATTRIBUTE_MISSING`). Declaring the attribute
 * from the resolver keeps `src/` bundler-idiomatic and still lets `node --test`
 * import the service layer as-is.
 */
function withJsonAttribute(resolved) {
  if (!resolved.url.endsWith(".json")) return resolved;
  return { ...resolved, importAttributes: { ...resolved.importAttributes, type: "json" } };
}

export async function resolve(specifier, context, nextResolve) {
  let spec = specifier;
  if (spec.startsWith("@/")) {
    spec = pathToFileURL(path.join(ROOT, "src", spec.slice(2))).href;
  }

  try {
    return withJsonAttribute(await nextResolve(spec, context));
  } catch (error) {
    let target = null;
    if (spec.startsWith("file:")) {
      target = fileURLToPath(spec);
    } else if (spec.startsWith(".")) {
      target = path.resolve(path.dirname(fileURLToPath(context.parentURL)), spec);
    }
    if (target) {
      for (const candidate of candidates(target)) {
        if (existsSync(candidate)) {
          return withJsonAttribute(await nextResolve(pathToFileURL(candidate).href, context));
        }
      }
    }
    throw error;
  }
}

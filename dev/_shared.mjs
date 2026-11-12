/**
 * Shared helpers for the verification scripts.
 *
 * Every script must work from a fresh clone, so nothing here hardcodes a
 * machine path: the plugin is located relative to this file, and the DSH
 * runtime is found through `DSH_TOOLS_PATH`, `DSH_RUNTIME_DIR`, or the profile
 * node_modules under `DSH_HOME`.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';

export const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Absolute path to one plugin file. */
export function pluginFile(name) {
  return path.join(pluginDir, name);
}

/** Import one plugin module by path relative to the package root. */
export function importPlugin(name) {
  return import(pathToFileURL(pluginFile(name)).href);
}

/** Directories worth searching for a DSH installation, in priority order. */
function searchRoots() {
  const roots = [];
  const explicit = process.env.DSH_RUNTIME_DIR;
  if (explicit) roots.push(path.join(explicit, 'node_modules'));

  const home = process.env.DSH_HOME;
  if (home) {
    const profiles = path.join(home, 'profiles');
    if (fs.existsSync(profiles)) {
      for (const entry of fs.readdirSync(profiles, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        roots.push(path.join(profiles, entry.name, 'node_modules'));
      }
    }
  }
  return roots;
}

/**
 * Resolve `@deepseek-ai/dsh-tools` from an installed DSH.
 *
 * Fails loudly rather than skipping the validator, because a verification
 * script that quietly checks nothing is worse than one that refuses to run.
 */
export function resolveDshTools() {
  const direct = process.env.DSH_TOOLS_PATH;
  if (direct) {
    if (!fs.existsSync(direct)) {
      throw new Error(`DSH_TOOLS_PATH points at ${direct}, which does not exist`);
    }
    return direct;
  }

  const requireFromHere = createRequire(import.meta.url);
  for (const base of searchRoots()) {
    try {
      return requireFromHere.resolve('@deepseek-ai/dsh-tools', { paths: [base] });
    } catch {
      // try the next candidate
    }
  }
  try {
    return requireFromHere.resolve('@deepseek-ai/dsh-tools');
  } catch {
    // report below
  }

  throw new Error(
    'cannot locate @deepseek-ai/dsh-tools, so the runtime validators are unavailable.\n'
    + 'These checks run against an installed DeepSeek Harness. Point at your installation either way:\n'
    + '  DSH_TOOLS_PATH=/path/to/node_modules/@deepseek-ai/dsh-tools/lib/index.js\n'
    + '  DSH_RUNTIME_DIR=/path/to/dsh-runtime',
  );
}

/** Import the runtime's tool validators. */
export async function importDshTools() {
  return import(pathToFileURL(resolveDshTools()).href);
}

/**
 * Resolve `@deepseek-ai/schemastery`.
 *
 * The plugin declares it as a dependency, so an installed profile already has
 * it; a fresh clone has no `node_modules` at all. Rather than require a local
 * install just to run the checks, borrow the copy from the DSH installation the
 * rest of these scripts already point at.
 */
export function resolveSchemastery() {
  const direct = process.env.DSH_SCHEMASTERY_PATH;
  if (direct) {
    if (!fs.existsSync(direct)) {
      throw new Error(`DSH_SCHEMASTERY_PATH points at ${direct}, which does not exist`);
    }
    return direct;
  }

  const requireFromHere = createRequire(import.meta.url);
  // A local install wins: it is what the package actually ships with.
  try {
    return requireFromHere.resolve('@deepseek-ai/schemastery');
  } catch {
    // fall through to the harness copy
  }

  for (const base of searchRoots()) {
    const entry = path.join(base, '@deepseek-ai', 'schemastery', 'lib', 'index.js');
    if (fs.existsSync(entry)) return entry;
    try {
      return requireFromHere.resolve('@deepseek-ai/schemastery', { paths: [base] });
    } catch {
      // try the next candidate
    }
  }

  throw new Error(
    'cannot locate @deepseek-ai/schemastery, so the plugin\'s Config schema cannot be checked.\n'
    + 'Point at your installation either way:\n'
    + '  DSH_SCHEMASTERY_PATH=/path/to/node_modules/@deepseek-ai/schemastery/lib/index.js\n'
    + '  DSH_RUNTIME_DIR=/path/to/dsh-runtime',
  );
}

/**
 * Make `@deepseek-ai/schemastery` importable from the package root.
 *
 * `index.js` imports it by bare specifier, and a bare specifier is resolved by
 * Node's own loader — no hook here can redirect it. A fresh clone therefore
 * needs a `node_modules` entry before the plugin can be imported at all. This
 * creates one that points at the harness copy, and reports the directory so the
 * caller can remove it afterwards.
 * @returns the created directory, or `undefined` when nothing was created.
 */
export function ensureSchemasteryReachable() {
  const modulesDir = path.join(pluginDir, 'node_modules');
  const linkDir = path.join(modulesDir, '@deepseek-ai');
  const target = path.join(linkDir, 'schemastery');
  if (fs.existsSync(target)) return undefined;

  // Trim a trailing /lib/index.js down to the package root.
  const entry = resolveSchemastery();
  const packageRoot = path.basename(path.dirname(entry)) === 'lib'
    ? path.dirname(path.dirname(entry))
    : path.dirname(entry);

  // Remember whether `node_modules` was already there, so cleanup removes only
  // what this run created and never deletes a real install.
  const modulesExisted = fs.existsSync(modulesDir);

  fs.mkdirSync(linkDir, { recursive: true });
  fs.symlinkSync(packageRoot, target, 'junction');
  return modulesExisted ? linkDir : modulesDir;
}

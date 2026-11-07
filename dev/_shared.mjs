/**
 * Shared helpers for the verification scripts.
 *
 * Every script must work from a fresh clone, so nothing here hardcodes a
 * machine path: the plugin is located relative to this file, and the DSH
 * runtime is found through `DSH_RUNTIME_DIR`, this process's own resolution,
 * or the profile node_modules under `DSH_HOME`.
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

  // A profile's node_modules holds whatever profile-installed bundles need,
  // and `@deepseek-ai/dsh-tools` there is the copy the Harness resolves.
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
  // A direct path wins: the caller knows exactly where the module is.
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
    + '  DSH_RUNTIME_DIR=/path/to/dsh-runtime\n'
    + 'The Desktop app keeps its runtime under the app resources directory, for example\n'
    + '  <install>/resources/dsh-runtime/node_modules',
  );
}

/** Import the runtime's tool validators. */
export async function importDshTools() {
  return import(pathToFileURL(resolveDshTools()).href);
}

/** Whether one file exists. */
export function exists(file) {
  return fs.existsSync(file);
}

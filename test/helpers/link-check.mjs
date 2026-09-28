// Link, without running, the module graph under each entry point given on the
// command line. Linking is where an ES module fails when it imports a name the
// target does not export; a browser reports that only in the console of the
// page or service worker that died of it. Needs --experimental-vm-modules.
// Prints one line per failure and exits non-zero if there was any.
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const root = resolve(process.argv[2]);
const cache = new Map();
const context = vm.createContext({});

function load(path) {
  if (!cache.has(path)) {
    cache.set(path, new vm.SourceTextModule(readFileSync(path, 'utf8'), { identifier: path, context }));
  }
  return cache.get(path);
}

const linker = (specifier, referencing) => {
  if (!specifier.startsWith('.')) throw new Error(`${referencing.identifier}: bare import ${specifier}`);
  return load(resolve(dirname(referencing.identifier), specifier.split('?')[0]));
};

let failed = 0;
for (const entry of process.argv.slice(3)) {
  try {
    await load(resolve(root, entry)).link(linker);
  } catch (e) {
    failed++;
    console.log(`${entry}: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);

/**
 * Build `lib/client.js` from `src/body.js`.
 *
 * The DSH client module system loads a package's client half as a script that
 * calls `window.__ModuleLoader__.load({ id, factory })`. The factory receives a
 * `require`, and the loader reads `apply` / `inject` off the returned exports.
 *
 * Two extra requires are threaded in and exposed as globals to the body:
 *   - `react-dom` for the modal portal;
 *   - `@deepseek-ai/dsh-client-ui-primitives` for the anchored positioning and
 *     outside-pointer dismissal, so the panel behaves like every other floating
 *     surface in the harness instead of a bespoke one.
 *
 * Plain text transform on purpose: no bundler, no dependency tree.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ID = 'dsh-token-usage';
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const bodyPath = join(root, 'src', 'body.js');
const outPath = join(root, 'lib', 'client.js');

const body = readFileSync(bodyPath, 'utf8').replace(/\r\n/g, '\n').replace(/\s+$/, '');

// The body is one `(function () { ... return {...}; })();` IIFE; splice its
// contents into the module factory so the IIFE value becomes `mod`.
const OPEN = '(function () {';
const CLOSE = '\n})();';
const openAt = body.indexOf(OPEN);
const cut = body.lastIndexOf(CLOSE);
if (openAt < 0 || cut < 0) {
  throw new Error('src/body.js must be a single IIFE: "(function () {" ... "})();"');
}
const inner = body.slice(openAt + OPEN.length, cut + 1).replace(/\s+$/, '');

const wrapped = `window.__ModuleLoader__.load({
  id: "${ID}",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");
    // react-dom is a baseline browser module, but keep the plugin booting if a
    // future loader stops exposing it: the modal then renders inline.
    let reactDom = null;
    try { reactDom = require("react-dom"); } catch (e) { reactDom = null; }
    // Do not require Harness Client packages: they are not a public module
    // surface. The panel uses fixed positioning when no primitives are present.
    const React = react;
    const ReactDOMBridge = reactDom;
    const PRIMITIVES = null;
    const mod = (function () {
${inner}
    })();
    exports.apply = mod.apply;
    exports.inject = mod.inject;
    return module.exports;
  }
});
`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, wrapped, 'utf8');
console.log(`built ${outPath} (${wrapped.length} bytes)`);

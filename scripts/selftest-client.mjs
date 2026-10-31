/**
 * Client test: load `lib/client.js` in a simulated harness and render the panel
 * against real-shaped projection data.
 *
 * The point is to catch the mistakes that only appear at render time -- a hook
 * called conditionally, a projection read from the wrong field, a portal that
 * never mounts -- none of which a syntax check would notice.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const clientPath = join(here, '..', 'lib', 'client.js');

// Figures taken from a real session, so the formatting assertions are about
// behaviour on actual magnitudes rather than tidy round numbers.
const SNAPSHOT = {
  meta: {
    tzOffsetMinutes: 480, generatedAt: 3,
    costs: {
      configured: true,
      workbuddy: {
        configured: true, unit: 'credits', credits: 2286.7,
        coveredTokens: 6195122271, totalTokens: 6834196026, coverage: 0.9065,
        sourcePath: 'C:/state.json',
      },
      official: {
        configured: true, currency: 'USD', tier: 'peak', usd: 73.48, cny: 529.06,
        usdToCny: 7.2, coveredTokens: 6195122271, totalTokens: 6834196026, coverage: 0.9065,
      },
    },
  },
  global: { uncachedInputTokens: 4244196, outputTokens: 409267, cacheReadTokens: 374772880, cacheWriteTokens: 0, totalTokens: 379426343, promptTokens: 379017076, cacheHitRate: 0.9888, requests: 1197, sessions: 5 },
  days: [
    { day: '2026-10-05', totalTokens: 1050, promptTokens: 1000, outputTokens: 50, cacheReadTokens: 900, uncachedInputTokens: 100, cacheWriteTokens: 0, requests: 2, sessions: 1 },
    { day: '2026-10-04', totalTokens: 379425293, promptTokens: 379016076, outputTokens: 409217, cacheReadTokens: 374772880, uncachedInputTokens: 4244196, cacheWriteTokens: 0, requests: 1195, sessions: 4 },
  ],
  routes: [{ route: 'workbuddy:cn:space-bunny', totalTokens: 379426343, sessions: 5, requests: 1197 }],
  sessions: [{
    sessionId: 'session-a260fd2f', title: '帮我设计一款插件', cwd: 'C:/x/default-workspace',
    route: 'workbuddy:cn:space-bunny', createdAt: 1, lastActivity: 2, requests: 54,
    uncachedInputTokens: 71267, outputTokens: 39166, cacheReadTokens: 2137498, cacheWriteTokens: 0,
    totalTokens: 2247931, promptTokens: 2208765, cacheHitRate: 0.9675,
  }],
};

const PROJECTIONS = {
  tokenUsage: { uncachedInputTokens: 860573, outputTokens: 246790, cacheReadTokens: 146358420, cacheWriteTokens: 0 },
  sessionStats: { turns: 3, steps: 54, llmMs: 7000, toolMs: 3000, ttftMs: 1200, ttftSteps: 3, decodeMs: 2000, decodeTokens: 200 },
  contextPressure: { pressureTokens: 220000, projectedTokens: 230000, contextWindow: 1000000 },
};

let failures = 0;
function check(label, cond, extra) {
  if (!cond) failures += 1;
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${extra !== undefined ? ' -> ' + extra : ''}`);
}

// ------------------------------------------------------------------ mini React

let renderFn = null;
let currentTree = null;
const hooks = [];
let hookIndex = 0;
const effects = [];
const effectDeps = [];
let renderCount = 0;

function makeElement(type, props, ...children) {
  if (type === undefined || type === null) throw new Error('invalid element type ' + String(type));
  const flat = [];
  const push = (c) => { if (Array.isArray(c)) c.forEach(push); else if (c !== null && c !== undefined) flat.push(c); };
  children.forEach(push);
  return { $$typeof: 'el', type, props: { ...(props || {}), children: flat.length === 1 ? flat[0] : flat } };
}

const React = {
  Fragment: 'Fragment',
  createElement: makeElement,  useState(initial) {
    const i = hookIndex++;
    if (hooks.length <= i) hooks[i] = typeof initial === 'function' ? initial() : initial;
    const set = (next) => {
      hooks[i] = typeof next === 'function' ? next(hooks[i]) : next;
      if (renderFn && renderCount < 400) { renderCount += 1; currentTree = renderFn(); }
    };
    return [hooks[i], set];
  },
  useRef(initial) { const i = hookIndex++; if (hooks.length <= i) hooks[i] = { current: initial }; return hooks[i]; },
  useMemo(fn) { return fn(); },
  useEffect(fn, deps) {
    const i = hookIndex++;
    const prev = effectDeps[i];
    const changed = prev === undefined || deps === undefined || deps.length !== prev.length
      || deps.some((d, k) => !Object.is(d, prev[k]));
    effectDeps[i] = deps;
    if (changed) effects.push(fn);
  },
};

class Component {
  constructor(props) { this.props = props; this.state = {}; }
  setState(next) {
    this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) };
  }
}
Component.prototype.isReactComponent = {};
React.Component = Component;

const portalCalls = [];
const ReactDOMBridge = { createPortal: (children, container) => { portalCalls.push({ children, container }); return { $$typeof: 'portal', children, container }; } };

// ------------------------------------------------------------------ environment

const styleEls = [];
const document = {
  head: { appendChild: (el) => styleEls.push(el) },
  body: {},
  createElement: () => ({ dataset: {}, textContent: '', remove() { styleEls.pop(); } }),
  addEventListener: () => {},
  removeEventListener: () => {},
};

let resourceValue = { status: 'live', value: SNAPSHOT };
let useResourceCalls = 0;
const sandbox = {
  window: { __ModuleLoader__: null },
  document, React, Symbol, isFinite, isNaN, parseInt, parseFloat, Date, Math, JSON, Object, Array, Number, String, Error, Set, console,
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) }),
};
sandbox.globalThis = sandbox;

let registered = null;
const primitives = {
  useAnchoredPosition: (opts) => (opts.open ? { top: 40, left: 16 } : undefined),
  useDismissOnOutsidePointer: () => {},
};
sandbox.window.__ModuleLoader__ = {
  load(def) {
    registered = def.factory((id) => {
      if (id === 'react') return React;
      if (id === 'react-dom') return ReactDOMBridge;
      if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
      throw new Error('unexpected require: ' + id);
    });
  },
};

vm.createContext(sandbox);
vm.runInContext(readFileSync(clientPath, 'utf8'), sandbox, { filename: 'client.js' });

// ------------------------------------------------------------------ assertions

console.log('=== client test ===');
check('exports apply', typeof registered.apply === 'function');
check('exports inject', Array.isArray(registered.inject), JSON.stringify(registered.inject));
check('inject includes slots', registered.inject.includes('slots'));

const slotCalls = [];
const resourceDefs = [];
const fakeRemote = {
  workspaceFiles: {
    read: async () => ({ ok: true, value: { text: JSON.stringify(SNAPSHOT) } }),
  },
};
const ctx = {
  effect(fn) { return fn(); },
  get(name) { return name === 'remote' ? fakeRemote : undefined; },
  resources: {
    register(def) { resourceDefs.push(def); return () => {}; },
  },
  slots: {
    inject(name, fn) { slotCalls.push({ name, fn }); return () => {}; },
    register(spec, component) { return { spec, component }; },
  },
  logger: { info: (m) => console.log('  [log]', m) },
};
registered.apply(ctx);
check('one slot injected', slotCalls.length === 1, slotCalls[0] && slotCalls[0].name);
check('one history resource registered', resourceDefs.length === 1, String(resourceDefs.length));

// The resource provider reads the workspace mirror through the official
// `workspaceFiles` namespace; no third-party Remote namespace is required.
{
  const controller = new AbortController();
  const iterator = resourceDefs[0].open('dsh-resource://tokenusage/session-a260fd2f', { signal: controller.signal })[Symbol.asyncIterator]();
  const first = await iterator.next();
  controller.abort();
  await iterator.return?.();
  check('resource open yields the snapshot', first.done !== true && first.value.ok === true && first.value.value.global !== undefined, JSON.stringify(first.value && first.value.ok));
}
check('style injected', styleEls.length === 1);
check('entry declares no private inject', slotCalls[0].fn().spec.inject === undefined);

const entry = slotCalls[0].fn();
const Readout = entry.component;
check('registered on the session-scope slot', entry.spec.name === 'conversation.session.header.utilities', entry.spec.name);
check('uses a distinct order', entry.spec.order !== 900, String(entry.spec.order));

function mount(props) {
  const run = () => {
    hookIndex = 0;
    effects.length = 0;
    const isClass = typeof Readout === 'function'
      && Readout.prototype !== undefined && Readout.prototype.isReactComponent;
    let tree;
    if (isClass) {
      const instance = new Readout(props);
      instance.props = props;
      if (instance.state === undefined) instance.state = {};
      tree = element(instance.render());
    } else {
      tree = Readout(props);
    }
    const queued = effects.splice(0, effects.length);
    for (const e of queued) e();
    return tree;
  };
  renderFn = run;
  renderCount += 1;
  currentTree = run();
  return currentTree;
}

function element(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node;
  if (node.props === undefined || node.props === null) return node;
  if (typeof node.type === 'function') return element(node.type(node.props));
  const kids = node.props.children;
  let children = kids;
  if (Array.isArray(kids)) children = kids.map(element);
  else if (kids !== null && kids !== undefined && typeof kids === 'object') children = element(kids);
  return { ...node, props: { ...node.props, children } };
}

const useProjection = (key) => PROJECTIONS[key];
const useResource = () => { useResourceCalls += 1; return resourceValue; };

let tree = mount({ useProjection, useResource });
// The component returns a Fragment holding [button, panel, modal]; `element()`
// collapses it so the assertions can look at the trigger directly.
let flat = element(tree);
const parts = Array.isArray(flat.props.children) ? flat.props.children : [flat.props.children];
const trigger = parts[0];
check('renders a button trigger', trigger && trigger.type === 'button', trigger && trigger.type);
check('trigger has a class', trigger.props.className === 'tsl-trigger', trigger.props.className);
const label = trigger.props.children[1];
// The trigger shows the CURRENT session (146358420 cache + 860573 in +
// 246790 out = 147465783), not the cross-session history total. Those are
// deliberately different numbers and the UI must not conflate them.
check('trigger shows the live session total', label && label.props.children === '147.5M',
  label && label.props.children);
check('title lists the breakdown', String(trigger.props.title).includes('147,465,783'),
  String(trigger.props.title).split('\n')[0]);
check('title breaks down the buckets', String(trigger.props.title).includes('缓存读 146,358,420'),
  String(trigger.props.title).split('\n').slice(1).join(' | '));

// Hover opens the panel.
trigger.props.onMouseEnter();
check('hover opens the panel', currentTree !== tree);

const panelTree = currentTree;
const kids = Array.isArray(panelTree.props.children) ? panelTree.props.children : [panelTree.props.children];
const panel = kids[1];
check('panel rendered', panel !== undefined && panel !== null && panel !== false, String(kids.length));

// Hover intent: leaving the trigger schedules a close, but entering the panel
// must cancel it. This is the regression test for the "panel flashes and
// disappears" bug: the old handler closed the panel on the trigger's
// mouseleave before the pointer could cross the gap into the panel.
if (panel) {
  trigger.props.onMouseLeave();
  check('panel survives the trigger-to-panel gap', currentTree === panelTree);
  panel.props.onMouseEnter();
  await new Promise((resolve) => setTimeout(resolve, 250));
  check('panel stays open after the pointer enters it', currentTree === panelTree);
}

if (panel) {
  const rendered = element(panel.props.children);
  // Collect every text leaf rather than regexing the serialised tree, so the
  // assertions look at what a user would actually read.
  const leaves = [];
  (function walk(node) {
    if (node === null || node === undefined) return;
    if (typeof node === 'string' || typeof node === 'number') { leaves.push(String(node)); return; }
    if (typeof node !== 'object' || node.props === undefined) return;
    const kids = node.props.children;
    if (Array.isArray(kids)) kids.forEach(walk);
    else if (kids !== null && kids !== undefined && typeof kids === 'object') walk(kids);
    else if (kids !== null && kids !== undefined) leaves.push(String(kids));
  })(rendered);
  const text = leaves.join(' | ');
  check('panel shows the live cumulative', leaves.includes('147.5M'), text.slice(0, 120));
  // cacheRead 146358420 of (146358420 + 860573) => 0.99412..., and the formatter
  // drops the decimal at >= 0.1, so this must read "99%".
  check('panel shows cache hit rate', leaves.includes('99%'), '');
  check('panel shows output speed', leaves.includes('100 tok/s'), '');
  // first-token latency and the model-time share share one sub-line, so match
  // the composed string rather than a bare token.
  check('panel shows first-token latency and model share',
    leaves.some((s) => s.includes('400ms') && s.includes('70%')), '');
  check('panel shows context occupancy', leaves.includes('22%'), '');
  check('panel has a history button', leaves.includes('历史累计'), '');
  // The hover panel shows the cross-session cumulative (including deleted
  // sessions) as soon as it opens; it does not wait for the modal.
  check('panel shows cumulative history while hovering',
    text.includes('历史累计') && text.includes('379.4M') && text.includes('5 个会话'),
    text.slice(-110));
}

// History modal, via the panel's button.
resourceValue = { status: 'live', value: SNAPSHOT };
// The panel is a positioned wrapper whose child is the LivePanel element; find
// the history button in the fully rendered subtree.
const panelRendered = element(panel.props.children);
const modalTrigger = (function find(node) {
  if (node === null || node === undefined || typeof node !== 'object' || node.props === undefined) return null;
  if (node.type === 'button' && typeof node.props.onClick === 'function'
    && JSON.stringify(node.props.children).includes('历史累计')) return node;
  const kids2 = node.props.children;
  if (Array.isArray(kids2)) { for (const k of kids2) { const f = find(k); if (f) return f; } }
  else if (kids2 !== null && kids2 !== undefined && typeof kids2 === 'object') { const f = find(kids2); if (f) return f; }
  return null;
})(panelRendered);

check('history button found', modalTrigger !== null);
if (modalTrigger) {
  modalTrigger.props.onClick();
  check('modal rendered through a portal', portalCalls.length >= 1, String(portalCalls.length));
  const last = portalCalls[portalCalls.length - 1];
  check('modal mounts on document.body', last.container === document.body);
  const modal = element(last.children);
  const modalLeaves = [];
  (function walk(node) {
    if (node === null || node === undefined) return;
    if (typeof node === 'string' || typeof node === 'number') { modalLeaves.push(String(node)); return; }
    if (typeof node !== 'object' || node.props === undefined) return;
    const kids = node.props.children;
    if (Array.isArray(kids)) kids.forEach(walk);
    else if (kids !== null && kids !== undefined && typeof kids === 'object') walk(kids);
    else if (kids !== null && kids !== undefined) modalLeaves.push(String(kids));
  })(modal);
  const modalText = modalLeaves.join(' | ');
  check('modal shows the day table', modalLeaves.includes('2026-10-05'), '');
  check('modal shows total history', modalLeaves.includes('379.4M'), modalText.slice(0, 160));
  check('modal shows cumulative summary including deleted sessions',
    modalLeaves.some((s) => s.includes('历史累计')) && modalText.includes('含已删除会话')
      && modalText.includes('含已删除/已归档'),
    modalText.slice(0, 200));
  check('modal has all three tabs', ['按天', '按模型', '按会话'].every((t) => modalLeaves.includes(t)), '');
  check('modal shows real WorkBuddy credit cost', modalText.includes('2,287 credits') && modalText.includes('WorkBuddy'), modalText.slice(0, 260));
  check('modal exposes all cost switches', ['积分', '人民币', '美元'].every((t) => modalText.includes(t)), modalText.slice(0, 260));
  check('modal exposes both chart views', modalText.includes('API 请求次数') && modalText.includes('Tokens'), modalText.slice(0, 260));
  // A short window (a compressed task pane) used to clip the dialog's lower
  // half without any scrollbar: the table had a 180px floor and the footer was
  // a sibling that got pushed out of an overflow:hidden box.
  const findNode = (node, pred) => {
    if (node === null || node === undefined || typeof node !== 'object' || node.props === undefined) return null;
    if (pred(node)) return node;
    const kids = node.props.children;
    const list = Array.isArray(kids) ? kids : [kids];
    for (const kid of list) {
      const hit = findNode(kid, pred);
      if (hit !== null) return hit;
    }
    return null;
  };
  const hasClass = (name) => (node) => typeof node.props.className === 'string'
    && node.props.className.split(' ').includes(name);
  const bodyNode = findNode(modal, hasClass('tsl-dash-body'));
  check('dialog has a scrollable body wrapper', bodyNode !== null);
  check('the day table lives inside that body', bodyNode !== null && findNode(bodyNode, hasClass('tsl-table-wrap')) !== null);
  check('the footer stays outside that body', bodyNode !== null && findNode(bodyNode, hasClass('tsl-update-row-footer')) === null);
  const cssText = styleEls.map((el) => el.textContent).join('');
  check('the body wrapper scrolls', cssText.includes('.tsl-dash-body{flex:1 1 auto;min-height:0;overflow:auto'));
  check('the table may shrink below its old floor', cssText.includes('.tsl-table-wrap{flex:1 1 auto;min-height:120px;overflow:auto'));
  // Redesign step 1 (Stitch "Token 用量与效能监控看板"): card footers, inline
  // day bars, engine status line and the Releases entry.
  const countClass = (node, cls) => {
    let found = 0;
    const walk = (x) => {
      if (x === null || x === undefined || typeof x !== 'object' || x.props === undefined) return;
      const value = x.props.className;
      if (typeof value === 'string' && value.split(' ').includes(cls)) found += 1;
      const kids = x.props.children;
      (Array.isArray(kids) ? kids : [kids]).forEach(walk);
    };
    walk(node);
    return found;
  };
  check('every stat card has a footer strip', countClass(modal, 'tsl-stat-foot') >= 3, String(countClass(modal, 'tsl-stat-foot')));
  check('the day table shows an inline bar next to the number', countClass(modal, 'tsl-rowbar') >= 1);
  check('the footer no longer carries an engine status line', countClass(modal, 'tsl-status-dot') === 0 && !modalText.includes('Prompt Cache'));
  check('Releases lives in the header only', countClass(modal, 'tsl-head-btn') === 1
    && countClass(modal, 'tsl-link-btn') === 0 && modalText.includes('GitHub Releases'));
  check('the cache card advertises 极速镜像', modalText.includes('极速镜像'));
  // Hover used to hang a listener on every tick and tween the tip's left edge,
  // which read as a stutter at each point. One overlay + no tween now.
  check('the plot has a single hover overlay', countClass(modal, 'tsl-chart-hit') === 1);
  check('the tooltip does not tween its position', !cssText.includes('transition:left .06s linear'));



  check('modal now reads the resource', useResourceCalls > 0, `useResource called ${useResourceCalls}x`);
}

// Degraded paths must not crash.
resourceValue = { status: 'loading' };
let degraded = mount({ useProjection, useResource });
const degraded1 = element(degraded);
const degraded1Parts = Array.isArray(degraded1.props.children) ? degraded1.props.children : [degraded1.props.children];
check('renders while history loads', degraded1Parts[0] && degraded1Parts[0].type === 'button');

resourceValue = { status: 'none' };
degraded = mount({ useProjection, useResource });
const degraded2 = element(degraded);
const degraded2Parts = Array.isArray(degraded2.props.children) ? degraded2.props.children : [degraded2.props.children];
check('renders when history is absent', degraded2Parts[0] && degraded2Parts[0].type === 'button');

degraded = mount({ useProjection: undefined, useResource: () => ({ status: 'none' }) });
const degraded3 = element(degraded);
const degraded3Parts = Array.isArray(degraded3.props.children) ? degraded3.props.children : [degraded3.props.children];
check('survives a missing useProjection', degraded3Parts[0] && degraded3Parts[0].type === 'button');
degraded3Parts[0].props.onMouseEnter();
const afterNoHook = element(currentTree);
const afterNoHookParts = Array.isArray(afterNoHook.props.children) ? afterNoHook.props.children : [afterNoHook.props.children];
check('panel explains the missing hook', JSON.stringify(afterNoHookParts[1] ?? {}).includes('useProjection'), '');

console.log(`\n=> ${failures === 0 ? 'ALL CLIENT CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);

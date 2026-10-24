window.__ModuleLoader__.load({
  id: "dsh-token-usage",
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


  var h = React.createElement;
  var useState = React.useState;
  var useEffect = React.useEffect;
  var useRef = React.useRef;
  var useMemo = React.useMemo;

  // ---------------------------------------------------------------- formatting

  function tokens(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '-';
    if (n < 1000) return String(Math.round(n));
    if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0) + 'K';
    if (n < 1e9) return (n / 1e6).toFixed(n < 1e7 ? 2 : 1) + 'M';
    return (n / 1e9).toFixed(2) + 'B';
  }

  /**
   * A ratio that may be unknown.
   *
   * `null` means "cannot be computed" (no prompt traffic yet). That has to read
   * as "--", never "0%": zero is a measurement, "--" is an admission.
   */
  function percent(ratio) {
    if (ratio === null || ratio === undefined) return '--';
    if (typeof ratio !== 'number' || !isFinite(ratio)) return '--';
    return (ratio * 100).toFixed(ratio >= 0.1 ? 0 : 1) + '%';
  }

  function rate(tps) {
    if (tps === null || tps === undefined) return '--';
    if (typeof tps !== 'number' || !isFinite(tps)) return '--';
    return (tps >= 100 ? Math.round(tps) : tps.toFixed(1)) + ' tok/s';
  }

  function ms(v) {
    if (v === null || v === undefined) return '--';
    if (typeof v !== 'number' || !isFinite(v)) return '--';
    return v < 1000 ? Math.round(v) + 'ms' : (v / 1000).toFixed(1) + 's';
  }

  function when(epoch) {
    if (!epoch) return '-';
    try {
      var d = new Date(epoch);
      return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) { return String(epoch); }
  }

  function shortCwd(cwd) {
    if (!cwd) return '';
    var parts = String(cwd).split(/[\\/]/).filter(Boolean);
    return parts.slice(-2).join('/') || String(cwd);
  }

  function shortRoute(route) {
    if (!route || route === 'unknown') return '未标注';
    var model = route.indexOf(':') >= 0 ? route.slice(route.indexOf(':') + 1) : route;
    return model.replace(/^cn:/, '');
  }

  // ---------------------------------------------------------------- live read

  /**
   * Read one projection and normalise it.
   *
   * `tokenUsage` carries the four usage buckets; `sessionStats` carries the
   * timing fields the speed figures are derived from; `contextPressure` carries
   * the prompt-side occupancy. Each is shaped differently, so each gets its own
   * reader rather than one generic "find a number" path that could quietly
   * report the wrong field.
   */
  function readLive(useProjection) {
    var out = { ok: false, reason: 'no-hook' };
    if (typeof useProjection !== 'function') return out;

    // All three hooks MUST run on every render, before any early return. If a
    // projection is temporarily absent (compaction/session switch) and we
    // returned before calling the other two, the next render would change the
    // hook count -- React throws and the readout falls back to a bare "Token".
    var usage = useProjection('tokenUsage');
    var stats = useProjection('sessionStats');
    var pressure = useProjection('contextPressure');

    var buckets = usage !== null && typeof usage === 'object' && usage.totals !== undefined && usage.totals !== null
      ? usage.totals : usage;
    if (buckets === null || typeof buckets !== 'object') {
      out.reason = 'tokenUsage-absent';
      return out;
    }
    var inTok = Number(buckets.uncachedInputTokens);
    var outTok = Number(buckets.outputTokens);
    var cacheR = Number(buckets.cacheReadTokens);
    var cacheW = Number(buckets.cacheWriteTokens);
    if (!isFinite(inTok) && !isFinite(outTok)) {
      out.reason = 'tokenUsage-empty';
      return out;
    }

    var total = (isFinite(inTok) ? inTok : 0)
      + (isFinite(cacheR) ? cacheR : 0)
      + (isFinite(cacheW) ? cacheW : 0)
      + (isFinite(outTok) ? outTok : 0);
    var prompt = (isFinite(inTok) ? inTok : 0) + (isFinite(cacheR) ? cacheR : 0) + (isFinite(cacheW) ? cacheW : 0);
    var denominator = (isFinite(cacheR) ? cacheR : 0) + (isFinite(inTok) ? inTok : 0);

    // Speed comes from the official sessionStats projection. Both operands are
    // guarded so an unfinished step yields null instead of Infinity or NaN.
    var decodeMs = stats !== null && typeof stats === 'object' ? Number(stats.decodeMs) : NaN;
    var decodeTokens = stats !== null && typeof stats === 'object' ? Number(stats.decodeTokens) : NaN;
    var ttftMs = stats !== null && typeof stats === 'object' ? Number(stats.ttftMs) : NaN;
    var ttftSteps = stats !== null && typeof stats === 'object' ? Number(stats.ttftSteps) : NaN;
    var llmMs = stats !== null && typeof stats === 'object' ? Number(stats.llmMs) : NaN;
    var toolMs = stats !== null && typeof stats === 'object' ? Number(stats.toolMs) : NaN;

    // Occupancy: pressureTokens is prompt-side, projectedTokens is the estimate
    // after the surface changes, and contextWindow is the route's capacity.
    var pressureTokens = pressure !== null && typeof pressure === 'object' ? Number(pressure.pressureTokens) : NaN;
    var contextWindow = pressure !== null && typeof pressure === 'object' ? Number(pressure.contextWindow) : NaN;
    var occupied = isFinite(pressureTokens) && isFinite(contextWindow) && contextWindow > 0
      ? pressureTokens / contextWindow : null;

    out.ok = true;
    out.input = isFinite(inTok) ? inTok : 0;
    out.output = isFinite(outTok) ? outTok : 0;
    out.cacheRead = isFinite(cacheR) ? cacheR : 0;
    out.cacheWrite = isFinite(cacheW) ? cacheW : 0;
    out.total = total;
    out.prompt = prompt;
    out.cacheHitRate = denominator > 0 ? (isFinite(cacheR) ? cacheR : 0) / denominator : null;
    out.tokensPerSecond = isFinite(decodeTokens) && decodeTokens > 0 && isFinite(decodeMs) && decodeMs > 0
      ? (decodeTokens / decodeMs) * 1000 : null;
    out.avgTtft = isFinite(ttftMs) && isFinite(ttftSteps) && ttftSteps > 0 ? ttftMs / ttftSteps : null;
    out.llmShare = isFinite(llmMs) && isFinite(toolMs) && (llmMs + toolMs) > 0 ? llmMs / (llmMs + toolMs) : null;
    out.occupied = occupied;
    out.contextWindow = isFinite(contextWindow) ? contextWindow : null;
    out.turns = stats !== null && typeof stats === 'object' ? Number(stats.turns) : null;
    out.steps = stats !== null && typeof stats === 'object' ? Number(stats.steps) : null;
    return out;
  }

  // ---------------------------------------------------------------- styles

  var CSS = [
    '.tsl-trigger{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 8px;flex:0 0 auto;min-width:28px;',
    'border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.1));border-radius:6px;',
    'background:var(--dsw-alias-button-elevated-fill,transparent);color:var(--dsw-alias-label-secondary,#c9c9c9);',
    'cursor:pointer;font:inherit;font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.tsl-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));',
    'color:var(--dsw-alias-label-primary,#ececec)}',
    '.tsl-panel{width:320px;padding:12px 14px;border-radius:10px;',
    'background:var(--dsw-alias-bg-overlay,#242424);color:var(--dsw-alias-label-primary,#ececec);',
    'border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.12));',
    'box-shadow:0 10px 30px rgba(0,0,0,.35);font-size:12px}',
    '.tsl-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 12px}',
    '.tsl-cell{display:flex;flex-direction:column;gap:2px}',
    '.tsl-cell-label{font-size:10px;color:var(--dsw-alias-label-tertiary,#9a9a9a)}',
    '.tsl-cell-value{font-size:15px;font-weight:600;font-variant-numeric:tabular-nums}',
    '.tsl-cell-sub{font-size:10px;color:var(--dsw-alias-label-tertiary,#9a9a9a)}',
    '.tsl-bar{height:4px;border-radius:2px;margin-top:4px;overflow:hidden;',
    'background:var(--dsw-alias-bg-base,rgba(255,255,255,.08))}',
    '.tsl-bar-fill{height:100%;background:var(--dsw-alias-accent,#4a9eff);border-radius:2px}',
    '.tsl-sep{height:1px;margin:10px 0;background:var(--dsw-alias-border-l3,rgba(255,255,255,.08))}',
    '.tsl-note{font-size:10px;color:var(--dsw-alias-label-tertiary,#9a9a9a);line-height:1.5}',
    '.tsl-btn{border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.12));border-radius:6px;',
    'background:transparent;color:var(--dsw-alias-label-secondary,#c9c9c9);padding:4px 10px;',
    'font:inherit;font-size:11px;cursor:pointer}',
    '.tsl-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}',
    '.tsl-modal-mask{position:fixed;inset:0;z-index:9995;display:flex;align-items:center;',
    'justify-content:center;background:var(--dsw-alias-bg-mask-base,rgba(0,0,0,.55))}',
    '.tsl-modal{width:min(860px,94vw);max-height:82vh;display:flex;flex-direction:column;',
    'border-radius:12px;background:var(--dsw-alias-bg-overlay,#242424);',
    'color:var(--dsw-alias-label-primary,#ececec);',
    'border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.12));overflow:hidden}',
    '.tsl-modal-head{display:flex;align-items:center;gap:8px;padding:12px 16px;flex:none;',
    'border-bottom:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.08))}',
    '.tsl-modal-title{font-size:14px;font-weight:600;flex:1}',
    '.tsl-modal-body{overflow:auto;padding:14px 16px;flex:1;min-height:0}',
    '.tsl-row{display:grid;gap:10px;align-items:center;padding:7px 0;font-size:12px;',
    'border-bottom:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.05))}',
    '.tsl-row-head{color:var(--dsw-alias-label-tertiary,#9a9a9a);font-size:11px}',
    '.tsl-num{text-align:right;font-variant-numeric:tabular-nums}',
    '.tsl-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.tsl-muted{color:var(--dsw-alias-label-tertiary,#9a9a9a);font-size:11px}',
    '.tsl-empty{text-align:center;color:var(--dsw-alias-label-tertiary,#9a9a9a);font-size:13px;padding:36px}',
    '.tsl-history-total{margin-bottom:12px;padding:8px 10px;border-radius:8px;',
    'background:var(--dsw-alias-bg-base,rgba(255,255,255,.04));color:var(--dsw-alias-label-secondary,#c9c9c9);',
    'font-size:12px;line-height:1.5}',
    '.tsl-history-total strong{color:var(--dsw-alias-label-primary,#ececec);font-size:15px;',
    'font-variant-numeric:tabular-nums}',
    '.tsl-panel,.tsl-modal{--tsl-accent:#2dd4bf;--tsl-accent-soft:rgba(45,212,191,.14);',
    '--tsl-amber:#f5b84b;--tsl-amber-soft:rgba(245,184,75,.14);--tsl-blue:#5aa9ff;',
    '--tsl-chart-cache:#38bdf8;--tsl-chart-input:#f59e0b;--tsl-chart-output:#8b5cf6}',
    '.tsl-modal{width:min(1040px,96vw);max-height:90vh;border-radius:14px;',
    'box-shadow:0 24px 70px rgba(0,0,0,.45)}',
    '.tsl-dash-head{display:flex;align-items:flex-start;gap:12px;padding:16px 18px 12px;',
    'border-bottom:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.08));flex:none}',
    '.tsl-dash-brand{display:flex;align-items:center;gap:10px;min-width:0}',
    '.tsl-dash-logo{width:34px;height:34px;border-radius:9px;display:flex;align-items:center;justify-content:center;',
    'background:var(--tsl-accent-soft);color:var(--tsl-accent);flex:none}',
    '.tsl-dash-title{font-size:17px;font-weight:650;letter-spacing:.1px}',
    '.tsl-dash-sub{font-size:11px;color:var(--dsw-alias-label-tertiary,#8f8f8f);margin-top:3px}',
    '.tsl-dash-status{margin-left:auto;display:flex;align-items:center;gap:8px;flex:none}',
    '.tsl-update-row{display:flex;align-items:center;gap:8px;padding:10px 18px;flex:none;font-size:12px}',
    '.tsl-update-row-footer{justify-content:flex-end;margin-top:2px;',
    'border-top:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.08))}',
    '.tsl-live-dot{width:7px;height:7px;border-radius:50%;background:var(--tsl-accent);',
    'box-shadow:0 0 0 3px var(--tsl-accent-soft)}',
    '.tsl-dash-meta{display:flex;flex-wrap:wrap;gap:6px 14px;padding:0 18px 12px;',
    'font-size:10px;color:var(--dsw-alias-label-tertiary,#8f8f8f)}',
    '.tsl-chip{display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border-radius:999px;',
    'border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.1));background:var(--dsw-alias-bg-base,rgba(255,255,255,.03))}',
    '.tsl-stat-row{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;padding:12px 18px;flex:none}',
    '.tsl-stat{padding:11px 12px;border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.09));',
    'border-radius:9px;background:var(--dsw-alias-bg-base,rgba(255,255,255,.025));min-width:0}',
    '.tsl-stat-label{font-size:10px;color:var(--dsw-alias-label-tertiary,#8f8f8f);display:flex;align-items:center;gap:6px}',
    '.tsl-stat-value{font-size:23px;font-weight:650;line-height:1.2;margin-top:4px;font-variant-numeric:tabular-nums;',
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.tsl-stat-sub{font-size:10px;color:var(--dsw-alias-label-tertiary,#8f8f8f);margin-top:3px;line-height:1.35}',
    '.tsl-stat-accent{color:var(--tsl-accent)}',
    '.tsl-stat-pill{font-size:9px;padding:1px 5px;border-radius:4px;background:var(--tsl-accent-soft);',
    'color:var(--tsl-accent);margin-left:auto;flex:none}',
    '.tsl-trend{padding:4px 18px 10px;flex:none}',
    '.tsl-trend-head{display:flex;align-items:center;justify-content:space-between;gap:10px;',
    'font-size:10px;color:var(--dsw-alias-label-tertiary,#8f8f8f);margin-bottom:6px}',
    '.tsl-trend-legend{display:flex;gap:12px;align-items:center}',
    '.tsl-legend-dot{width:6px;height:6px;border-radius:50%;display:inline-block;margin-right:4px}',
    '.tsl-trend-bars{height:96px;display:flex;align-items:flex-end;gap:5px;padding:6px 0 0;',
    'border-bottom:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.08))}',
    '.tsl-trend-col{flex:1;min-width:0;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:stretch;gap:4px}',
    '.tsl-trend-stack{width:100%;min-height:2px;border-radius:4px 4px 1px 1px;overflow:hidden;display:flex;flex-direction:column;',
    'background:var(--dsw-alias-bg-base,rgba(255,255,255,.04));transition:height .2s ease}',
    '.tsl-trend-seg{width:100%;min-height:0}',
    '.tsl-trend-seg-cache{background:var(--tsl-accent);opacity:.85}',
    '.tsl-trend-seg-input{background:var(--tsl-amber);opacity:.75}',
    '.tsl-trend-seg-output{background:var(--tsl-blue);opacity:.75}',
    '.tsl-trend-label{font-size:9px;color:var(--dsw-alias-label-tertiary,#8f8f8f);text-align:center;',
    'white-space:nowrap;overflow:hidden}',
    '.tsl-chart-stage{display:grid;grid-template-columns:42px 1fr;gap:6px;height:154px;margin-top:4px}',
    '.tsl-chart-y{display:flex;flex-direction:column;justify-content:space-between;padding:0 0 18px;',
    'font-size:9px;color:var(--dsw-alias-label-tertiary,#8f8f8f);text-align:right;font-variant-numeric:tabular-nums}',
    '.tsl-chart-plot{position:relative;min-width:0;height:100%;display:flex;flex-direction:column}',
    '.tsl-chart-svg{width:100%;height:136px;display:block;overflow:visible}',
    '.tsl-chart-bars{height:136px;display:flex;align-items:flex-end;gap:5px;padding:5px 0 0;',
    'border-bottom:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.08))}',
    '.tsl-chart-col{flex:1;min-width:0;height:100%;display:flex;flex-direction:column;justify-content:flex-end;',
    'align-items:stretch;gap:3px;cursor:pointer}',
    '.tsl-chart-stack{width:100%;min-height:2px;border-radius:4px 4px 1px 1px;overflow:hidden;display:flex;',
    'flex-direction:column;background:var(--dsw-alias-bg-base,rgba(255,255,255,.04));transition:height .2s ease}',
    '.tsl-chart-legend{display:flex;align-items:center;gap:8px;margin:1px 0 3px;',
    'font-size:9px;color:var(--dsw-alias-label-tertiary,#8f8f8f);white-space:nowrap}',
    '.tsl-chart-legend .tsl-legend-dot{width:5px;height:5px;margin-right:3px}',
    '.tsl-chart-seg{width:100%;min-height:2px}',
    '.tsl-chart-seg-cache{background:var(--tsl-chart-cache)}',
    '.tsl-chart-seg-input{background:var(--tsl-chart-input)}',
    '.tsl-chart-seg-output{background:var(--tsl-chart-output)}',
    '.tsl-chart-x{display:flex;gap:5px;padding-top:5px;height:18px}',
    '.tsl-chart-x span{flex:1;min-width:0;text-align:center;font-size:9px;color:var(--dsw-alias-label-tertiary,#8f8f8f);',
    'white-space:nowrap;overflow:hidden}',
    '.tsl-chart-tip{position:absolute;top:2px;z-index:8;width:238px;padding:10px 12px;border-radius:10px;',
    'background:var(--dsw-alias-bg-overlay,#fff);border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.1));',
    'box-shadow:0 12px 34px rgba(0,0,0,.18);font-size:11px;pointer-events:none;transform:translateX(-50%);',
    'transition:left .06s linear}',
    '.tsl-chart-tip-head{display:flex;align-items:baseline;justify-content:space-between;gap:16px;',
    'margin-bottom:5px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#1f1f1f)}',
    '.tsl-chart-tip-row{display:flex;align-items:center;gap:7px;line-height:1.75;',
    'color:var(--dsw-alias-label-secondary,#555)}',
    '.tsl-chart-tip-row b{margin-left:auto;font-weight:500;color:var(--dsw-alias-label-primary,#1f1f1f);',
    'font-variant-numeric:tabular-nums}',
    '.tsl-chart-swatch{width:9px;height:9px;border-radius:2px;flex:none}',
    '.tsl-chart-tip-note{font-size:9px;color:var(--dsw-alias-label-tertiary,#8f8f8f);margin-top:3px}',
    '.tsl-toolbar{display:flex;align-items:center;gap:8px;padding:4px 18px 10px;flex:none;flex-wrap:wrap}',
    '.tsl-tab-group{display:flex;gap:4px;padding:3px;border-radius:8px;',
    'background:var(--dsw-alias-bg-base,rgba(255,255,255,.04));border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.07))}',
    '.tsl-tab{border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#bdbdbd);',
    'font:inherit;font-size:11px;padding:5px 11px;cursor:pointer}',
    '.tsl-tab-active{background:var(--tsl-accent-soft);color:var(--tsl-accent);font-weight:600}',
    '.tsl-filter{flex:1;min-width:160px;height:28px;border-radius:7px;padding:0 10px;',
    'border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.1));',
    'background:var(--dsw-alias-bg-base,rgba(255,255,255,.03));color:var(--dsw-alias-label-primary,#ececec);',
    'font:inherit;font-size:11px;outline:none}',
    '.tsl-filter:focus{border-color:var(--tsl-accent)}',
    '.tsl-table-wrap{flex:1;min-height:180px;overflow:auto;padding:0 18px 6px}',
    '.tsl-table{width:100%;border-collapse:collapse;font-size:11px;font-variant-numeric:tabular-nums}',
    '.tsl-table th{position:sticky;top:0;z-index:1;text-align:left;font-weight:500;font-size:10px;',
    'color:var(--dsw-alias-label-tertiary,#8f8f8f);padding:7px 8px;',
    'background:var(--dsw-alias-bg-overlay,#242424);border-bottom:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.1));',
    'white-space:nowrap}',
    '.tsl-table td{padding:8px;border-bottom:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.055));',
    'vertical-align:middle;color:var(--dsw-alias-label-secondary,#d0d0d0)}',
    '.tsl-table tbody tr:hover td{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.04))}',
    '.tsl-table .tsl-today{color:var(--tsl-accent);font-weight:600}',
    '.tsl-table .tsl-r{text-align:right}',
    '.tsl-table .tsl-bar-cell{min-width:120px}',
    '.tsl-mini-bar{height:4px;border-radius:2px;background:var(--dsw-alias-bg-base,rgba(255,255,255,.07));overflow:hidden}',
    '.tsl-mini-fill{height:100%;border-radius:2px;background:var(--tsl-accent)}',
    '.tsl-pill{display:inline-block;min-width:42px;text-align:center;padding:2px 5px;border-radius:4px;',
    'font-size:10px;background:var(--tsl-accent-soft);color:var(--tsl-accent)}',
    '.tsl-pill-warn{background:var(--tsl-amber-soft);color:var(--tsl-amber)}',
    '.tsl-dash-foot{display:flex;align-items:center;gap:12px;padding:8px 18px;flex:none;',
    'font-size:10px;color:var(--dsw-alias-label-tertiary,#8f8f8f);border-top:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.07))}',
    '.tsl-dash-foot code{font-size:10px;color:var(--dsw-alias-label-secondary,#bdbdbd);',
    'background:var(--dsw-alias-bg-base,rgba(255,255,255,.04));padding:2px 5px;border-radius:4px}',
    '.tsl-dash-actions{margin-left:auto;display:flex;gap:6px;flex:none}',
    '.tsl-icon-btn{width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;',
    'padding:0;border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.12));border-radius:6px;',
    'background:transparent;color:var(--dsw-alias-label-secondary,#bdbdbd);font:inherit;font-size:17px;',
    'line-height:1;cursor:pointer}',
    '.tsl-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));',
    'color:var(--dsw-alias-label-primary,#ececec)}',
    '.tsl-live-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}',
    '.tsl-live-total{font-size:27px;font-weight:650;line-height:1.1;font-variant-numeric:tabular-nums;',
    'letter-spacing:-.3px}',
    '.tsl-live-total small{font-size:10px;font-weight:400;color:var(--dsw-alias-label-tertiary,#8f8f8f);margin-left:6px;letter-spacing:0}',
    '.tsl-live-sub{font-size:10px;color:var(--dsw-alias-label-tertiary,#8f8f8f);margin:3px 0 8px}',
    '.tsl-composition{display:flex;height:5px;border-radius:3px;overflow:hidden;margin:8px 0 10px;',
    'background:var(--dsw-alias-bg-base,rgba(255,255,255,.08))}',
    '.tsl-composition span{height:100%;min-width:0}',
    '.tsl-composition-cache{background:var(--tsl-accent)}',
    '.tsl-composition-input{background:var(--tsl-amber)}',
    '.tsl-composition-output{background:var(--tsl-blue)}',
    '.tsl-legend{font-size:9px;color:var(--dsw-alias-label-tertiary,#8f8f8f);display:flex;gap:10px;margin-bottom:6px}',
    // Unified typography: 12px body / 14px section / 20px title, darker text tokens.
    '.tsl-panel,.tsl-modal{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei","PingFang SC","Noto Sans CJK SC",sans-serif;',
    'font-size:12px;color:var(--dsw-alias-label-primary,#111827);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}',
    '.tsl-cell-label,.tsl-cell-sub,.tsl-note,.tsl-muted,.tsl-empty,.tsl-dash-sub,.tsl-dash-meta,',
    '.tsl-stat-label,.tsl-stat-sub,.tsl-chart-legend,.tsl-chart-y,.tsl-chart-x,',
    '.tsl-chart-tip-row,.tsl-chart-tip-note,.tsl-dash-foot,.tsl-live-sub,.tsl-legend{',
    'font-size:12px;color:var(--dsw-alias-label-secondary,#4b5563)}',
    '.tsl-cell-value{font-size:16px;color:var(--dsw-alias-label-primary,#111827)}',
    '.tsl-dash-title{font-size:20px;font-weight:650;color:var(--dsw-alias-label-primary,#111827)}',
    '.tsl-stat-value{font-size:24px;font-weight:650;color:var(--dsw-alias-label-primary,#111827)}',
    '.tsl-stat-pill,.tsl-pill,.tsl-chip,.tsl-btn,.tsl-filter{font-size:12px}',
    '.tsl-tab{font-size:12px;color:var(--dsw-alias-label-secondary,#4b5563)}',
    '.tsl-live-head span{font-size:12px}',
    '.tsl-live-total small{font-size:12px}',
    '.tsl-table{font-size:12px}',
    '.tsl-table th{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#4b5563)}',
    '.tsl-table td{font-size:12px;color:var(--dsw-alias-label-primary,#27303f)}',
    '.tsl-chart-tip{font-size:12px;color:var(--dsw-alias-label-primary,#1f2937)}',
    '.tsl-chart-tip-head{font-size:14px;color:var(--dsw-alias-label-primary,#111827)}',
    '.tsl-trend-head{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2937)}',
    '.tsl-chart-legend{gap:6px}',
    '.tsl-chart-legend .tsl-legend-dot{width:4px;height:4px}',
    '.tsl-chart-stage{height:174px}',
    '.tsl-chart-y{padding-bottom:22px}',
    '.tsl-chart-svg,.tsl-chart-bars{height:152px}',
    '.tsl-chart-x{height:22px}',
    '.tsl-chart-x-api{gap:0}',
    '.tsl-chart-x span{font-size:12px;color:var(--dsw-alias-label-secondary,#4b5563)}',
    '.tsl-chart-dots{position:absolute;left:0;right:0;top:0;height:152px;pointer-events:none}',
    '.tsl-chart-dot{position:absolute;width:5px;height:5px;box-sizing:border-box;border:1px solid #3b82f6;',
    'border-radius:50%;background:var(--dsw-alias-bg-overlay,#fff);transform:translate(-50%,-50%)}',
    '.tsl-dash-foot code{font-size:12px;color:var(--dsw-alias-label-secondary,#4b5563)}',
    '.tsl-tab-active{color:var(--tsl-accent)}',
    '.tsl-btn{color:var(--dsw-alias-label-secondary,#4b5563)}',
    '.tsl-cost-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-height:18px}',
    '.tsl-cost-switch{display:inline-flex;gap:2px;margin-left:auto;padding:2px;border-radius:5px;',
    'background:var(--dsw-alias-bg-base,rgba(255,255,255,.05))}',
    '.tsl-cost-tab{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#4b5563);',
    'font:inherit;font-size:12px;line-height:1.4;padding:2px 5px;border-radius:4px;cursor:pointer}',
    '.tsl-cost-tab-active{background:var(--tsl-accent-soft);color:var(--tsl-accent);font-weight:600}',
    '.tsl-price-refresh{width:22px;height:22px;padding:0;border:0;border-radius:5px;background:transparent;',
    'color:var(--dsw-alias-label-secondary,#4b5563);display:inline-flex;align-items:center;justify-content:center;',
    'cursor:pointer;flex:none}',
    '.tsl-price-refresh:hover{background:var(--dsw-alias-bg-base,rgba(0,0,0,.05));color:var(--tsl-accent)}',
    '.tsl-price-refresh-partial{color:#b45309}',
    '.tsl-price-refresh:disabled{cursor:wait;opacity:.65}',
    '.tsl-price-refresh-loading svg{animation:tsl-spin .9s linear infinite}',
    '@keyframes tsl-spin{to{transform:rotate(360deg)}}',
    // Align eyebrow labels and their pills/buttons to the same top edge. A
    // two-line label (e.g. 累计费用) must not push its badge downward.
    '.tsl-stat-label{display:flex;align-items:center;gap:6px;height:34px;min-height:34px;line-height:1.4}',
    '.tsl-stat-label .tsl-stat-pill{align-self:center;margin-left:auto;white-space:nowrap}',
    '.tsl-stat-pill{height:22px;display:inline-flex;align-items:center;padding:0 6px;line-height:1}',
    '.tsl-cost-head{align-items:center;height:34px;min-height:34px}',
    '.tsl-cost-switch{align-self:center;margin-top:0;height:22px;padding:0 2px;align-items:center}',
    '.tsl-cost-tab{height:22px;display:inline-flex;align-items:center;padding:0 5px;line-height:1}',
    '.tsl-stat-value{line-height:1.2}',
  ].join('');

  function MeterIcon(props) {
    var size = (props && props.size) || 14;
    return h('svg', {
      width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': 'true',
    }, h('path', { d: 'M1.8 11.8 L5 7.2 L7.6 9.8 L11 3.9 L14.2 8.6' }), h('path', { d: 'M1.8 14.2h12.4' }));
  }

  function Cell(props) {
    return h('div', { className: 'tsl-cell' },
      h('div', { className: 'tsl-cell-label' }, props.label),
      h('div', { className: 'tsl-cell-value' }, props.value),
      props.sub ? h('div', { className: 'tsl-cell-sub' }, props.sub) : null,
      props.ratio !== undefined && props.ratio !== null
        ? h('div', { className: 'tsl-bar' },
          h('div', { className: 'tsl-bar-fill', style: { width: Math.max(0, Math.min(100, props.ratio * 100)) + '%' } }))
        : null);
  }

  // ---------------------------------------------------------------- live panel

  function LivePanel(props) {
    var live = readLive(props.useProjection);
    var setShowHistory = props.setShowHistory;
    var history = props.history;

    if (!live.ok) {
      return h('div', { className: 'tsl-panel' },
        h('div', { className: 'tsl-note' },
          live.reason === 'no-hook'
            ? '本插槽未提供 useProjection（需要 session 作用域）。'
            : '本会话还没有用量数据。'));
    }

    var total = Math.max(0, live.total || 0);
    var cacheShare = total > 0 ? live.cacheRead / total : 0;
    var inputShare = total > 0 ? live.input / total : 0;
    var outputShare = total > 0 ? live.output / total : 0;

    return h('div', { className: 'tsl-panel' },
      h('div', { className: 'tsl-live-head' },
        h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary,#4b5563)' } }, '本会话 Token'),
        h('span', {
          style: { marginLeft: 'auto', fontSize: '12px', color: 'var(--tsl-accent)', display: 'inline-flex', alignItems: 'center', gap: '4px' },
        }, h('span', { className: 'tsl-live-dot', style: { width: '6px', height: '6px', boxShadow: 'none' } }), '实时')),
      h('div', { className: 'tsl-live-total' }, tokens(total), h('small', null, 'tokens')),
      h('div', { className: 'tsl-live-sub' },
        '缓存读 ' + tokens(live.cacheRead) + ' · 输入 ' + tokens(live.input) + ' · 输出 ' + tokens(live.output)),
      h('div', { className: 'tsl-composition' },
        h('span', { className: 'tsl-composition-cache', style: { width: Math.max(0, cacheShare * 100) + '%' } }),
        h('span', { className: 'tsl-composition-input', style: { width: Math.max(0, inputShare * 100) + '%' } }),
        h('span', { className: 'tsl-composition-output', style: { width: Math.max(0, outputShare * 100) + '%' } })),
      h('div', { className: 'tsl-legend' },
        h('span', null, h('span', { className: 'tsl-legend-dot', style: { background: 'var(--tsl-accent)' } }), '缓存读 ' + percent(cacheShare)),
        h('span', null, h('span', { className: 'tsl-legend-dot', style: { background: 'var(--tsl-amber)' } }), '输入 ' + percent(inputShare)),
        h('span', null, h('span', { className: 'tsl-legend-dot', style: { background: 'var(--tsl-blue)' } }), '输出 ' + percent(outputShare))),
      h('div', { className: 'tsl-grid' },
        h(Cell, {
          label: '缓存命中率',
          value: percent(live.cacheHitRate),
          sub: '提示词 ' + tokens(live.prompt),
        }),
        h(Cell, {
          label: '输出速度',
          value: rate(live.tokensPerSecond),
          sub: '首字 ' + ms(live.avgTtft) + ' · 模型占比 ' + percent(live.llmShare),
        }),
        h(Cell, {
          label: '上下文占用',
          value: percent(live.occupied),
          sub: live.contextWindow ? '上限 ' + tokens(live.contextWindow) : '容量未知',
          ratio: live.occupied,
        }),
        h(Cell, {
          label: '轮次 / 步数',
          value: (live.turns !== null ? live.turns : '--') + ' / ' + (live.steps !== null ? live.steps : '--'),
          sub: '缓存写 ' + tokens(live.cacheWrite),
        })),
      h('div', { className: 'tsl-sep' }),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
        h('span', { className: 'tsl-note', style: { flex: 1 } },
          history && history.status === 'live'
            ? '历史累计 ' + tokens(history.value.global.totalTokens) + ' · ' + history.value.global.sessions + ' 个会话'
            : (history && history.status === 'loading'
              ? '历史加载中…'
              : (history && history.status === 'failed'
                ? '历史不可用(' + ((history.failure && (history.failure.code || history.failure.message)) || 'unknown') + ')'
                : '历史不可用'))),
        h('button', {
          type: 'button', className: 'tsl-btn', onClick: function () { setShowHistory(true); },
        }, '历史累计')));
  }

  // ---------------------------------------------------------------- history
  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function todayKey(tzOffsetMinutes) {
    var offset = typeof tzOffsetMinutes === 'number' && isFinite(tzOffsetMinutes) ? tzOffsetMinutes : 480;
    return new Date(Date.now() + offset * 60000).toISOString().slice(0, 10);
  }

  function shortPath(path) {
    if (!path) return '';
    return String(path).replace(/^[A-Za-z]:\\Users\\[^\\]+/, '~').replace(/\\/g, '/');
  }

  function shareOf(part, total) {
    if (typeof part !== 'number' || !isFinite(part)) return null;
    if (typeof total !== 'number' || !isFinite(total) || total <= 0) return null;
    return part / total;
  }

  function creditsText(value) {
    if (value === null || value === undefined) return '--';
    if (typeof value !== 'number' || !isFinite(value)) return '--';
    if (value < 1) return value.toFixed(3) + ' credits';
    if (value < 10) return value.toFixed(2) + ' credits';
    return Math.round(value).toLocaleString() + ' credits';
  }

  function moneyText(value, symbol) {
    if (value === null || value === undefined) return '--';
    if (typeof value !== 'number' || !isFinite(value)) return '--';
    if (value < 1000) return symbol + value.toFixed(2);
    return symbol + Math.round(value).toLocaleString();
  }

  // DeepSeek official peak list prices (USD / 1M tokens), same table as Host.
  var OFFICIAL_RATES = {
    'deepseek-v4.1-flash': { cacheRead: 0.006, input: 0.30, output: 1.20 },
    'deepseek-flash': { cacheRead: 0.006, input: 0.30, output: 1.20 },
    'deepseek-v4-pro': { cacheRead: 0.044, input: 1.32, output: 3.96 },
  };
  // Zhipu official list prices (CNY / 1M tokens); converted with the FX rate.
  var OFFICIAL_CNY_RATES = {
    'glm-5.3-flash': { cacheRead: 0.23, input: 0.80, output: 2.80 },
    'glm-5.3': { cacheRead: 2.00, input: 8.00, output: 28.00 },
  };

  function officialCostOf(routes, totalTokens, usdToCny) {
    var usd = 0;
    var covered = 0;
    var fx = Number(usdToCny) > 0 ? Number(usdToCny) : 7.2;
    for (var i = 0; i < routes.length; i += 1) {
      var route = routes[i];
      var model = typeof route.route === 'string' ? route.route.split(':').pop() : '';
      var rate = OFFICIAL_RATES[model];
      if (rate === undefined) {
        var cnyRate = OFFICIAL_CNY_RATES[model];
        if (cnyRate === undefined) continue;
        rate = {
          cacheRead: cnyRate.cacheRead / fx,
          input: cnyRate.input / fx,
          output: cnyRate.output / fx,
        };
      }
      var cacheRead = Number(route.cacheReadTokens) || 0;
      var input = (Number(route.uncachedInputTokens) || 0) + (Number(route.cacheWriteTokens) || 0);
      var output = Number(route.outputTokens) || 0;
      usd += (cacheRead / 1e6) * rate.cacheRead
        + (input / 1e6) * rate.input
        + (output / 1e6) * rate.output;
      covered += Number(route.totalTokens) || 0;
    }
    return {
      configured: covered > 0,
      currency: 'USD',
      tier: 'peak',
      usd,
      cny: usd * fx,
      usdToCny: fx,
      coveredTokens: covered,
      totalTokens,
      coverage: totalTokens > 0 ? covered / totalTokens : null,
    };
  }

  function StatCard(props) {
    return h('div', { className: 'tsl-stat' },
      h('div', { className: 'tsl-stat-label' }, props.label,
        props.pill ? h('span', { className: 'tsl-stat-pill' }, props.pill) : null),
      h('div', { className: 'tsl-stat-value' + (props.accent ? ' tsl-stat-accent' : '') }, props.value),
      h('div', { className: 'tsl-stat-sub' }, props.sub));
  }

  /**
   * Chart-local state is deliberately isolated here. Hovering a bar used to
   * re-render the whole modal (including the history table), which made the
   * tooltip visibly lag; only this small chart now re-renders.
   */
  function TrendChart(props) {
    var trend = props.trend || [];
    var tzLabel = props.tzLabel || 'UTC+8';
    var modeState = useState('tokens');
    var mode = modeState[0];
    var setMode = modeState[1];
    var hoverState = useState(null);
    var hoverIndex = hoverState[0];
    var setHoverIndex = hoverState[1];
    var maxDay = 0;
    var maxRequests = 0;
    trend.forEach(function (d) {
      if (Number(d.totalTokens) > maxDay) maxDay = Number(d.totalTokens);
      if (Number(d.requests) > maxRequests) maxRequests = Number(d.requests);
    });
    var hoverDay = hoverIndex !== null && hoverIndex >= 0 ? trend[hoverIndex] : null;

    function setChartMode(next) {
      setMode(next);
      setHoverIndex(null);
    }

    if (trend.length === 0) {
      return h('div', { className: 'tsl-trend' },
        h('div', { className: 'tsl-empty', style: { padding: '18px' } }, '还没有按天数据'));
    }

    return h('div', { className: 'tsl-trend' },
      h('div', { className: 'tsl-trend-head' },
        h('span', null, '最近 ' + trend.length + ' 天 '
          + (mode === 'requests' ? 'API 请求次数' : 'Token 构成') + '（' + tzLabel + '）'),
        h('div', { className: 'tsl-tab-group' },
          h('button', {
            type: 'button', className: 'tsl-tab' + (mode === 'requests' ? ' tsl-tab-active' : ''),
            onClick: function () { setChartMode('requests'); },
          }, 'API 请求次数'),
          h('button', {
            type: 'button', className: 'tsl-tab' + (mode === 'tokens' ? ' tsl-tab-active' : ''),
            onClick: function () { setChartMode('tokens'); },
          }, 'Tokens'))),
      h('div', { className: 'tsl-chart-legend' },
        mode === 'requests'
          ? h('span', null, h('span', { className: 'tsl-legend-dot', style: { background: 'var(--tsl-chart-cache)' } }), '请求次数')
          : [
            h('span', { key: 'cache' }, h('span', { className: 'tsl-legend-dot', style: { background: 'var(--tsl-chart-cache)' } }), '命中缓存'),
            h('span', { key: 'input' }, h('span', { className: 'tsl-legend-dot', style: { background: 'var(--tsl-chart-input)' } }), '未命中缓存'),
            h('span', { key: 'output' }, h('span', { className: 'tsl-legend-dot', style: { background: 'var(--tsl-chart-output)' } }), '输出'),
          ]),
      h('div', { className: 'tsl-chart-stage' },
        h('div', { className: 'tsl-chart-y' },
          h('span', null, mode === 'requests' ? tokens(maxRequests) : tokens(maxDay)),
          h('span', null, tokens((mode === 'requests' ? maxRequests : maxDay) / 2)),
          h('span', null, '0')),
        h('div', { className: 'tsl-chart-plot', onMouseLeave: function () { setHoverIndex(null); } },
          mode === 'requests'
            ? (function () {
              var W = 640;
              var H = 120;
              var rawValues = trend.map(function (d) { return Number(d.requests) || 0; });
              var values = rawValues.map(function (value, index) {
                var prev = rawValues[index - 1] === undefined ? value : rawValues[index - 1];
                var next = rawValues[index + 1] === undefined ? value : rawValues[index + 1];
                return (prev + value * 2 + next) / 4;
              });
              var points = trend.map(function (d, i) {
                // Tick-centered x: the x labels are equal flex cells, so their
                // centers are (i + 0.5) / n, not the old endpoint interpolation.
                var x = ((i + 0.5) / trend.length) * W;
                var y = H - values[i] / (maxRequests || 1) * H;
                return { x: x, y: y };
              });
              // Catmull-Rom -> cubic Bezier keeps the peak readable without the
              // hard polyline corners of the previous chart. The first/last
              // segments run flat to the plot edge so the area has no triangular
              // wedge or last-second vertical drop.
              var curve = '';
              for (var i = 1; i < points.length; i += 1) {
                var p0 = points[i - 2] || points[i - 1];
                var p1 = points[i - 1];
                var p2 = points[i];
                var p3 = points[i + 1] || p2;
                var tension = 0.18;
                var c1x = p1.x + (p2.x - p0.x) * tension;
                var c1y = Math.max(0, Math.min(H, p1.y + (p2.y - p0.y) * tension));
                var c2x = p2.x - (p3.x - p1.x) * tension;
                var c2y = Math.max(0, Math.min(H, p2.y - (p3.y - p1.y) * tension));
                curve += ' C' + c1x + ' ' + c1y + ', ' + c2x + ' ' + c2y + ', ' + p2.x + ' ' + p2.y;
              }
              var firstY = points[0].y;
              var lastY = points[points.length - 1].y;
              var line = 'M0 ' + firstY
                + ' L' + points[0].x + ' ' + firstY
                + curve
                + ' L' + W + ' ' + lastY;
              var area = 'M0 ' + H
                + ' L0 ' + firstY
                + ' L' + points[0].x + ' ' + firstY
                + curve
                + ' L' + W + ' ' + lastY
                + ' L' + W + ' ' + H
                + ' Z';
              return h(React.Fragment, null,
                h('svg', {
                  className: 'tsl-chart-svg', viewBox: '0 0 ' + W + ' ' + H,
                  preserveAspectRatio: 'none', role: 'img', 'aria-label': 'API 请求次数按天趋势',
                },
                h('line', { x1: 0, y1: H / 2, x2: W, y2: H / 2, stroke: 'currentColor', strokeOpacity: .12, strokeDasharray: '3 4' }),
                h('line', { x1: 0, y1: H, x2: W, y2: H, stroke: 'currentColor', strokeOpacity: .12 }),
                h('path', { d: area, fill: '#8ecdfa', fillOpacity: .42 }),
                h('path', { d: line, fill: 'none', stroke: '#3b82f6', strokeWidth: 2, strokeLinejoin: 'round', strokeLinecap: 'round' }),
                points.map(function (p, i) {
                  return h('rect', {
                    key: trend[i].day, x: p.x - (W / Math.max(1, trend.length)) / 2, y: 0,
                    width: Math.max(8, W / Math.max(1, trend.length)), height: H, fill: 'transparent',
                    onMouseEnter: function () { setHoverIndex(i); },
                  });
                })),
                h('div', { className: 'tsl-chart-dots', 'aria-hidden': 'true' },
                  points.map(function (p, i) {
                    return h('span', {
                      key: 'dot-' + trend[i].day,
                      className: 'tsl-chart-dot',
                      style: {
                        left: (p.x / W) * 100 + '%',
                        top: (p.y / H) * 100 + '%',
                      },
                    });
                  })));
            })()
            : h('div', { className: 'tsl-chart-bars' },
              trend.map(function (d, i) {
                var dayTotal = Number(d.totalTokens) || 0;
                var height = maxDay > 0 ? Math.max(2, (dayTotal / maxDay) * 100) : 2;
                var cache = shareOf(Number(d.cacheReadTokens), dayTotal) || 0;
                var input = shareOf(Number(d.uncachedInputTokens), dayTotal) || 0;
                var output = shareOf(Number(d.outputTokens), dayTotal) || 0;
                return h('div', {
                  className: 'tsl-chart-col', key: d.day,
                  'aria-label': d.day + ' · ' + tokens(dayTotal),
                  onMouseEnter: function () { setHoverIndex(i); },
                },
                h('div', { className: 'tsl-chart-stack', style: { height: height + '%' } },
                  h('div', { className: 'tsl-chart-seg tsl-chart-seg-cache', style: { flex: cache } }),
                  h('div', { className: 'tsl-chart-seg tsl-chart-seg-input', style: { flex: input } }),
                  h('div', { className: 'tsl-chart-seg tsl-chart-seg-output', style: { flex: output } })));
              })),
          h('div', { className: 'tsl-chart-x' + (mode === 'requests' ? ' tsl-chart-x-api' : '') }, trend.map(function (d) {
            return h('span', { key: d.day }, d.day.slice(5));
          })),
          hoverDay
            ? h('div', {
              className: 'tsl-chart-tip',
              style: { left: Math.max(14, Math.min(86, ((hoverIndex + 0.5) / Math.max(1, trend.length)) * 100)) + '%' },
            },
            h('div', { className: 'tsl-chart-tip-head' },
              h('span', null, hoverDay.day),
              h('span', null, Number(hoverDay.totalTokens || 0).toLocaleString())),
            mode === 'requests'
              ? h('div', { className: 'tsl-chart-tip-row', key: 'requests' },
                h('span', { className: 'tsl-chart-swatch', style: { background: 'var(--tsl-chart-input)' } }),
                h('span', null, 'API 请求次数'),
                h('b', null, Number(hoverDay.requests || 0).toLocaleString()))
              : [
                h('div', { className: 'tsl-chart-tip-row', key: 'cache' },
                  h('span', { className: 'tsl-chart-swatch', style: { background: 'var(--tsl-chart-cache)' } }),
                  h('span', null, '输入（命中缓存）'),
                  h('b', null, Number(hoverDay.cacheReadTokens || 0).toLocaleString())),
                h('div', { className: 'tsl-chart-tip-row', key: 'input' },
                  h('span', { className: 'tsl-chart-swatch', style: { background: 'var(--tsl-chart-input)' } }),
                  h('span', null, '输入（未命中缓存）'),
                  h('b', null, Number(hoverDay.uncachedInputTokens || 0).toLocaleString())),
                h('div', { className: 'tsl-chart-tip-row', key: 'output' },
                  h('span', { className: 'tsl-chart-swatch', style: { background: 'var(--tsl-chart-output)' } }),
                  h('span', null, '输出'),
                  h('b', null, Number(hoverDay.outputTokens || 0).toLocaleString())),
              ])
            : null)));
  }

  function HistoryModal(props) {
    var resource = props.resource;
    var close = props.close;
    var tab = props.tab;
    var setTab = props.setTab;
    var queryState = useState('');
    var query = queryState[0];
    var setQuery = queryState[1];
    var costModeState = useState('workbuddy');
    var costMode = costModeState[0];
    var setCostMode = costModeState[1];
    var updateState = useState(null);
    var update = updateState[0];
    var setUpdate = updateState[1];
    var priceRefreshState = useState({ status: 'idle', message: '' });
    var priceRefresh = priceRefreshState[0];
    var setPriceRefresh = priceRefreshState[1];

    /** Refresh FX, official model prices, and WorkBuddy credit rates. */
    function refreshPrices() {
      setPriceRefresh({ status: 'loading', message: '' });
      fetch('/dsh-token-usage/api/refresh-prices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', accept: 'application/json' },
        body: '{}',
      }).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (body) {
          if (!response.ok) throw new Error((body && body.error) || ('HTTP ' + response.status));
          var warnings = Array.isArray(body && body.warnings) ? body.warnings : [];
          if (body && body.ok === false) {
            var detail = warnings.length > 0 ? warnings.join('；') : '';
            setPriceRefresh({
              status: 'error',
              message: detail ? '刷新失败，保留旧价格：' + detail : '刷新失败，保留旧价格',
            });
            return;
          }
          var partial = body && (body.partial === true || warnings.length > 0);
          setPriceRefresh({
            status: partial ? 'partial' : 'ok',
            message: warnings.length > 0 ? warnings.join('；') : '汇率与模型价格已刷新',
          });
          setTimeout(function () { setPriceRefresh({ status: 'idle', message: '' }); }, 4000);
        });
      }).catch(function (error) {
        setPriceRefresh({ status: 'error', message: String((error && error.message) || error) });
      });
    }

    /** Call the host update route and parse its JSON answer. */
    function requestUpdate(method) {
      return fetch('/dsh-token-usage/api/update', {
        method: method,
        headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
        body: method === 'POST' ? '{}' : undefined,
      }).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (body) {
          if (!response.ok) throw new Error((body && body.error) || ('HTTP ' + response.status));
          return body;
        });
      });
    }

    function checkUpdate() {
      setUpdate({ status: 'checking' });
      requestUpdate('GET').then(function (body) {
        if (body && body.ok === false) { setUpdate({ status: 'error', message: body.error || '未知错误' }); return; }
        setUpdate(body && body.newer ? { status: 'available', info: body } : { status: 'latest', info: body });
      }).catch(function (error) {
        setUpdate({ status: 'error', message: String((error && error.message) || error) });
      });
    }

    function installUpdate() {
      setUpdate({ status: 'applying' });
      requestUpdate('POST').then(function (body) {
        if (!body || body.ok === false) { setUpdate({ status: 'error', message: (body && body.error) || '更新失败' }); return; }
        setUpdate({ status: body.applied ? 'done' : 'latest', info: body });
      }).catch(function (error) {
        setUpdate({ status: 'error', message: String((error && error.message) || error) });
      });
    }

    /** One line describing the current update state. */
    function updateText() {
      if (!update) return '版本 ' + ((meta && meta.version) || '');
      switch (update.status) {
        case 'checking': return '正在检查 GitHub 最新版本…';
        case 'applying': return '正在下载并安装更新…';
        case 'latest': return '已是最新版本 v' + ((update.info && update.info.latest) || '');
        case 'available': return '发现新版本 v' + ((update.info && update.info.latest) || '')
          + '（当前 v' + ((update.info && update.info.current) || '') + '）';
        case 'done': return '已更新到 v' + ((update.info && update.info.to) || '')
          + '，重启 DSH 生效（旧文件已备份）';
        case 'error': return '检查/更新失败：' + update.message;
        default: return '';
      }
    }
    var data = resource && resource.status === 'live' ? resource.value : null;
    var global = data && data.global ? data.global : {};
    var meta = data && data.meta ? data.meta : {};
    var costs = meta.costs;
    var workbuddyCost = costs && costs.workbuddy ? costs.workbuddy : (costs || {});
    var officialCost = costs && costs.official && costs.official.configured
      ? costs.official
      : officialCostOf(asArray(data && data.routes), Number(global.totalTokens) || 0,
        (costs && costs.official && costs.official.usdToCny) || 7.2);
    var workbuddyConfigured = workbuddyCost.configured === true;
    var officialConfigured = officialCost.configured === true;
    var costValue;
    var costSub;
    if (costMode === 'cny') {
      costValue = officialConfigured ? moneyText(officialCost.cny, '¥') : '--';
      costSub = officialConfigured
        ? '官方公开价 · 覆盖 ' + percent(officialCost.coverage)
          + ' · 汇率 ' + (officialCost.usdToCny || '--')
          + (officialCost.usdToCnyLive ? '（实时）' : (officialCost.usdToCnySource === 'last' ? '（上次）' : '（固定）'))
        : '官方价未覆盖当前模型';
    } else if (costMode === 'usd') {
      costValue = officialConfigured ? moneyText(officialCost.usd, '$') : '--';
      costSub = officialConfigured
        ? '官方公开价 · 覆盖 ' + percent(officialCost.coverage)
        : '官方价未覆盖当前模型';
    } else {
      costValue = workbuddyConfigured ? creditsText(workbuddyCost.credits) : '--';
      costSub = workbuddyConfigured
        ? 'WorkBuddy 实测 · 覆盖 ' + percent(workbuddyCost.coverage)
        : '未加载 WorkBuddy state.json';
    }
    if (priceRefresh.status === 'loading') costSub += ' · 刷新中…';
    else if (priceRefresh.status === 'partial') costSub += ' · 已刷新（部分）';
    else if (priceRefresh.status === 'ok') costSub += ' · 已刷新';
    else if (priceRefresh.status === 'error') costSub += ' · 刷新失败';
    var tzOffset = typeof meta.tzOffsetMinutes === 'number' ? meta.tzOffsetMinutes : 480;
    var tzLabel = 'UTC' + (tzOffset >= 0 ? '+' : '') + (tzOffset / 60);
    var days = asArray(data && data.days).slice().sort(function (a, b) { return a.day < b.day ? -1 : 1; });
    var routes = asArray(data && data.routes);
    var sessions = asArray(data && data.sessions);
    var trend = days.slice(-14);
    var maxDay = 0;
    trend.forEach(function (d) {
      if (Number(d.totalTokens) > maxDay) maxDay = Number(d.totalTokens);
    });
    var today = todayKey(tzOffset);
    var total = Number(global.totalTokens) || 0;
    var requests = Number(global.requests) || 0;
    var cacheHit = global.cacheHitRate;
    var cacheRead = Number(global.cacheReadTokens) || 0;
    var uncached = Number(global.uncachedInputTokens) || 0;
    var average = requests > 0 ? total / requests : null;

    useEffect(function () {
      var onKey = function (e) { if (e.key === 'Escape') close(); };
      document.addEventListener('keydown', onKey);
      return function () { document.removeEventListener('keydown', onKey); };
    }, [close]);

    function matches(value) {
      if (query === '') return true;
      return String(value || '').toLowerCase().indexOf(query.toLowerCase()) >= 0;
    }

    function exportJson() {
      if (!data) return;
      try {
        var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var link = document.createElement('a');
        link.href = url;
        link.download = 'dsh-token-usage.json';
        link.click();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      } catch (error) {
        /* clipboard/download may be unavailable in a restricted shell */
      }
    }

    var costUnit = costMode === 'cny' ? '¥' : (costMode === 'usd' ? '$' : '积分');
    /** Render one row cost in the unit the cost switch is showing. */
    function rowCost(cost) {
      if (!cost) return '--';
      if (costMode === 'cny') return cost.cny === null || cost.cny === undefined ? '--' : moneyText(cost.cny, '¥');
      if (costMode === 'usd') return cost.usd === null || cost.usd === undefined ? '--' : moneyText(cost.usd, '$');
      return cost.credits === null || cost.credits === undefined ? '--' : creditsText(cost.credits);
    }

    var body;
    if (!data) {
      body = h('div', { className: 'tsl-empty' },
        resource && resource.status === 'loading' ? '加载中…'
          : (resource && resource.status === 'failed' ? '历史数据读取失败' : '暂无历史数据'));
    } else if (tab === 'models') {
      var visibleModels = routes.filter(function (r) {
        return matches(r.route) || matches(shortRoute(r.route));
      });
      body = visibleModels.length === 0
        ? h('div', { className: 'tsl-empty' }, query ? '没有匹配的模型' : '还没有模型用量')
        : h('table', { className: 'tsl-table' },
          h('thead', null, h('tr', null,
            h('th', null, '模型'),
            h('th', { className: 'tsl-r' }, 'Token'),
            h('th', { className: 'tsl-r' }, '会话'),
            h('th', { className: 'tsl-bar-cell' }, '占总 Token'),
            h('th', { className: 'tsl-r' }, '占比'),
            h('th', { className: 'tsl-r' }, '费用（' + costUnit + '）'))),
          h('tbody', null, visibleModels.map(function (r) {
            var share = shareOf(Number(r.totalTokens), total);
            return h('tr', { key: r.route, title: r.route },
              h('td', null, h('div', { className: 'tsl-name' }, shortRoute(r.route))),
              h('td', { className: 'tsl-r' }, tokens(Number(r.totalTokens))),
              h('td', { className: 'tsl-r' }, String(r.sessions)),
              h('td', { className: 'tsl-bar-cell' },
                h('div', { className: 'tsl-mini-bar' },
                  h('div', { className: 'tsl-mini-fill', style: { width: Math.max(0, Math.min(100, (share || 0) * 100)) + '%' } }))),
              h('td', { className: 'tsl-r' }, percent(share)),
              h('td', { className: 'tsl-r' }, rowCost(r.cost)));
          })));
    } else if (tab === 'sessions') {
      var visibleSessions = sessions.filter(function (s) {
        return matches(s.title) || matches(s.sessionId) || matches(s.route) || matches(s.cwd);
      });
      body = visibleSessions.length === 0
        ? h('div', { className: 'tsl-empty' }, query ? '没有匹配的会话' : '还没有会话记录')
        : h('table', { className: 'tsl-table' },
          h('thead', null, h('tr', null,
            h('th', null, '会话'),
            h('th', null, '模型'),
            h('th', { className: 'tsl-r' }, 'Token'),
            h('th', { className: 'tsl-r' }, '请求'),
            h('th', null, '最近活动'),
            h('th', { className: 'tsl-r' }, '费用（' + costUnit + '）'))),
          h('tbody', null, visibleSessions.map(function (s) {
            return h('tr', { key: s.sessionId, title: s.cwd || s.sessionId },
              h('td', null, h('div', { className: 'tsl-name' }, (s.title || shortCwd(s.cwd) || s.sessionId).slice(0, 80))),
              h('td', null, h('span', { className: 'tsl-muted' }, shortRoute(s.route))),
              h('td', { className: 'tsl-r' }, tokens(Number(s.totalTokens))),
              h('td', { className: 'tsl-r' }, String(s.requests)),
              h('td', { className: 'tsl-muted' }, when(s.lastActivity || s.createdAt)),
              h('td', { className: 'tsl-r' }, rowCost(s.cost)));
          })));
    } else {
      var visibleDays = days.filter(function (d) { return matches(d.day); }).slice().reverse();
      body = visibleDays.length === 0
        ? h('div', { className: 'tsl-empty' }, query ? '没有匹配的日期' : '还没有历史记录')
        : h('table', { className: 'tsl-table' },
          h('thead', null, h('tr', null,
            h('th', null, '日期（' + tzLabel + '）'),
            h('th', { className: 'tsl-bar-cell' }, '日 Token 消耗'),
            h('th', { className: 'tsl-r' }, '缓存读'),
            h('th', { className: 'tsl-r' }, '新增输入'),
            h('th', { className: 'tsl-r' }, '输出'),
            h('th', { className: 'tsl-r' }, '缓存命中率'),
            h('th', { className: 'tsl-r' }, '费用（' + costUnit + '）'))),
          h('tbody', null, visibleDays.map(function (d) {
            var isToday = d.day === today;
            var max = maxDay || Number(d.totalTokens) || 1;
            return h('tr', { key: d.day },
              h('td', null, h('span', { className: isToday ? 'tsl-today' : '' }, d.day + (isToday ? '（今天）' : ''))),
              h('td', { className: 'tsl-bar-cell' },
                h('div', { className: 'tsl-mini-bar' },
                  h('div', { className: 'tsl-mini-fill', style: { width: Math.max(0, Math.min(100, (Number(d.totalTokens) / max) * 100)) + '%' } })),
                h('div', { className: 'tsl-muted', style: { marginTop: '3px' } }, tokens(Number(d.totalTokens)))),
              h('td', { className: 'tsl-r' }, tokens(Number(d.cacheReadTokens))),
              h('td', { className: 'tsl-r' }, tokens(Number(d.uncachedInputTokens))),
              h('td', { className: 'tsl-r' }, tokens(Number(d.outputTokens))),
              h('td', { className: 'tsl-r' }, h('span', { className: 'tsl-pill' + ((Number(d.cacheHitRate) || 0) < 0.8 ? ' tsl-pill-warn' : '') }, percent(d.cacheHitRate))),
              h('td', { className: 'tsl-r' }, rowCost(d.cost)));
          })));
    }

    var tabs = [['days', '按天'], ['models', '按模型'], ['sessions', '按会话']].map(function (pair) {
      return h('button', {
        key: pair[0], type: 'button', className: 'tsl-tab' + (tab === pair[0] ? ' tsl-tab-active' : ''),
        onClick: function () { setTab(pair[0]); },
      }, pair[1]);
    });

    return h('div', {
      className: 'tsl-modal-mask',
      onClick: function (e) { if (e.target === e.currentTarget) close(); },
    },
    h('div', { className: 'tsl-modal', role: 'dialog', 'aria-label': 'Token用量' },
      h('div', { className: 'tsl-dash-head' },
        h('div', { className: 'tsl-dash-brand' },
          h('div', { className: 'tsl-dash-logo' }, h(MeterIcon, { size: 20 })),
          h('div', null,
            h('div', { className: 'tsl-dash-title' }, 'Token用量'),
            h('div', { className: 'tsl-dash-sub' }, '历史累计 · 跨会话镜像 · 含已删除/已归档'))),
        h('div', { className: 'tsl-dash-status' },
          h('span', { className: 'tsl-live-dot' }),
          h('span', { className: 'tsl-muted' }, '实时 · 每 2 秒刷新'),
          h('button', {
            type: 'button', className: 'tsl-icon-btn', title: '关闭 (Esc)',
            'aria-label': '关闭', onClick: close,
          }, '×'))),
      h('div', { className: 'tsl-stat-row' },
        h(StatCard, {
          label: '历史总 Token 消耗', pill: 'AGGREGATED',
          value: tokens(total), sub: '含已删除会话 · ' + (Number(global.sessions) || 0) + ' 个会话',
        }),
        h(StatCard, {
          label: '全局缓存命中率', pill: 'DEEPSEEK CACHE',
          value: percent(cacheHit), sub: '缓存读 ' + tokens(cacheRead) + ' / 未缓存 ' + tokens(uncached),
        }),
        h('div', { className: 'tsl-stat tsl-cost-stat' },
          h('div', { className: 'tsl-cost-head' },
            h('div', { className: 'tsl-stat-label' }, '累计费用'),
            h('div', { className: 'tsl-cost-switch', role: 'group', 'aria-label': '费用口径' },
              h('button', {
                type: 'button', className: 'tsl-cost-tab' + (costMode === 'workbuddy' ? ' tsl-cost-tab-active' : ''),
                onClick: function () { setCostMode('workbuddy'); },
              }, '积分'),
              h('button', {
                type: 'button', className: 'tsl-cost-tab' + (costMode === 'cny' ? ' tsl-cost-tab-active' : ''),
                onClick: function () { setCostMode('cny'); },
              }, '人民币'),
              h('button', {
                type: 'button', className: 'tsl-cost-tab' + (costMode === 'usd' ? ' tsl-cost-tab-active' : ''),
                onClick: function () { setCostMode('usd'); },
              }, '美元')),
            h('button', {
              type: 'button',
              className: 'tsl-price-refresh'
                + (priceRefresh.status === 'loading' ? ' tsl-price-refresh-loading' : '')
                + (priceRefresh.status === 'partial' ? ' tsl-price-refresh-partial' : ''),
              title: (priceRefresh.status === 'error' || priceRefresh.status === 'partial') && priceRefresh.message
                ? priceRefresh.message
                : '刷新汇率与模型 API 价格',
              'aria-label': '刷新汇率与模型 API 价格',
              disabled: priceRefresh.status === 'loading',
              onClick: refreshPrices,
            }, h('svg', {
              width: '14', height: '14', viewBox: '0 0 24 24', fill: 'none',
              stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round',
              strokeLinejoin: 'round', 'aria-hidden': 'true',
            },
            h('path', { d: 'M21 12a9 9 0 1 1-2.64-6.36' }),
            h('path', { d: 'M21 3v6h-6' })))),
          h('div', { className: 'tsl-stat-value' }, costValue),
          h('div', { className: 'tsl-stat-sub' }, costSub)),
        h(StatCard, {
          label: '调用与会话体量', pill: '100% INDEX',
          value: requests.toLocaleString(), sub: (Number(global.sessions) || 0) + ' 个会话 · 平均 ' + (average === null ? '--' : tokens(average)) + ' Token/请求',
        })),
      h(TrendChart, { trend: trend, tzLabel: tzLabel }),
      h('div', { className: 'tsl-toolbar' },
        h('div', { className: 'tsl-tab-group' }, tabs),
        h('input', {
          className: 'tsl-filter', type: 'search', value: query,
          placeholder: '过滤（模型 / 日期 / 会话 ID）…',
          onChange: function (e) { setQuery(e.target.value); },
        }),
        h('button', { type: 'button', className: 'tsl-btn', onClick: exportJson }, '导出 JSON')),
      h('div', { className: 'tsl-table-wrap' }, body),
      h('div', { className: 'tsl-update-row tsl-update-row-footer' },
        h('span', { className: 'tsl-muted' }, updateText()),
        update && update.status === 'available'
          ? h('button', { type: 'button', className: 'tsl-tab tsl-tab-active', onClick: installUpdate }, '安装更新')
          : null,
        update && (update.status === 'checking' || update.status === 'applying')
          ? null
          : h('button', { type: 'button', className: 'tsl-tab', onClick: checkUpdate }, '检查更新'))));
  }

  /**
   * The panel's history reader. This component exists so `useResource` is a
   * stable, unconditional hook call for the lifetime of one mounted panel.
   */
  function LivePanelHost(props) {
    var history = props.useResource('dsh-resource://tokenusage/' + (props.sessionId || ''));
    return h(LivePanel, {
      useProjection: props.useProjection,
      history: history,
      setShowHistory: props.setShowHistory,
    });
  }

  /** Same isolation for the modal: mount => one stable `useResource` call. */
  function HistoryModalHost(props) {
    var history = props.useResource('dsh-resource://tokenusage/' + (props.sessionId || ''));
    return h(HistoryModal, {
      resource: history,
      close: props.close,
      tab: props.tab,
      setTab: props.setTab,
    });
  }

  // ---------------------------------------------------------------- resource

  /**
   * Register the client resource that carries the cross-session history.
   *
   * A third-party Host Remote namespace is not mounted by the browser's official
   * Remote assembly, so `ctx.remote.tokenUsage` does not exist. The browser does
   * have the official `workspaceFiles` namespace; the Host half mirrors the
   * aggregate into `<workspace>/.dsh-token-usage.json`, and this provider reads
   * that file through `workspaceFiles.read` and refreshes it while a surface is
   * open. The address carries the Session id so the Host can resolve the
   * workspace root.
   */
  var HISTORY_PROTOCOL = 'tokenusage';
  var HISTORY_PREFIX = 'dsh-resource://tokenusage/';
  var HISTORY_FILE = '.dsh-token-usage.json';

  function registerHistoryResource(ctx) {
    var resources;
    try { resources = ctx.resources; } catch (e) { resources = undefined; }
    if (resources === undefined && typeof ctx.get === 'function') {
      try { resources = ctx.get('resources'); } catch (e) { resources = undefined; }
    }
    if (resources === undefined || typeof resources.register !== 'function') {
      ctx.logger?.warn?.('[dsh-token-usage] ctx.resources is unavailable; history disabled');
      return false;
    }
    ctx.effect(function () {
      return resources.register({
        protocol: HISTORY_PROTOCOL,
        /**
         * @param address - `dsh-resource://tokenusage/<sessionId>`
         * @param options - `{ signal }`; the stream must stop when it aborts
         */
        open: function (address, options) {
          var signal = options === undefined ? undefined : options.signal;
          var sessionId = typeof address === 'string' && address.indexOf(HISTORY_PREFIX) === 0
            ? address.slice(HISTORY_PREFIX.length)
            : '';
          return (async function* () {
            if (sessionId === '') {
              yield { ok: false, error: { code: 'missing-session', message: 'history address has no session id' } };
              return;
            }
            var remote = ctx.get ? ctx.get('remote') : undefined;
            var files;
            try { files = remote === undefined ? undefined : remote.workspaceFiles; } catch (e) { files = undefined; }
            var filesAvailable = files !== undefined && typeof files.read === 'function';
            if (!filesAvailable) {
              ctx.logger?.warn?.('[dsh-token-usage] remote.workspaceFiles is unavailable; trying HTTP snapshot');
            }
            var readOnce = async function () {
              if (!filesAvailable) {
                return { ok: false, error: { code: 'workspace-files-unavailable', message: 'ctx.remote.workspaceFiles is unavailable' } };
              }
              // The mirror is one JSON line; asking for a huge page can exceed the
              // Host's configured maxLines and turn into a validation failure.
              var result;
              try {
                result = await files.read(sessionId, HISTORY_FILE, { offset: 1, limit: 1 }, signal);
              } catch (error) {
                return { ok: false, error: { code: 'read-threw', message: String(error) } };
              }
              if (result === null || typeof result !== 'object' || result.ok !== true) {
                var code = result && result.error && typeof result.error.code === 'string'
                  ? result.error.code
                  : 'read-failed';
                console.warn('[dsh-token-usage] history read failed', { sessionId, code, result });
                return { ok: false, error: { code, message: 'workspaceFiles.read failed' } };
              }
              var text = result.value !== null && typeof result.value === 'object' && typeof result.value.text === 'string'
                ? result.value.text
                : '';
              try {
                return { ok: true, value: JSON.parse(text) };
              } catch (e) {
                console.warn('[dsh-token-usage] history mirror is not valid JSON', { sessionId, text: text.slice(0, 200) });
                return { ok: false, error: { code: 'parse-failed', message: 'mirror is not valid JSON' } };
              }
            };
            var readViaHttp = async function () {
              if (typeof fetch !== 'function') {
                return { ok: false, error: { code: 'fetch-unavailable', message: 'fetch is unavailable' } };
              }
              var candidates = ['/dsh-token-usage/api/snapshot'];
              try {
                if (typeof window !== 'undefined' && window.location
                  && window.location.protocol === 'http:' && window.location.port !== '') {
                  candidates.push('http://127.0.0.1:' + window.location.port + '/dsh-token-usage/api/snapshot');
                }
              } catch (e) { /* no window */ }
              for (const url of candidates) {
                try {
                  const response = await fetch(url, { signal: signal, headers: { accept: 'application/json' } });
                  if (!response.ok) continue;
                  return { ok: true, value: await response.json() };
                } catch (e) { /* try the next candidate */ }
              }
              return { ok: false, error: { code: 'http-failed', message: 'HTTP snapshot failed' } };
            };
            var sleep = function (ms) {
              return new Promise(function (resolve) {
                if (signal !== undefined && signal.aborted) { resolve(); return; }
                var settled = false;
                var finish = function () {
                  if (settled) return;
                  settled = true;
                  clearTimeout(timer);
                  if (signal !== undefined) signal.removeEventListener('abort', finish);
                  resolve();
                };
                var timer = setTimeout(finish, ms);
                if (signal !== undefined) signal.addEventListener('abort', finish, { once: true });
              });
            };
            var first = await readOnce();
            if (!first.ok) {
              // The Host may still be writing the first mirror right after boot.
              await sleep(500);
              if (signal !== undefined && signal.aborted) return;
              first = await readOnce();
            }
            if (!first.ok) {
              var viaHttp = await readViaHttp();
              if (viaHttp.ok) first = viaHttp;
            }
            yield first;
            // Auto-refresh while the panel/modal is open. The Host rewrites the
            // mirror after each ~2s ledger flush; a 2s read keeps the cumulative
            // and per-model history current without any polling when closed.
            var last = first.ok ? JSON.stringify(first.value) : '';
            for (;;) {
              await sleep(2000);
              if (signal !== undefined && signal.aborted) return;
              var next = await readOnce();
              if (signal !== undefined && signal.aborted) return;
              if (!next.ok) {
                var viaHttpNext = await readViaHttp();
                if (viaHttpNext.ok) next = viaHttpNext;
              }
              if (!next.ok) continue; // transient failure: keep the last good value
              var nextText = JSON.stringify(next.value);
              if (nextText === last) continue;
              last = nextText;
              yield next;
            }
          })();
        },
      });
    }, 'dsh-token-usage: history resource');
    return true;
  }

  // ---------------------------------------------------------------- trigger

  class TokenReadoutBoundary extends React.Component {
    constructor(props) {
      super(props);
      this.state = { failed: false };
    }
    static getDerivedStateFromError() {
      return { failed: true };
    }
    componentDidCatch(error) {
      console.warn('[dsh-token-usage] readout crashed', error);
    }
    render() {
      if (this.state.failed) {
        // Never let a render error remove the entry entirely.
        return h('button', {
          type: 'button', className: 'tsl-trigger',
          title: 'Token用量暂不可用，点击刷新重试',
          onClick: function () { if (typeof location !== 'undefined') location.reload(); },
        }, h(MeterIcon, { size: 14 }), h('span', null, 'Token'));
      }
      return h(TokenReadout, this.props);
    }
  }

  function TokenReadout(props) {
    var useProjection = props.useProjection;
    // The official primitives module, threaded in by the module factory. It owns
    // anchored positioning and outside-pointer dismissal, so the panel opens and
    // closes like every other floating surface in the harness.
    var primitives = typeof PRIMITIVES !== 'undefined' && PRIMITIVES !== null ? PRIMITIVES : null;

    var state = useState(false);
    var open = state[0];
    var setOpen = state[1];
    var histState = useState(false);
    var showHistory = histState[0];
    var setShowHistory = histState[1];
    var tabState = useState('days');
    var tab = tabState[0];
    var setTab = tabState[1];

    var live = readLive(useProjection);

    // History is read by a child component mounted only while a surface needs
    // it. Calling `useResource` conditionally here would change the hook order
    // when the panel opens; React then throws and the panel disappears.

    var anchorRef = useRef(null);
    var panelRef = useRef(null);
    var closeTimer = useRef(null);
    var posState = useState(null);
    var measured = posState[0];
    var setMeasured = posState[1];

    function cancelClose() {
      if (closeTimer.current !== null) {
        clearTimeout(closeTimer.current);
        closeTimer.current = null;
      }
    }

    // Hover intent: closing immediately on the trigger's mouseleave makes the
    // panel flicker, because the panel is a fixed sibling and the pointer has to
    // cross a gap (or the panel appears under the cursor). Wait a short beat and
    // let the panel cancel the close when the pointer arrives.
    function scheduleClose() {
      cancelClose();
      closeTimer.current = setTimeout(function () {
        closeTimer.current = null;
        setOpen(false);
      }, 180);
    }

    useEffect(function () {
      return function () {
        if (closeTimer.current !== null) {
          clearTimeout(closeTimer.current);
          closeTimer.current = null;
        }
      };
    }, []);

    function measure() {
      var el = anchorRef.current;
      if (!el || typeof el.getBoundingClientRect !== 'function') return;
      var rect = el.getBoundingClientRect();
      var viewport = typeof window !== 'undefined' && typeof window.innerWidth === 'number' ? window.innerWidth : 0;
      var right = viewport > 0 ? Math.max(8, viewport - rect.right) : 16;
      setMeasured({ position: 'fixed', top: Math.round(rect.bottom + 8), right: right, zIndex: 9994 });
    }

    useEffect(function () {
      if (open) measure();
    }, [open]);

    var anchored = primitives && primitives.useAnchoredPosition
      ? primitives.useAnchoredPosition({
        open: open, anchorRef: anchorRef, panelRef: panelRef, side: 'bottom', gap: 8, margin: 12,
      })
      : undefined;
    var position = anchored || measured || undefined;

    if (primitives && primitives.useDismissOnOutsidePointer && open) {
      primitives.useDismissOnOutsidePointer(anchorRef, true, function () { setOpen(false); }, panelRef);
    }

    useEffect(function () {
      if (!open) return undefined;
      var onKey = function (e) { if (e.key === 'Escape') setOpen(false); };
      document.addEventListener('keydown', onKey);
      return function () { document.removeEventListener('keydown', onKey); };
    }, [open]);

    var label = live.ok ? tokens(live.total) : 'Token';
    var title = live.ok
      ? ('累计 ' + live.total.toLocaleString()
        + '\n入 ' + live.input.toLocaleString()
        + ' · 缓存读 ' + live.cacheRead.toLocaleString()
        + ' · 出 ' + live.output.toLocaleString())
      : 'Token用量';

    var panel = open
      ? h('div', {
        ref: panelRef,
        style: Object.assign(
          { position: 'fixed', zIndex: 9994 },
          position === undefined ? { top: 40, right: 16 } : position,
        ),
        onMouseEnter: cancelClose,
        onMouseLeave: scheduleClose,
      }, h(LivePanelHost, {
        useProjection: useProjection,
        useResource: props.useResource,
        sessionId: props.sessionId,
        setShowHistory: setShowHistory,
      }))
      : null;

    var modal = showHistory
      ? (ReactDOMBridge !== null && typeof ReactDOMBridge.createPortal === 'function'
        ? ReactDOMBridge.createPortal(h(HistoryModalHost, {
          useResource: props.useResource,
          sessionId: props.sessionId,
          close: function () { setShowHistory(false); },
          tab: tab, setTab: setTab,
        }), document.body)
        : h(HistoryModalHost, {
          useResource: props.useResource,
          sessionId: props.sessionId,
          close: function () { setShowHistory(false); },
          tab: tab, setTab: setTab,
        }))
      : null;

    return h(React.Fragment, null,
      h('button', {
        ref: anchorRef,
        type: 'button',
        className: 'tsl-trigger',
        title: title,
        'aria-label': 'Token用量',
        onClick: function () { cancelClose(); setOpen(!open); },
        onMouseEnter: function () { cancelClose(); setOpen(true); },
        onMouseLeave: scheduleClose,
      }, h(MeterIcon, { size: 14 }), h('span', null, label)),
      panel,
      modal);
  }

  // ---------------------------------------------------------------- boot

  var SLOT = 'conversation.session.header.utilities';
  // Keep the readout entry independent of optional history services. `slots` is
  // the only hard dependency; `resources` / `remote` are looked up lazily and a
  // failure there must never remove the button.
  var inject = ['slots'];

  function apply(ctx) {
    ctx.effect(function () {
      var style = document.createElement('style');
      style.dataset.plugin = 'dsh-token-usage';
      style.textContent = CSS;
      document.head.appendChild(style);
      return function () { style.remove(); };
    }, 'dsh-token-usage: styles');

    var startHistory = function (historyCtx) {
      try {
        registerHistoryResource(historyCtx);
      } catch (error) {
        // History is optional: a resource-registry failure must not take the
        // readout entry down with it.
        historyCtx.logger?.warn?.(`[dsh-token-usage] history resource registration failed: ${String(error)}`);
      }
    };
    if (typeof ctx.inject === 'function') {
      // Wait for the official services without making them a hard activation
      // dependency of the readout. If they are already present the callback runs
      // immediately; if they mount later, it runs then.
      ctx.inject(['resources', 'remote'], function (historyCtx) { startHistory(historyCtx); });
    } else {
      startHistory(ctx);
    }

    ctx.slots.inject(SLOT, function () {
      return ctx.slots.register({
        name: SLOT,
        id: 'dsh-token-usage-readout',
        order: -20,
        // No entry-level `inject`: `useProjection` and `useResource` are
        // framework-provided standard props on this session-scoped slot.
      }, TokenReadoutBoundary);
    });

    ctx.logger && ctx.logger.info && ctx.logger.info('[dsh-token-usage] client ready');
  }

  return { apply: apply, inject: inject };
    })();
    exports.apply = mod.apply;
    exports.inject = mod.inject;
    return module.exports;
  }
});

/**
 * Render a static preview of the dashboard, using the *real* stylesheet from
 * `src/body.js` and markup that mirrors the component tree, so the layout can be
 * reviewed without installing the plugin.
 *
 * Run: node scripts/preview-dashboard.mjs
 * Out: evidence/preview-dashboard.html
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const source = await readFile(join(root, 'src', 'body.js'), 'utf8');

const start = source.indexOf('var CSS = [');
const end = source.indexOf("].join('');", start);
if (start < 0 || end < 0) throw new Error('CSS array not found');
const literal = source.slice(start + 'var CSS = '.length, end + 1).replace(/\/\/[^\n]*\n/g, '\n');
const css = new Function(`return ${literal};`)().join('');

const rows = [
  ['2026-10-27（今天）', '388.4M', 22, '383.6M', '3.86M', '979K', '99%', '479 credits'],
  ['2026-10-25', '406.7M', 23, '403.0M', '2.98M', '762K', '99%', '501 credits'],
  ['2026-10-24', '691.7M', 39, '681.8M', '8.78M', '1.04M', '99%', '852 credits'],
  ['2026-10-23', '1.73B', 100, '1.70B', '19.3M', '2.82M', '99%', '2,126 credits'],
  ['2026-10-22', '61.2M', 4, '60.1M', '0.9M', '212K', '99%', '76 credits'],
];

const bars = [8, 12, 72, 26, 20, 31, 9, 63, 8, 5, 100, 52, 35, 3];

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>Token用量 · 0.2.4 静态预览</title>
<style>
  /* The plugin reads these aliases from DSH; the preview supplies the light
     palette the app actually renders with. */
  :root{
    --dsw-alias-bg-overlay:#ffffff;
    --dsw-alias-bg-base:#f8fafc;
    --dsw-alias-bg-mask-base:rgba(15,23,42,.45);
    --dsw-alias-label-primary:#111827;
    --dsw-alias-label-secondary:#4b5563;
    --dsw-alias-label-tertiary:#6b7280;
    --dsw-alias-border-l3:#e2e8f0;
    --dsw-alias-interactive-bg-hover:#f1f5f9;
    --dsw-alias-button-elevated-fill:#ffffff;
    --dsw-alias-accent:#2563eb;
  }
  html,body{margin:0;background:#f1f5f9;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
  body{padding:28px}
  ${css}
  .preview-note{max-width:1040px;margin:0 auto 12px;font-size:12px;color:#64748b}
  .tsl-modal-mask{position:static;background:transparent;display:block}
  .tsl-modal{margin:0 auto;max-height:none;width:min(1040px,100%)}
  .tsl-dash-body{overflow:visible}
</style></head>
<body>
  <div class="preview-note">静态预览（真样式表 + 与组件一致的结构，示例数据）— 不是运行中的插件，只用于看版式。</div>
  <div class="tsl-modal" role="dialog" aria-label="Token用量">
    <div class="tsl-dash-head">
      <div class="tsl-dash-brand">
        <div class="tsl-dash-logo">◔</div>
        <div>
          <div class="tsl-dash-title-row">
            <div class="tsl-dash-title">Token用量</div>
            <span class="tsl-dash-chip">Live Monitor</span>
          </div>
          <div class="tsl-dash-sub">历史累计 · 跨会话镜像 · 含已删除/已归档</div>
        </div>
      </div>
      <div class="tsl-dash-status">
        <span class="tsl-live-dot"></span>
        <span class="tsl-muted">实时 · 每 2 秒刷新</span>
        <a class="tsl-head-btn" href="#" title="在 GitHub 上查看 Releases">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/>
          </svg>
          <span>GitHub Releases</span>
        </a>
        <button type="button" class="tsl-icon-btn" aria-label="关闭">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
            <path d="M2.5 2.5 9.5 9.5"/><path d="M9.5 2.5 2.5 9.5"/>
          </svg>
        </button>
      </div>
    </div>
    <div class="tsl-dash-body">
      <div class="tsl-stat-row">
        <div class="tsl-stat">
          <div class="tsl-stat-label">历史总 Token 消耗<span class="tsl-stat-pill">AGGREGATED</span></div>
          <div class="tsl-stat-value-row"><div class="tsl-stat-value">7.97B</div></div>
          <div class="tsl-stat-foot"><span>含已删除会话 · 44 个会话</span><span class="tsl-stat-delta">↗ +12.4%</span></div>
        </div>
        <div class="tsl-stat">
          <div class="tsl-stat-label">全局缓存命中率<span class="tsl-stat-pill">DEEPSEEK CACHE</span></div>
          <div class="tsl-stat-value-row"><div class="tsl-stat-value">99%</div><span class="tsl-stat-chip">极速镜像</span></div>
          <div class="tsl-stat-foot"><span>缓存读 7.87B / 未缓存 83.7M</span></div>
        </div>
        <div class="tsl-stat">
          <div class="tsl-stat-label">累计费用<span class="tsl-stat-pill">积分</span></div>
          <div class="tsl-stat-value-row"><div class="tsl-stat-value">9,026 <span style="font-size:14px;font-weight:500">credits</span></div></div>
          <div class="tsl-stat-foot"><span>WorkBuddy 实测</span><span class="tsl-stat-delta">覆盖 92%</span></div>
        </div>
        <div class="tsl-stat">
          <div class="tsl-stat-label">调用与会话体量<span class="tsl-stat-pill">100% INDEX</span></div>
          <div class="tsl-stat-value-row"><div class="tsl-stat-value">17,371</div></div>
          <div class="tsl-stat-foot"><span>44 个会话 · 平均 459K Token/请求</span></div>
        </div>
      </div>

      <div class="tsl-trend">
        <div class="tsl-trend-head">
          <span>最近 14 天 Token 构成（UTC+8）</span>
          <div class="tsl-tab-group">
            <button type="button" class="tsl-tab">API 请求次数</button>
            <button type="button" class="tsl-tab tsl-tab-active">Tokens</button>
          </div>
        </div>
        <div class="tsl-chart-legend">
          <span><span class="tsl-legend-dot" style="background:var(--tsl-chart-cache)"></span>命中缓存</span>
          <span><span class="tsl-legend-dot" style="background:var(--tsl-chart-input)"></span>未命中缓存</span>
          <span><span class="tsl-legend-dot" style="background:var(--tsl-chart-output)"></span>输出</span>
        </div>
        <div class="tsl-chart-stage">
          <div class="tsl-chart-y"><span>1.73B</span><span>863.0M</span><span>0</span></div>
          <div class="tsl-chart-plot">
            <div class="tsl-chart-bars">
              ${bars.map((h) => `<div class="tsl-chart-col"><div class="tsl-chart-stack" style="height:${Math.max(4, h)}%"><div class="tsl-chart-seg" style="flex:1;background:var(--tsl-chart-cache)"></div><div class="tsl-chart-seg" style="height:6%;background:var(--tsl-chart-output)"></div></div></div>`).join('')}
            </div>
            <div class="tsl-chart-x">
              ${['10-05', '10-14', '10-15', '10-16', '10-17', '10-18', '10-19', '10-20', '10-21', '10-22', '10-23', '10-24', '10-25', '10-27'].map((d) => `<span>${d}</span>`).join('')}
            </div>
          </div>
        </div>
      </div>

      <div class="tsl-toolbar">
        <div class="tsl-tab-group">
          <button type="button" class="tsl-tab tsl-tab-active">按天</button>
          <button type="button" class="tsl-tab">按模型</button>
          <button type="button" class="tsl-tab">按会话</button>
        </div>
        <input class="tsl-filter" type="search" placeholder="过滤（模型 / 日期 / 会话 ID）…">
        <button type="button" class="tsl-btn">导出 JSON</button>
      </div>

      <div class="tsl-table-wrap">
        <table class="tsl-table">
          <thead><tr>
            <th>日期（UTC+8）</th><th class="tsl-bar-cell">日 Token 消耗</th>
            <th class="tsl-r">缓存读</th><th class="tsl-r">新增输入</th><th class="tsl-r">输出</th>
            <th class="tsl-r">缓存命中率</th><th class="tsl-r">费用（积分）</th>
          </tr></thead>
          <tbody>
          ${rows.map(([day, tok, pct, cache, input, out, hit, cost], index) => `<tr>
            <td><span class="${index === 0 ? 'tsl-today' : ''}">${day}</span></td>
            <td class="tsl-bar-cell"><div class="tsl-rowbar"><span class="tsl-num">${tok}</span>
              <div class="tsl-mini-bar"><div class="tsl-mini-fill" style="width:${pct}%"></div></div></div></td>
            <td class="tsl-r">${cache}</td><td class="tsl-r">${input}</td><td class="tsl-r">${out}</td>
            <td class="tsl-r"><span class="tsl-pill">${hit}</span></td>
            <td class="tsl-r">${cost}</td>
          </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
    <div class="tsl-update-row tsl-update-row-footer">
      <div class="tsl-footer-actions">
        <span class="tsl-muted">版本 0.2.4</span>
        <button type="button" class="tsl-tab">检查更新</button>
      </div>
    </div>
  </div>
</body></html>
`;

const outDir = join(root, 'evidence');
await mkdir(outDir, { recursive: true });
const out = join(outDir, 'preview-dashboard.html');
await writeFile(out, html, 'utf8');
console.log(`preview written: ${out} (${html.length} chars, css ${css.length} chars)`);

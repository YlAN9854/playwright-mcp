# ECharts Canvas 元素程序化交互技术指南

> 提取自 VASI 项目，面向复用  
> 日期：2026-03

---

## 1. 问题背景

ECharts 等图表库将图表渲染在 `<canvas>` 元素上。与 SVG/HTML 不同，Canvas 内部的图形元素（柱子、折线数据点、图例项、雷达轴名等）**不是 DOM 节点**，无法用 `querySelector` 定位，也无法通过 `element.click()` 直接操作某个图形。

因此，对 Canvas 图表的自动化交互必须借助 **ECharts 自身的 JavaScript API**。

---

## 2. 核心 API 概览

### 2.1 `echarts.getInstanceByDom(dom)` — 获取实例

ECharts 将实例与容器 DOM 元素绑定。通过全局 `echarts` 对象可以反查：

```javascript
const container = document.querySelector('#my-chart');
const instance = echarts.getInstanceByDom(container);
```

### 2.2 `instance.dispatchAction(action)` — 调度内置动作

ECharts 提供了一整套 Action API，覆盖图例切换、数据高亮、缩放等：

```javascript
// 切换图例项的显隐
instance.dispatchAction({ type: 'legendToggleSelect', name: 'Sales' });

// 高亮某个数据点
instance.dispatchAction({ type: 'highlight', seriesIndex: 0, dataIndex: 3 });

// 取消高亮
instance.dispatchAction({ type: 'downplay', seriesIndex: 0, dataIndex: 3 });

// 显示 tooltip
instance.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: 3 });

// 数据区域缩放
instance.dispatchAction({ type: 'dataZoom', start: 20, end: 80 });
```

常用 Action 类型：

| type | 说明 | 关键参数 |
|------|------|---------|
| `legendToggleSelect` | 切换图例项显隐 | `name` |
| `legendSelect` | 选中图例项 | `name` |
| `legendUnSelect` | 取消选中图例项 | `name` |
| `highlight` | 高亮 | `seriesIndex`, `dataIndex`, `name` |
| `downplay` | 取消高亮 | 同上 |
| `showTip` | 显示 tooltip | `seriesIndex`, `dataIndex` |
| `hideTip` | 隐藏 tooltip | — |
| `dataZoom` | 数据缩放 | `start`, `end`, `dataZoomIndex` |
| `select` | 选中数据 | `seriesIndex`, `dataIndex` |
| `unselect` | 取消选中 | 同上 |
| `toggleSelect` | 切换选中 | 同上 |

### 2.3 `instance.trigger(eventType, params)` — 触发事件处理器

**这是 VASI 中最核心的技术手段。** 很多 React/Vue 应用通过 ECharts 的事件监听（如 `echarts-for-react` 的 `onEvents.click`）来驱动业务逻辑。`trigger` 可以程序化地触发这些事件处理器，效果等同于用户真实点击：

```javascript
instance.trigger('click', {
  componentType: 'radar',      // 或 'series', 'xAxis', 'yAxis' 等
  name: 'ASR',                 // 目标元素的名称
  seriesIndex: 0,
  dataIndex: 2,
  event: { target: {} }        // 需要提供一个最小化的 event 对象
});
```

**`trigger` vs `dispatchAction` 的区别：**

| 维度 | `dispatchAction` | `trigger` |
|------|-------------------|-----------|
| 作用 | 调用 ECharts 内置动作（图例切换等） | 触发用户注册的事件回调（`on('click', handler)`） |
| 适用场景 | 操作图表自身 UI（图例、缩放等） | 驱动应用业务逻辑（React 状态更新、MobX store 调用等） |
| 参数 | 固定的 Action 结构 | 自由构造的 event params 对象 |

### 2.4 `instance.getOption()` — 读取图表配置

可用于读取当前图表的 series、legend 等信息：

```javascript
const option = instance.getOption();
console.log(option.legend[0].data);   // 图例项列表
console.log(option.series);           // 所有系列
```

### 2.5 `instance.on(eventType, handler)` — 注册事件监听

```javascript
instance.on('click', (params) => {
  console.log(params.componentType);  // 'series' | 'xAxis' | ...
  console.log(params.name);           // 数据点/类目名
  console.log(params.dataIndex);
});
```

---

## 3. ECharts 实例发现策略（VASI 实现总结）

在自动化场景中，最大的挑战是**如何在不了解页面结构的前提下，自动找到 ECharts 实例**。VASI 采用了 5 种递进策略：

### 策略 1：`echarts.getInstanceByDom(el)`

最标准的方式。前提是 `window.echarts` 全局对象可用：

```javascript
function getEChartsGlobal() {
  if (typeof window.echarts !== 'undefined') return window.echarts;
  try {
    const ec = eval('typeof echarts !== "undefined" ? echarts : null');
    if (ec && typeof ec.getInstanceByDom === 'function') return ec;
  } catch {}
  return null;
}

const ec = getEChartsGlobal();
const instance = ec?.getInstanceByDom(targetElement);
```

### 策略 2：查找带 `_echarts_instance_` 属性的子元素

ECharts 在容器 DOM 上设置 `_echarts_instance_` 属性（值为实例的 ID）：

```javascript
const echartsChild = container.querySelector('[_echarts_instance_]');
const instance = echarts.getInstanceByDom(echartsChild);
```

### 策略 3：从 `<canvas>` 回溯到父容器

Canvas 元素本身不是实例容器，但其直接父元素通常是：

```javascript
const canvas = container.querySelector('canvas');
const instance = echarts.getInstanceByDom(canvas.parentElement);
```

### 策略 4：向上遍历祖先元素

当 CSS 选择器定位到图表内部某个元素时，逐级向上查找：

```javascript
let ancestor = element.parentElement;
while (ancestor && ancestor !== document.body) {
  const instance = echarts.getInstanceByDom(ancestor);
  if (instance) return instance;
  ancestor = ancestor.parentElement;
}
```

### 策略 5：React Fiber 遍历（echarts-for-react）

在 React 应用中，`echarts-for-react` 等封装库通过 Ref 持有 ECharts 实例：

```javascript
// 从 DOM 元素找到 React Fiber
const fiberKey = Object.keys(element).find(k => k.startsWith('__reactFiber$'));
let fiber = element[fiberKey];

// 逐级向上遍历 Fiber 树
for (let i = 0; i < 30 && fiber; i++) {
  const stateNode = fiber.stateNode;
  // echarts-for-react 组件暴露 getEchartsInstance()
  if (typeof stateNode?.getEchartsInstance === 'function') {
    return stateNode.getEchartsInstance();
  }
  // 检查 ref.current
  if (fiber.ref?.current?.getEchartsInstance) {
    return fiber.ref.current.getEchartsInstance();
  }
  fiber = fiber.return;
}
```

### ECharts Canvas 识别标志

ECharts 渲染的 `<canvas>` 元素带有 `data-zr-dom-id` 属性（ZRender 内部标识），可以用它来判断一个 Canvas 是否是 ECharts 的：

```javascript
const isEChartsCanvas = canvas.hasAttribute('data-zr-dom-id');
```

---

## 4. VASI 中的完整执行流程

```
ActionExecutor.execute(action, params)
│
├── 1. 参数模板填充 → CSS 选择器定位目标元素
│
├── 2. 检测到 Canvas 元素且 event === 'click'
│   ├── 识别标志：element.tagName === 'CANVAS' && hasAttribute('data-zr-dom-id')
│   │
│   └── 3. 路由到 dispatchEChartsAction()
│       ├── 构建 payload { selector, dispatchType: 'trigger_click', name, componentType }
│       ├── 通过 CustomEvent('__vasi_page_action') 发送到 MAIN world
│       └── page-script 中的 chart_dispatch handler 处理：
│           ├── chartDispatch(payload)
│           │   ├── document.querySelector(selector) 定位容器
│           │   ├── findEChartsInstance(el) — 5 种策略
│           │   └── dispatchECharts(el, payload)
│           │       ├── trigger_click → instance.trigger('click', fakeParams)
│           │       └── 其他类型 → instance.dispatchAction({ type, name, ... })
│           └── 返回结果 { success, error? }
│
└── 4. 非 Canvas → 标准 DOM 事件模拟 (mousedown → mouseup → click)
```

**关键架构决策：跨世界（World）通信**

浏览器扩展的 Content Script 运行在 ISOLATED world，无法直接访问页面的 JavaScript 变量（如 `window.echarts`）。因此 VASI 使用 MAIN world 脚本 + CustomEvent 通信：

```
Content Script (ISOLATED) ──CustomEvent──→ Page Script (MAIN)
                                              │
                                              ├─ 访问 window.echarts
                                              ├─ findEChartsInstance()
                                              ├─ instance.trigger() / dispatchAction()
                                              │
                                              └──CustomEvent──→ Content Script (结果)
```

---

## 5. 代码复用模板

以下是从 VASI 中提取的、可独立复用的 ECharts 交互工具函数：

```typescript
// ────────────────────────────────────────────────────────────────
// echarts-interaction.ts — 可独立复用的 ECharts 程序化交互工具
// ────────────────────────────────────────────────────────────────

/** 获取全局 echarts 对象 */
function getEChartsGlobal(): any | null {
  if (typeof (window as any).echarts !== 'undefined') return (window as any).echarts;
  return null;
}

/** 从 DOM 元素查找 ECharts 实例（5 种策略） */
function findEChartsInstance(el: HTMLElement): any | null {
  const ec = getEChartsGlobal();
  
  const tryGet = (target: HTMLElement) => ec?.getInstanceByDom?.(target) || null;

  // 1. 自身
  let inst = tryGet(el);
  if (inst) return inst;

  // 2. 子元素
  const echChild = el.querySelector('[_echarts_instance_]') as HTMLElement;
  if (echChild) { inst = tryGet(echChild); if (inst) return inst; }

  // 3. Canvas 父元素
  const canvas = el.querySelector('canvas');
  if (canvas?.parentElement) { inst = tryGet(canvas.parentElement); if (inst) return inst; }

  // 4. 向上遍历
  let anc = el.parentElement;
  while (anc && anc !== document.body) {
    inst = tryGet(anc);
    if (inst) return inst;
    anc = anc.parentElement;
  }

  // 5. React Fiber（echarts-for-react）
  anc = el.parentElement;
  while (anc && anc !== document.body) {
    const fk = Object.keys(anc).find(k => k.startsWith('__reactFiber$'));
    if (fk) {
      let fiber = (anc as any)[fk];
      for (let i = 0; i < 30 && fiber; i++) {
        if (typeof fiber.stateNode?.getEchartsInstance === 'function') {
          try { return fiber.stateNode.getEchartsInstance(); } catch {}
        }
        if (fiber.ref?.current?.getEchartsInstance) {
          try { return fiber.ref.current.getEchartsInstance(); } catch {}
        }
        fiber = fiber.return;
      }
    }
    anc = anc.parentElement;
  }

  return null;
}

/** 判断一个元素是否为 ECharts Canvas */
function isEChartsCanvas(el: Element): boolean {
  return el.tagName === 'CANVAS' && el.hasAttribute('data-zr-dom-id');
}

/** 触发 ECharts 内置 Action（图例切换、高亮等） */
function echartsDispatchAction(
  container: HTMLElement, 
  actionType: string, 
  params: Record<string, any>
): boolean {
  const instance = findEChartsInstance(container);
  if (!instance) return false;
  instance.dispatchAction({ type: actionType, ...params });
  return true;
}

/** 触发 ECharts 点击事件（驱动应用业务逻辑） */
function echartsTriggerClick(
  container: HTMLElement, 
  componentType: string, 
  name: string,
  extra?: Record<string, any>
): boolean {
  const instance = findEChartsInstance(container);
  if (!instance || typeof instance.trigger !== 'function') return false;
  
  instance.trigger('click', {
    componentType,
    name,
    event: { target: {} },
    ...extra
  });
  return true;
}

/** 读取 ECharts 图表配置 */
function echartsGetOption(container: HTMLElement): any | null {
  const instance = findEChartsInstance(container);
  return instance?.getOption?.() || null;
}

/** 获取图例项列表 */
function echartsGetLegendItems(container: HTMLElement): string[] {
  const option = echartsGetOption(container);
  if (!option?.legend?.[0]?.data) return [];
  return option.legend[0].data;
}

/** 获取所有系列信息 */
function echartsGetSeriesInfo(container: HTMLElement): Array<{ name: string; type: string; dataLength: number }> {
  const option = echartsGetOption(container);
  if (!option?.series) return [];
  return option.series.map((s: any) => ({
    name: s.name || '',
    type: s.type || '',
    dataLength: s.data?.length || 0
  }));
}
```

---

## 6. 增强 Playwright-MCP 以支持 ECharts 的建议

### 6.1 现状分析

Playwright 本身通过 `page.evaluate()` 可以在页面上下文中执行任意 JavaScript，天然具备访问 `window.echarts` 的能力，**不需要** VASI 那种 ISOLATED/MAIN world 跨世界通信架构。这极大简化了实现。

但 Playwright-MCP 目前的工具集基于标准 DOM 操作（click、fill、select 等），对 Canvas 内部元素无感知。需要增加的能力：

1. **识别** 页面上的 ECharts 实例
2. **读取** 图表语义信息（图例、系列、数据点）
3. **操作** 图表元素（图例切换、数据点高亮/选中、tooltip、缩放）

### 6.2 建议新增的 MCP 工具

#### Tool 1: `echarts_discover` — 发现页面上所有 ECharts 实例

```typescript
// MCP Tool Schema
{
  name: "echarts_discover",
  description: "发现页面上所有 ECharts 图表实例，返回每个实例的容器选择器、图表类型、系列和图例信息",
  inputSchema: {
    type: "object",
    properties: {
      selector: {
        type: "string",
        description: "可选，限定搜索范围的 CSS 选择器"
      }
    }
  }
}
```

实现核心（`page.evaluate` 内部）：

```javascript
// 在 page.evaluate 中执行
function discoverECharts(scopeSelector) {
  const ec = window.echarts;
  if (!ec) return { charts: [], error: 'echarts not found on window' };

  const scope = scopeSelector ? document.querySelector(scopeSelector) : document.body;
  // 找到所有带 _echarts_instance_ 属性的容器
  const containers = scope.querySelectorAll('[_echarts_instance_]');
  
  return {
    charts: Array.from(containers).map((container, idx) => {
      const instance = ec.getInstanceByDom(container);
      if (!instance) return null;
      const option = instance.getOption();
      
      // 为容器生成一个稳定选择器
      const uid = container.getAttribute('_echarts_instance_');
      const cssSelector = `[_echarts_instance_="${uid}"]`;
      
      return {
        index: idx,
        selector: cssSelector,
        id: container.id || null,
        chartTypes: [...new Set(option.series?.map(s => s.type) || [])],
        series: option.series?.map(s => ({ name: s.name, type: s.type, dataCount: s.data?.length })) || [],
        legends: option.legend?.flatMap(l => l.data || []) || [],
        hasDataZoom: (option.dataZoom?.length || 0) > 0,
        title: option.title?.[0]?.text || null,
      };
    }).filter(Boolean)
  };
}
```

#### Tool 2: `echarts_get_option` — 读取图表详细配置

```typescript
{
  name: "echarts_get_option",
  description: "获取指定 ECharts 图表的完整或部分配置（option），用于理解图表内容",
  inputSchema: {
    type: "object",
    properties: {
      selector: { type: "string", description: "ECharts 容器的 CSS 选择器" },
      paths: { 
        type: "array", 
        items: { type: "string" },
        description: "要提取的 option 路径列表，如 ['series', 'legend', 'xAxis']。省略则返回完整 option"
      }
    },
    required: ["selector"]
  }
}
```

#### Tool 3: `echarts_action` — 执行 ECharts 内置动作

```typescript
{
  name: "echarts_action",
  description: "在指定 ECharts 图表上执行内置动作，如图例切换、数据高亮、tooltip 显示、缩放等",
  inputSchema: {
    type: "object",
    properties: {
      selector: { type: "string", description: "ECharts 容器的 CSS 选择器" },
      actionType: { 
        type: "string", 
        enum: ["legendToggleSelect", "legendSelect", "legendUnSelect", 
               "highlight", "downplay", "showTip", "hideTip",
               "dataZoom", "select", "unselect", "toggleSelect"],
        description: "ECharts Action 类型" 
      },
      name: { type: "string", description: "目标名称（图例项名/数据点名）" },
      seriesIndex: { type: "number", description: "系列索引" },
      dataIndex: { type: "number", description: "数据点索引" },
      start: { type: "number", description: "dataZoom 起始百分比 0-100" },
      end: { type: "number", description: "dataZoom 结束百分比 0-100" }
    },
    required: ["selector", "actionType"]
  }
}
```

实现：

```javascript
async function echartsAction(page, { selector, actionType, ...params }) {
  return await page.evaluate(({ sel, type, p }) => {
    const ec = window.echarts;
    const container = document.querySelector(sel);
    if (!container || !ec) return { success: false, error: 'Chart not found' };
    
    const instance = ec.getInstanceByDom(container);
    if (!instance) return { success: false, error: 'ECharts instance not found' };
    
    const action = { type, ...p };
    // 清理 undefined 值
    Object.keys(action).forEach(k => action[k] === undefined && delete action[k]);
    
    instance.dispatchAction(action);
    return { success: true };
  }, { sel: selector, type: actionType, p: params });
}
```

#### Tool 4: `echarts_trigger_event` — 触发自定义事件

```typescript
{
  name: "echarts_trigger_event",
  description: "触发 ECharts 图表的事件处理器（如 click、mouseover），用于驱动应用的业务逻辑响应",
  inputSchema: {
    type: "object",
    properties: {
      selector: { type: "string", description: "ECharts 容器的 CSS 选择器" },
      eventType: { 
        type: "string", 
        enum: ["click", "dblclick", "mouseover", "mouseout"],
        description: "事件类型" 
      },
      componentType: { 
        type: "string", 
        enum: ["series", "xAxis", "yAxis", "radar", "geo", "title", "legend"],
        description: "ECharts 组件类型" 
      },
      name: { type: "string", description: "目标名称" },
      seriesIndex: { type: "number" },
      dataIndex: { type: "number" }
    },
    required: ["selector", "eventType", "componentType", "name"]
  }
}
```

#### Tool 5: `echarts_get_data` — 提取可视化数据

```typescript
{
  name: "echarts_get_data",
  description: "提取 ECharts 图表中的数据值，支持按系列或数据点查询",
  inputSchema: {
    type: "object",
    properties: {
      selector: { type: "string", description: "ECharts 容器的 CSS 选择器" },
      seriesIndex: { type: "number", description: "系列索引，省略则返回所有系列" },
      seriesName: { type: "string", description: "按名称匹配系列" }
    },
    required: ["selector"]
  }
}
```

### 6.3 实现架构建议

```
playwright-mcp/
├── src/
│   ├── tools/
│   │   ├── ...existing tools...
│   │   └── echarts.ts          ← 新增：ECharts 工具集
│   ├── helpers/
│   │   └── echarts-scripts.ts  ← 在页面中执行的 JS 脚本集合
│   └── ...
```

**关键实现模式**：所有 ECharts 操作都通过 `page.evaluate()` 注入执行：

```typescript
// helpers/echarts-scripts.ts
export const ECHARTS_HELPERS = `
  window.__playwright_echarts = {
    getInstance(selector) {
      const ec = window.echarts;
      if (!ec) throw new Error('ECharts not available');
      // 支持直接 selector 或 _echarts_instance_ 属性查找
      let container = document.querySelector(selector);
      if (!container) throw new Error('Container not found: ' + selector);
      // 如果选到的不是实例容器，向内/向上查找
      let instance = ec.getInstanceByDom(container);
      if (!instance) {
        const child = container.querySelector('[_echarts_instance_]');
        if (child) instance = ec.getInstanceByDom(child);
      }
      if (!instance) {
        let anc = container.parentElement;
        while (anc && anc !== document.body) {
          instance = ec.getInstanceByDom(anc);
          if (instance) break;
          anc = anc.parentElement;
        }
      }
      return instance;
    }
  };
`;

// tools/echarts.ts
import { Page } from 'playwright';

export async function ensureHelpers(page: Page) {
  await page.evaluate(ECHARTS_HELPERS);
}

export async function echartsDiscover(page: Page, scopeSelector?: string) {
  await ensureHelpers(page);
  return page.evaluate((scope) => {
    // ... discovery logic using window.__playwright_echarts.getInstance
  }, scopeSelector);
}
```

### 6.4 关键注意事项

1. **时序问题**：ECharts 实例在图表渲染完成后才可用。建议在调用 ECharts 工具前使用 `page.waitForFunction(() => !!window.echarts)` 或等待 Canvas 出现。

2. **多实例共存**：一个页面可能有多个 ECharts 图表。`echarts_discover` 工具应能列出所有实例，后续工具通过 `selector` 指定具体图表。

3. **动态渲染**：SPA 应用中图表可能随路由切换动态创建/销毁。工具应具备容错能力（实例不存在时返回明确错误）。

4. **React/Vue 封装**：如 `echarts-for-react`、`vue-echarts` 可能不暴露全局 `window.echarts`。此时需要：
   - 检查 Webpack `__webpack_modules__` 或 `__webpack_require__` 中是否有 echarts
   - 通过 React Fiber 遍历查找组件实例（参见上文策略 5）
   - 作为 fallback，注入一段代码扫描所有带 `_echarts_instance_` 属性的 DOM 元素

5. **数据序列化**：`getOption()` 返回的对象可能含循环引用或函数，需要在 `page.evaluate` 中做安全序列化（剔除函数、限制深度）。

6. **ECharts 版本差异**：
   - ECharts 4 的实例发现方式与 5 略有不同
   - `trigger` 在 ECharts 5 中稳定可用，ECharts 4 中可能需要使用 `bindbindbindec` 等内部属性
   - 建议用 `typeof instance.trigger === 'function'` 做能力检测

7. **与现有 Playwright 工具的协同**：
   - `echarts_discover` 可以在 `snapshot`（无障碍树快照）工具无法感知 Canvas 内容时作为补充
   - 可以考虑在 snapshot 工具的返回结果中，为 ECharts 容器注入额外语义信息（图表类型、系列名称等）

### 6.5 Playwright-MCP 集成方案

建议采用**工具插件**模式集成：

```typescript
// 在 MCP server 启动时注册 ECharts 工具
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    ...existingTools,
    // 仅在检测到页面包含 ECharts 时才暴露这些工具
    // 或者始终暴露，在执行时检测可用性
    echartsDiscoverTool,
    echartsActionTool,
    echartsGetOptionTool,
    echartsTriggerEventTool,
    echartsGetDataTool,
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  switch (name) {
    case 'echarts_discover':
      return await handleEchartsDiscover(page, args);
    case 'echarts_action':
      return await handleEchartsAction(page, args);
    // ...
  }
});
```

### 6.6 可扩展到其他图表库

同样的模式可以扩展到：

| 图表库 | 实例发现 | 交互 API | 数据读取 |
|--------|---------|---------|---------|
| **Highcharts** | `Highcharts.charts[]` | `chart.series[n].points[n].select()` | `chart.series[n].data` |
| **Plotly** | `document.querySelector('.plotly').__gd` | `Plotly.restyle()` / `Plotly.relayout()` | `gd.data` / `gd.layout` |
| **Chart.js** | `Chart.getChart(canvas)` | 无内置 action，需直接操作 data + `update()` | `chart.data` |
| **D3** | 无统一实例管理，但可通过 `__data__` 访问数据 | 需模拟 DOM 事件 | `selection.data()` |

建议将 ECharts 适配作为第一个实现，验证架构后再扩展到其他库。

---

## 7. 总结

| 技术要点 | 说明 |
|---------|------|
| **核心 API** | `echarts.getInstanceByDom()` + `instance.dispatchAction()` + `instance.trigger()` |
| **实例发现** | 5 种递进策略：全局对象 → `_echarts_instance_` 属性 → Canvas 回溯 → 祖先遍历 → React Fiber |
| **Canvas 识别** | `data-zr-dom-id` 属性是 ECharts Canvas 的标志 |
| **两种交互** | `dispatchAction` 操作图表 UI / `trigger` 触发业务回调 |
| **Playwright 优势** | `page.evaluate()` 可直接访问页面 JS 上下文，无需 VASI 那样的跨世界通信 |

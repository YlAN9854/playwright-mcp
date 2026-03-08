const { z } = require('playwright-core/lib/mcpBundle');

// Helper function to define a tool that operates on a browser tab
function defineTabTool(tool) {
  return {
    ...tool,
    handle: async (context, params, response) => {
      const tab = await context.ensureTab();
      const modalStates = tab.modalStates().map((state) => state.type);
      if (tool.clearsModalState && !modalStates.includes(tool.clearsModalState))
        response.addError(`Error: The tool "${tool.schema.name}" can only be used when there is related modal state present.`);
      else if (!tool.clearsModalState && modalStates.length)
        response.addError(`Error: Tool "${tool.schema.name}" does not handle the modal state.`);
      else
        return tool.handle(tab, params, response);
    }
  };
}

// ECharts Helper Scripts to be injected into the page
const ECHARTS_HELPERS = `
  window.__playwright_echarts = {
    // Helper to find instance from a DOM element using multiple strategies
    getInstance(selectorOrEl) {
      let container;
      if (typeof selectorOrEl === 'string') {
          container = document.querySelector(selectorOrEl);
          if (!container) return null; // Graceful fail if not found
      } else {
          container = selectorOrEl;
      }
      if (!container) return null;

      // Strategy 1: Global echarts object (Standard)
      const ec = window.echarts;
      if (ec && ec.getInstanceByDom) {
        // Try on the element itself
        let instance = ec.getInstanceByDom(container);
        if (instance) return instance;
        
        // Try on child with _echarts_instance_ attribute (common in wrappers)
        const child = container.querySelector('[_echarts_instance_]');
        if (child) {
            instance = ec.getInstanceByDom(child);
            if (instance) return instance;
        }

        // Try searching up (in case we selected an inner canvas or wrapper)
        let anc = container.parentElement;
        while (anc && anc !== document.body) {
           instance = ec.getInstanceByDom(anc);
           if (instance) return instance;
           anc = anc.parentElement;
        }
      }

      // Strategy 2: React Fiber (for echarts-for-react and similar wrappers)
      // If window.echarts is missing (modular import), we must find the instance via React internals
      
      // Locate the potential root of the chart
      let current = container;
      const child = container.querySelector('[_echarts_instance_]');
      if (child) current = child;

      // Helper to traverse Fiber tree
      const findInFiber = (node) => {
        const key = Object.keys(node).find(k => k.startsWith('__reactFiber$'));
        if (!key) return null;
        let fiber = node[key];
        
        // Traverse up the fiber tree (limit depth to avoid perf issues)
        for (let i = 0; i < 20 && fiber; i++) {
           const stateNode = fiber.stateNode;
           
           // Case A: Class Component (e.g. echarts-for-react)
           if (stateNode && typeof stateNode.getEchartsInstance === 'function') {
               return stateNode.getEchartsInstance();
           }

           // Case B: Functional Component with Ref (e.g. useRef hook)
           if (fiber.ref && fiber.ref.current) {
               if (typeof fiber.ref.current.getEchartsInstance === 'function') {
                   return fiber.ref.current.getEchartsInstance();
               }
               // Sometimes the ref IS the instance
               if (fiber.ref.current.setOption && fiber.ref.current.dispatchAction) {
                   return fiber.ref.current;
               }
           }
           
           fiber = fiber.return;
        }
        return null;
      };

      // Traverse DOM up to find the React Component boundary
      let el = current;
      while (el && el !== document.body) {
          const inst = findInFiber(el);
          if (inst) return inst;
          el = el.parentElement;
      }

      return null;
    },
    
    discover(scopeSelector) {
       const scope = scopeSelector ? document.querySelector(scopeSelector) : document.body;
       if (!scope) return { charts: [], error: 'Scope element not found' };

       // Find all elements that look like ECharts containers (marked by ECharts)
       const containers = Array.from(scope.querySelectorAll('[_echarts_instance_]'));
       
       const results = containers.map((container, idx) => {
           let instance;
           try {
               instance = this.getInstance(container);
           } catch (e) { return null; }
           
           if (!instance) return null;
           
           const option = instance.getOption() || {};
           const uid = container.getAttribute('_echarts_instance_');
           
           // Generate a robust selector
           let cssSelector;
           if (container.id) {
               cssSelector = '#' + container.id;
           } else if (uid) {
               cssSelector = \`[_echarts_instance_="\${uid}"]\`;
           } else {
               // Fallback path if no ID and no attribute (unlikely if we queried by attribute)
               // Use a unique path selector? Or add a temp attribute?
               // For now, assume _echarts_instance_ is present
               cssSelector = 'body'; 
           }
           
           return {
             index: idx,
             selector: cssSelector,
             id: container.id || null,
             chartTypes: [...new Set(option.series?.map(s => s.type) || [])],
             series: option.series?.map(s => ({ name: s.name, type: s.type, dataCount: s.data?.length })) || [],
             legends: option.legend?.flatMap(l => l.data || []) || [],
             radarIndicators: option.radar?.flatMap(r => (r.indicator || []).map(ind => ind.name)) || [],
             hasDataZoom: (option.dataZoom?.length || 0) > 0,
             title: option.title?.[0]?.text || null,
           };
       }).filter(Boolean);
       
       return { charts: results };
    },

    getOption(selector, paths) {
      const instance = this.getInstance(selector);
      if (!instance) throw new Error('ECharts instance not found for selector: ' + selector);
      
      const option = instance.getOption();
      if (!paths || paths.length === 0) {
        return option; 
      }
      const result = {};
      paths.forEach(path => {
        // Simple property access, could be enhanced for deep paths 'a.b.c'
        result[path] = option[path];
      });
      return result;
    },

    dispatchAction(selector, action) {
      const instance = this.getInstance(selector);
      if (!instance) throw new Error('ECharts instance not found for selector: ' + selector);
      instance.dispatchAction(action);
    },

    triggerEvent(selector, eventType, params) {
      const instance = this.getInstance(selector);
      if (!instance) throw new Error('ECharts instance not found for selector: ' + selector);

      const option = instance.getOption();
      const enrichedParams = Object.assign({}, params);

      // Auto-enrich params for radar components
      if (params.componentType === 'radar' && params.name != null) {
        const radarOpt = option.radar;
        if (radarOpt && radarOpt.length > 0) {
          const radar = radarOpt[0];
          const indicators = radar.indicator;
          if (indicators) {
            const idx = indicators.findIndex(function(ind) { return ind.name === params.name; });
            if (idx !== -1 && enrichedParams.dataIndex == null) {
              enrichedParams.dataIndex = idx;
            }
          }
        }
        if (enrichedParams.componentIndex == null) {
          enrichedParams.componentIndex = 0;
        }
      }

      // Auto-enrich series info
      if (option.series && option.series.length > 0) {
        const si = enrichedParams.seriesIndex != null ? enrichedParams.seriesIndex : 0;
        const s = option.series[si];
        if (s) {
          if (enrichedParams.seriesIndex == null) enrichedParams.seriesIndex = si;
          if (!enrichedParams.seriesName) enrichedParams.seriesName = s.name;
          if (!enrichedParams.seriesType) enrichedParams.seriesType = s.type;
        }
      }

      // Approach 1: Simulate real canvas mouse events for maximum compatibility
      // This goes through ZRender's full event pipeline (hit-testing, dispatching, etc.)
      let simulated = false;
      try {
        simulated = this.simulateCanvasClick(instance, selector, params);
      } catch (e) { /* fallback to trigger below */ }

      // Approach 2: Directly trigger event handlers registered via instance.on()
      if (!enrichedParams.event) {
        enrichedParams.event = { target: {} };
      }
      instance.trigger(eventType, enrichedParams);

      return { simulated: simulated };
    },

    /**
     * Simulate a real mouse click on the canvas at the calculated position of
     * the target element (e.g., radar indicator label). This goes through
     * ZRender's full event pipeline for maximum compatibility.
     */
    simulateCanvasClick(instance, selector, params) {
      if (params.componentType !== 'radar' || params.name == null) return false;

      const option = instance.getOption();
      const radarOpt = option.radar;
      if (!radarOpt || radarOpt.length === 0) return false;
      const radar = radarOpt[0];
      const indicators = radar.indicator;
      if (!indicators) return false;

      const idx = indicators.findIndex(function(ind) { return ind.name === params.name; });
      if (idx === -1) return false;

      const width = instance.getWidth();
      const height = instance.getHeight();

      function parsePct(v, total) {
        if (typeof v === 'number') return v;
        if (typeof v === 'string' && v.endsWith('%')) return parseFloat(v) / 100 * total;
        return parseFloat(v) || 0;
      }

      const centerArr = radar.center || ['50%', '50%'];
      const cx = parsePct(centerArr[0], width);
      const cy = parsePct(centerArr[1], height);

      let r;
      const radiusOpt = radar.radius;
      if (radiusOpt != null) {
        if (Array.isArray(radiusOpt)) {
          r = parsePct(radiusOpt[radiusOpt.length - 1], Math.min(width, height) / 2);
        } else {
          r = parsePct(radiusOpt, Math.min(width, height) / 2);
        }
      } else {
        r = Math.min(width, height) / 2 * 0.75;
      }

      const n = indicators.length;
      const startAngleDeg = radar.startAngle != null ? radar.startAngle : 90;
      const startAngle = startAngleDeg * Math.PI / 180;
      const angle = startAngle - (2 * Math.PI / n) * idx;

      const nameGap = radar.nameGap != null ? radar.nameGap : 15;
      const labelR = r + nameGap;

      const x = cx + labelR * Math.cos(angle);
      const y = cy - labelR * Math.sin(angle);

      // Find canvas element
      let container;
      if (typeof selector === 'string') {
        container = document.querySelector(selector);
      } else {
        container = selector;
      }
      if (!container) return false;

      let canvas;
      if (container.tagName === 'CANVAS') {
        canvas = container;
      } else {
        canvas = container.querySelector('canvas[data-zr-dom-id]') || container.querySelector('canvas');
      }
      if (!canvas) return false;

      // Dispatch real mouse events at the calculated position
      const rect = canvas.getBoundingClientRect();
      const evtTypes = ['mousemove', 'mousedown', 'mouseup', 'click'];
      for (let i = 0; i < evtTypes.length; i++) {
        const evt = new MouseEvent(evtTypes[i], {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + x,
          clientY: rect.top + y,
          view: window
        });
        canvas.dispatchEvent(evt);
      }

      return true;
    },

    getData(selector, seriesIndex, seriesName) {
      const instance = this.getInstance(selector);
      if (!instance) return null;
      const option = instance.getOption();
      let series = option.series || [];
      if (typeof seriesIndex === 'number') {
        series = [series[seriesIndex]];
      } else if (seriesName) {
        series = series.filter(s => s.name === seriesName);
      }
      return series.map(s => ({
        name: s.name,
        type: s.type,
        data: s.data
      }));
    }
  };
`;

async function ensureHelpers(page) {
  await page.evaluate(ECHARTS_HELPERS);
}

const echartsDiscover = defineTabTool({
  capability: 'core',
  schema: {
    name: 'echarts_discover',
    description: 'Discover all ECharts instances on the page',
    inputSchema: z.object({
      selector: z.string().optional().describe('Optional scope selector')
    }),
    type: 'input'
  },
  handle: async (tab, params, response) => {
    await ensureHelpers(tab.page);
    const result = await tab.page.evaluate((sel) => window.__playwright_echarts.discover(sel), params.selector);
    if (result.error) {
       response.addError(result.error);
       return;
    }
    response.addTextResult(JSON.stringify(result.charts, null, 2));
  }
});

const echartsGetOption = defineTabTool({
  capability: 'core',
  schema: {
    name: 'echarts_get_option',
    description: 'Get ECharts option',
    inputSchema: z.object({
      selector: z.string().describe('ECharts container selector'),
      paths: z.array(z.string()).optional().describe('Paths to extract from option')
    }),
    type: 'input'
  },
  handle: async (tab, params, response) => {
    await ensureHelpers(tab.page);
    try {
      const result = await tab.page.evaluate(({ selector, paths }) => 
        window.__playwright_echarts.getOption(selector, paths), params);
      response.addTextResult(JSON.stringify(result, null, 2));
    } catch (e) {
      response.addError(e.message);
    }
  }
});

const echartsAction = defineTabTool({
  capability: 'core',
  schema: {
    name: 'echarts_action',
    description: 'Dispatch ECharts action',
    inputSchema: z.object({
      selector: z.string().describe('ECharts container selector'),
      actionType: z.string().describe('Action type'),
      name: z.string().optional(),
      seriesIndex: z.number().optional(),
      dataIndex: z.number().optional(),
      start: z.number().optional(),
      end: z.number().optional()
    }),
    type: 'input'
  },
  handle: async (tab, params, response) => {
    await ensureHelpers(tab.page);
    try {
      await tab.page.evaluate(({ selector, actionType, ...rest }) => {
        const action = { type: actionType, ...rest };
        // Remove undefined keys
        Object.keys(action).forEach(key => action[key] === undefined && delete action[key]);
        window.__playwright_echarts.dispatchAction(selector, action);
      }, params);
      response.addTextResult('Action dispatched successfully');
    } catch (e) {
      response.addError(e.message);
    }
  }
});

const echartsTriggerEvent = defineTabTool({
  capability: 'core',
  schema: {
    name: 'echarts_trigger_event',
    description: 'Trigger ECharts event',
    inputSchema: z.object({
      selector: z.string().describe('ECharts container selector'),
      eventType: z.string().describe('Event type (click, etc.)'),
      componentType: z.string().describe('Component type'),
      name: z.string().optional(),
      seriesIndex: z.number().optional(),
      dataIndex: z.number().optional()
    }),
    type: 'input'
  },
  handle: async (tab, params, response) => {
    await ensureHelpers(tab.page);
    try {
      const result = await tab.page.evaluate(({ selector, eventType, ...rest }) => {
        // Remove undefined keys from params
        Object.keys(rest).forEach(key => rest[key] === undefined && delete rest[key]);
        return window.__playwright_echarts.triggerEvent(selector, eventType, rest);
      }, params);
      const detail = result?.simulated
        ? 'Event triggered successfully (canvas click simulated + event emitted)'
        : 'Event triggered successfully (event emitted)';
      response.addTextResult(detail);
    } catch (e) {
      response.addError(e.message);
    }
  }
});

const echartsGetData = defineTabTool({
  capability: 'core',
  schema: {
    name: 'echarts_get_data',
    description: 'Get data from ECharts',
    inputSchema: z.object({
      selector: z.string().describe('ECharts container selector'),
      seriesIndex: z.number().optional(),
      seriesName: z.string().optional()
    }),
    type: 'input'
  },
  handle: async (tab, params, response) => {
    await ensureHelpers(tab.page);
    try {
      const result = await tab.page.evaluate(({ selector, seriesIndex, seriesName }) => 
        window.__playwright_echarts.getData(selector, seriesIndex, seriesName), params);
      response.addTextResult(JSON.stringify(result, null, 2));
    } catch (e) {
      response.addError(e.message);
    }
  }
});

module.exports = [
  echartsDiscover,
  echartsGetOption,
  echartsAction,
  echartsTriggerEvent,
  echartsGetData
];

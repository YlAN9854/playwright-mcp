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
      instance.trigger(eventType, params);
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
      await tab.page.evaluate(({ selector, eventType, ...rest }) => {
        const eventParams = { ...rest, event: { target: {} } };
         // Remove undefined keys
        Object.keys(eventParams).forEach(key => eventParams[key] === undefined && delete eventParams[key]);
        window.__playwright_echarts.triggerEvent(selector, eventType, eventParams);
      }, params);
      response.addTextResult('Event triggered successfully');
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

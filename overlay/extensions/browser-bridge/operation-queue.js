/* SPDX-License-Identifier: AGPL-3.0-only */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MoriOperationQueue = api;
})(typeof globalThis === 'object' ? globalThis : this, function() {
  'use strict';
  function createQueue({ maxPriorityBurst = 3, maxPending = 192, maxPreparing = 8 } = {}) {
    let pending = [], running = false, scheduled = false, burst = 0, preparing = 0, preparationBurst = 0;
    let priorityOrder = [], normalOrder = [], resolveIdle = null;
    let idle = Promise.resolve();
    function startPreparations() {
      while (preparing < maxPreparing) {
        const seen = new Set(), waiting = [];
        for (const item of pending) {
          if (seen.has(item.key)) continue;
          seen.add(item.key);
          if (!item.ready && !item.preparing) waiting.push(item);
        }
        const priority = waiting.filter(i => i.priority), normal = waiting.filter(i => !i.priority);
        const urgent = priority.length && (!normal.length || preparationBurst < maxPriorityBurst);
        const item = (urgent ? priority : normal)[0];
        if (!item) return;
        preparationBurst = urgent ? preparationBurst + 1 : 0;
        item.preparing = true; preparing++;
        Promise.resolve().then(item.prepare).then(value => {
          item.value = value; item.ready = true;
        }, error => { item.error = error; item.failed = true; item.ready = true; }).finally(() => {
          preparing--; startPreparations(); pump();
        });
      }
    }
    function pump() {
      if (running || scheduled) return;
      scheduled = true;
      Promise.resolve().then(() => {
        scheduled = false;
        if (running) return;
        const seen = new Set(), heads = [];
        for (const item of pending) {
          if (seen.has(item.key)) continue;
          seen.add(item.key);
          if (item.ready) heads.push(item);
        }
        const priority = heads.filter(i => i.priority), normal = heads.filter(i => !i.priority);
        const usePriority = priority.length && (!normal.length || burst < maxPriorityBurst);
        const pool = usePriority ? priority : normal;
        if (!pool.length) {
          if (!pending.length && resolveIdle) { const resolve = resolveIdle; resolveIdle = null; resolve(); }
          return;
        }
        const pendingKeys = new Set(pending.map(i => i.key));
        priorityOrder = priorityOrder.filter(key => pendingKeys.has(key));
        normalOrder = normalOrder.filter(key => pendingKeys.has(key));
        const order = usePriority ? priorityOrder : normalOrder;
        for (const head of pool) if (!order.includes(head.key)) order.push(head.key);
        const item = order.map(key => pool.find(i => i.key === key)).find(Boolean);
        order.splice(order.indexOf(item.key), 1); order.push(item.key);
        if (usePriority) burst++;
        else burst = 0;
        pending.splice(pending.indexOf(item), 1); running = true;
        Promise.resolve().then(() => {
          if (item.failed) throw item.error;
          return item.operation(item.value);
        }).then(item.resolve, item.reject).finally(() => { running = false; startPreparations(); pump(); });
      });
    }
    function enqueue(operation, { key = 'mutation', priority = false, prepare } = {}) {
      if (pending.length + Number(running) >= maxPending)
        return Promise.reject(Object.assign(new Error('observer_queue_full'), { code: 'observer_queue_full' }));
      if (!resolveIdle) idle = new Promise(resolve => { resolveIdle = resolve; });
      let item;
      const result = new Promise((resolve, reject) => {
        item = { operation, key, priority, resolve, reject, prepare, ready: !prepare };
        // Reserve the per-tab position before asynchronous preparation starts.
        pending.push(item);
      });
      startPreparations();
      pump(); return result;
    }
    return { enqueue, whenIdle: () => idle };
  }
  return { createQueue };
});

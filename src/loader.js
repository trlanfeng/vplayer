import { fragmentDescriptor } from './common.js';

export function createFragmentLoader(scheduler) {
  return class CachedFragmentLoader {
    constructor() {
      this.context = null;
      this.stats = {
        aborted: false, loaded: 0, total: 0, retry: 0, chunkCount: 0, bwEstimate: 0,
        loading: { start: 0, first: 0, end: 0 }, parsing: { start: 0, end: 0 },
        buffering: { start: 0, first: 0, end: 0 },
      };
    }

    load(context, config, callbacks) {
      this.context = context;
      this.controller = new AbortController();
      this.stats.loading.start = performance.now();
      const item = fragmentDescriptor(context.part || context.frag) || { url: context.url, range: null };
      item.url = context.url;
      if (Number.isFinite(context.rangeStart) && Number.isFinite(context.rangeEnd) && context.rangeEnd > context.rangeStart) {
        item.range = [context.rangeStart, context.rangeEnd];
      }
      scheduler.request(item, this.controller.signal).then(result => {
        if (this.stats.aborted) return;
        const now = performance.now();
        this.stats.vplayerCached = result.cached;
        this.stats.loaded = this.stats.total = result.data.byteLength;
        this.stats.chunkCount = 1;
        this.stats.loading.first = this.stats.loading.start + Math.min(result.ttfb || 0, now - this.stats.loading.start);
        this.stats.loading.end = now;
        this.stats.bwEstimate = result.data.byteLength * 8000 / Math.max(result.duration, 1);
        // hls.js may transfer the ArrayBuffer to its worker. Never transfer the cached copy.
        callbacks.onSuccess({ url: result.url, data: result.data.slice(0) }, this.stats, context, null);
      }, error => {
        if (!this.stats.aborted) callbacks.onError({ code: error.status || 0, text: error.message }, context, null, this.stats);
      });
    }

    abort() { this.stats.aborted = true; this.controller?.abort(); }
    destroy() { this.abort(); this.context = null; }
  };
}

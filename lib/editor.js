import { commandName, unwrapProvider, wrapProvider } from "./ranking.js";

export function createFrequencyEditor(BaseEditor) {
  return class FrequencyEditor extends BaseEditor {
    constructor(tui, theme, keybindings, store, trackingTimeoutMs = 1000) {
      super(tui, theme, keybindings);
      this.store = store;
      this.trackingTimeoutMs = trackingTimeoutMs;
      this.commandProvider = undefined;
      this.pendingRecords = new Set();
      this.trackingGeneration = 0;
      this.controllers = new Set();
      this.dispatchDepth = 0;
      let submit = this.onSubmit;
      // Pi assigns this callback after constructing the editor. Intercept the
      // assignment rather than bypassing Pi's command dispatch or input events.
      Object.defineProperty(this, "onSubmit", {
        configurable: true,
        enumerable: true,
        get: () => {
          const callback = submit;
          return callback ? (text) => {
            if (this.dispatchDepth === 0) this.trackSubmission(text);
            this.dispatchDepth++;
            try { return callback(text); }
            finally { this.dispatchDepth--; }
          } : undefined;
        },
        set: (callback) => { submit = callback; },
      });
    }

    setAutocompleteProvider(provider) {
      this.commandProvider = provider ? unwrapProvider(provider) : undefined;
      super.setAutocompleteProvider(provider ? wrapProvider(provider, () => this.store.snapshot()) : provider);
    }

    trackSubmission(text) {
      const name = commandName(text);
      const provider = this.commandProvider;
      // Management commands do not affect the ranking they manage.
      if (!name || name === "command-frequency" || !provider) return;
      const time = Date.now();
      const generation = this.trackingGeneration;
      const controller = new AbortController();
      this.controllers.add(controller);
      let timer;
      // Bound validation even when a provider ignores cancellation. Dispatch is
      // immediate and timed-out requests can never publish a late usage record.
      const deadline = new Promise((done) => {
        controller.signal.addEventListener("abort", () => done(null), { once: true });
        timer = setTimeout(() => controller.abort(), this.trackingTimeoutMs);
      });
      const query = Promise.resolve().then(() => provider.getSuggestions(
        [`/${name}`], 0, name.length + 1, { signal: controller.signal },
      ));
      const pending = Promise.race([query, deadline]).then((result) => {
        if (!controller.signal.aborted && generation === this.trackingGeneration
          && result?.prefix === `/${name}` && result.items.some((item) => item.value === name)) {
          this.store.record(name, time);
        }
      }).catch(() => {}).finally(() => {
        clearTimeout(timer);
        this.controllers.delete(controller);
        this.pendingRecords.delete(pending);
      });
      this.pendingRecords.add(pending);
    }

    cancelTracking() {
      this.trackingGeneration++;
      for (const controller of this.controllers) controller.abort();
    }

    async flushTracking() { await Promise.allSettled([...this.pendingRecords]); }
  };
}

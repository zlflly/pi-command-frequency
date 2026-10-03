export function commandName(text) {
  if (typeof text !== "string" || /[\r\n]/u.test(text)) return null;
  const match = /^\/([^\s/]+)(?:[ \t].*)?$/u.exec(text.trim());
  const name = match?.[1];
  return validName(name) ? name : null;
}

export function validName(name) {
  return typeof name === "string" && /^[\p{L}\p{N}_:.+-]{1,128}$/u.test(name);
}

function matchTier(name, query) {
  if (!query) return 0;
  const names = [name.toLowerCase()];
  if (name.startsWith("skill:")) names.push(name.slice(6).toLowerCase());
  if (names.includes(query)) return 0;
  return names.some((candidate) => candidate.startsWith(query)) ? 1 : 2;
}

// Never add/remove matches. Keep the original fuzzy order as the final tie-break.
export function rankItems(items, usage, query = "") {
  query = query.toLowerCase();
  return items.map((item, index) => ({ item, index })).sort((a, b) => {
    const left = usage.get(a.item.value);
    const right = usage.get(b.item.value);
    return matchTier(a.item.value, query) - matchTier(b.item.value, query)
      || (right?.count ?? 0) - (left?.count ?? 0)
      || (right?.lastUsed ?? 0) - (left?.lastUsed ?? 0)
      || a.index - b.index;
  }).map(({ item }) => item);
}

const originals = new WeakMap();
export function unwrapProvider(provider) {
  return originals.get(provider) ?? provider;
}

// A transparent wrapper: all other methods, including optional/future methods,
// execute with the original provider as `this` (important for private fields).
export function wrapProvider(provider, getUsage) {
  provider = unwrapProvider(provider);
  // Proxy a facade, not the provider itself: frozen/nonconfigurable provider
  // methods cannot legally be replaced by a get trap on their own object.
  const wrapped = new Proxy(Object.create(null), {
    has: (_target, key) => key in provider,
    ownKeys: () => Reflect.ownKeys(provider),
    getPrototypeOf: () => Object.getPrototypeOf(provider),
    getOwnPropertyDescriptor: (_target, key) => {
      const descriptor = Object.getOwnPropertyDescriptor(provider, key);
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
    get(_target, key) {
      const target = provider;
      if (key === "getSuggestions") {
        return async (lines, cursorLine, cursorCol, options = {}) => {
          const result = await target.getSuggestions(lines, cursorLine, cursorCol, options);
          const prefix = (lines[cursorLine] ?? "").slice(0, cursorCol).trimStart();
          if (!result || cursorLine !== 0 || options.force
            || !/^\/[^\s/]*$/u.test(prefix) || result.prefix !== prefix) return result;
          return { ...result, items: rankItems(result.items, getUsage(), prefix.slice(1)) };
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  originals.set(wrapped, provider);
  return wrapped;
}

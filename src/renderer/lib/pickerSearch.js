// Options and catalogs are immutable snapshots. A replacement array invalidates its weakly held index;
// no timer or catalog hash can keep old labels/types alive after a refresh.
const indexes = new WeakMap();

/** Preserve the two existing search contracts: one substring per field, or AND terms in joined fields. */
export function filterPickerItems(items, query, mode = 'terms') {
  const normalized = mode === 'substring' ? query.trim().toLowerCase() : query.trim().toLocaleLowerCase();
  if (!normalized) return items;
  let index = indexes.get(items);
  if (!index) { index = {}; indexes.set(items, index); }
  const terms = mode === 'terms' ? normalized.split(/\s+/) : null;
  const matches = text => mode === 'substring' ? text.some(part => part.includes(normalized)) : terms.every(term => text.includes(term));
  if (!index[mode]) {
    const text = [], result = [];
    for (const item of items) {
      const entry = mode === 'substring' ? [item.label, item.meta, item.searchText].map(part => String(part || '').toLowerCase())
        : [item.label, item.meta, item.searchText].join(' ').toLocaleLowerCase();
      text.push(entry); if (matches(entry)) result.push(item);
    }
    index[mode] = text;
    return result;
  }
  return items.filter((_item, position) => matches(index[mode][position]));
}

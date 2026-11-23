const EPSILON = 1e-9;

export interface IntervalPolicy {
  start: number;
  end: number;
  maxVel?: number;
  maxAccel?: number;
  maxDecel?: number;
  maxAngVel?: number;
  maxAngAccel?: number;
  rotationPriority?: "heading" | "translation";
}

interface IndexedPolicy extends IntervalPolicy {
  first: number;
  last: number;
}

interface HeapEntry {
  value: number;
  last: number;
}

function lowerBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function upperBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function pushHeap(heap: HeapEntry[], entry: HeapEntry): void {
  let index = heap.length;
  heap.push(entry);
  while (index > 0) {
    const parent = (index - 1) >>> 1;
    if (heap[parent].value <= entry.value) break;
    heap[index] = heap[parent];
    index = parent;
  }
  heap[index] = entry;
}

function popHeap(heap: HeapEntry[]): void {
  const tail = heap.pop();
  if (heap.length === 0 || tail == null) return;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    if (left >= heap.length) break;
    const right = left + 1;
    const child = right < heap.length && heap[right].value < heap[left].value ? right : left;
    if (heap[child].value >= tail.value) break;
    heap[index] = heap[child];
    index = child;
  }
  heap[index] = tail;
}

function minimums(policies: readonly IndexedPolicy[], count: number, key: keyof IntervalPolicy, offset: number): Float64Array {
  const result = new Float64Array(count + offset).fill(Infinity);
  const heap: HeapEntry[] = [];
  let policyIndex = 0;
  for (let interval = 0; interval < count; interval += 1) {
    while (policyIndex < policies.length && policies[policyIndex].first <= interval) {
      const policy = policies[policyIndex];
      const value = policy[key];
      if (typeof value === "number" && value > 0) pushHeap(heap, { value, last: policy.last });
      policyIndex += 1;
    }
    while (heap[0]?.last < interval) popHeap(heap);
    if (heap.length > 0) result[interval + offset] = heap[0].value;
  }
  return result;
}

/** Indexes inclusive interval overlap and heading-priority policy in O((samples + policies) log policies). */
export function indexIntervalPolicies(
  fractions: readonly number[],
  ranges: readonly IntervalPolicy[],
  transitions: readonly IntervalPolicy[] = [],
) {
  const count = Math.max(0, fractions.length - 1);
  const toIndexed = (policy: IntervalPolicy): IndexedPolicy | null => {
    const start = Math.min(policy.start, policy.end);
    const end = Math.max(policy.start, policy.end);
    const first = Math.max(0, lowerBound(fractions, start - EPSILON) - 1);
    const last = Math.min(count - 1, upperBound(fractions, end + EPSILON) - 1);
    return first <= last ? { ...policy, first, last } : null;
  };
  const indexedRanges = ranges.map(toIndexed).filter((policy): policy is IndexedPolicy => policy != null)
    .sort((a, b) => a.first - b.first);
  const indexedTransitions = transitions.map(toIndexed).filter((policy): policy is IndexedPolicy => policy != null);
  const active = new Int32Array(count + 1);
  const heading = new Int32Array(count + 1);
  const transition = new Int32Array(count + 1);
  const headingTransition = new Int32Array(count + 1);
  const addPolicy = (policy: IndexedPolicy, isTransition: boolean) => {
    active[policy.first] += 1;
    active[policy.last + 1] -= 1;
    if (policy.rotationPriority !== "translation") {
      heading[policy.first] += 1;
      heading[policy.last + 1] -= 1;
    }
    if (isTransition) {
      transition[policy.first] += 1;
      transition[policy.last + 1] -= 1;
      if (policy.rotationPriority !== "translation") {
        headingTransition[policy.first] += 1;
        headingTransition[policy.last + 1] -= 1;
      }
    }
  };
  indexedRanges.forEach((policy) => addPolicy(policy, false));
  indexedTransitions.forEach((policy) => addPolicy(policy, true));

  const translationPriority = new Array<boolean>(count + 1).fill(false);
  const activeTranslationPriority = new Array<boolean>(count + 1).fill(false);
  let activeCount = 0;
  let headingCount = 0;
  let transitionCount = 0;
  let headingTransitionCount = 0;
  let transitionFollowing = false;
  for (let interval = 0; interval < count; interval += 1) {
    activeCount += active[interval];
    headingCount += heading[interval];
    transitionCount += transition[interval];
    headingTransitionCount += headingTransition[interval];
    if (transitionCount > 0) transitionFollowing = headingTransitionCount === 0;
    activeTranslationPriority[interval + 1] = activeCount > 0 && headingCount === 0;
    translationPriority[interval + 1] = activeCount > 0 ? activeTranslationPriority[interval + 1] : transitionFollowing;
  }

  return {
    maxVel: minimums(indexedRanges, count, "maxVel", 1),
    maxAccel: minimums(indexedRanges, count, "maxAccel", 1),
    maxDecel: minimums(indexedRanges, count, "maxDecel", 1),
    maxAngVel: minimums(indexedRanges, count, "maxAngVel", 1),
    maxAngAccel: minimums(indexedRanges, count, "maxAngAccel", 1),
    activeTranslationPriority,
    translationPriority,
  };
}

/** Indexes the range limits active at each exact sample fraction. */
export function indexPointPolicies(fractions: readonly number[], ranges: readonly IntervalPolicy[]) {
  const indexedRanges = ranges.map((policy): IndexedPolicy | null => {
    const start = Math.min(policy.start, policy.end);
    const end = Math.max(policy.start, policy.end);
    const first = lowerBound(fractions, start - EPSILON);
    const last = upperBound(fractions, end + EPSILON) - 1;
    return first <= last ? { ...policy, first, last } : null;
  }).filter((policy): policy is IndexedPolicy => policy != null).sort((a, b) => a.first - b.first);
  return {
    maxVel: minimums(indexedRanges, fractions.length, "maxVel", 0),
    maxAccel: minimums(indexedRanges, fractions.length, "maxAccel", 0),
    maxDecel: minimums(indexedRanges, fractions.length, "maxDecel", 0),
  };
}

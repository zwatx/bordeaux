import type { PlannerInput } from "../types";

/**
 * Remembers the last few results of a pure step by a string that holds every
 * value the step reads. Callers that hand a remembered result to code outside
 * the planners must copy it first: a remembered object is shared.
 */
export function rememberByKey<Result>(capacity: number): (key: string, compute: () => Result) => Result {
  const remembered = new Map<string, Result>();
  return (key, compute) => {
    const hit = remembered.get(key);
    if (hit !== undefined) {
      // Refresh recency.
      remembered.delete(key);
      remembered.set(key, hit);
      return hit;
    }
    const result = compute();
    remembered.set(key, result);
    if (remembered.size > capacity) remembered.delete(remembered.keys().next().value!);
    return result;
  };
}

/**
 * Remembers the last few results of a pure planning step by the content of its
 * input. Final and route planning plan the same curve several times in a row: as
 * the Normal baseline, inside the optimized planner, and again when a route is
 * qualified. Each of those then shares one solve.
 *
 * The step runs on a private copy of the input. A result can hold parts of its
 * input, such as a marker's command invocation, and the caller may change its
 * own input after planning; the remembered result must still match its key.
 */
export function rememberByInput<Result>(capacity: number, compute: (input: PlannerInput) => Result): (input: PlannerInput) => Result {
  const remember = rememberByKey<Result>(capacity);
  // An accepted trajectory on the path can hold thousands of samples, which costs
  // more to key than a cache hit saves on the interactive path.
  return (input) => input.path.optimization ? compute(input) : remember(JSON.stringify(input), () => compute(structuredClone(input)));
}

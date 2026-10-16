import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // CPU-bound planner files and their nested workers share one test-file slot.
    maxWorkers: 1,
    // Local .scratch/, work/, and example trees carry their own archived tests.
    include: ["tests/**/*.test.?(c|m)[jt]s?(x)"],
  },
});

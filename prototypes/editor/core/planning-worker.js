import { planPath } from "../../../src/shared/planners/planPath";

self.onmessage = ({ data }) => {
  if (data.inputs) {
    self.postMessage({ id: data.id, statuses: data.inputs.map((input) => planPath(input).status) });
  } else {
    self.postMessage({ id: data.id, result: planPath(data.input) });
  }
};

import { Canvas } from "./canvas/index.jsx";
import { Strip } from "./strip/index.jsx";
import { Workbench } from "./workbench/index.jsx";
import { Hybrid } from "./hybrid/index.jsx";
export const VARIANTS = [
  { name: "Canvas", component: Canvas, pickerPosition: "raised" },
  { name: "Strip", component: Strip, pickerPosition: "above-strip" },
  { name: "Workbench", component: Workbench, pickerPosition: "raised" },
  { name: "Hybrid", component: Hybrid, pickerPosition: "top-right" },
];

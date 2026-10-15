// Solo mount of the Workbench variant (verification only, while other variants are mid-edit), mirroring the harness chrome.
import { createRoot } from "react-dom/client";
import "../../core/core.css";
import "../../picker.css";
import { Workbench } from "./index.jsx";

createRoot(document.getElementById("root")).render(<>
  <Workbench />
  <div className="proto-sim-tag">Prototype · robot push is simulated</div>
  <nav className="proto-picker" aria-label="Prototype variants">
    {["Canvas", "Strip", "Workbench"].map((n, i) => <button key={n} className="proto-picker-item" data-active={i === 2 ? "" : undefined}>{n}</button>)}
  </nav>
</>);

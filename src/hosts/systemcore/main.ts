// Browser entry for the SystemCore build: installs the robot host, then starts the same renderer the desktop runs.
import { createSystemcoreHost } from "./webHost";

window.bordeauxAPI = createSystemcoreHost();
await import("../../renderer/main");

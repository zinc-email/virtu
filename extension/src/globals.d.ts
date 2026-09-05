// Build-time constants (bin/extension-build passes them with `bun build
// --define`) and the shape of the shell object the popup shim installs.

/** Origin of the deployment this build talks to, e.g. "https://zinc.email". */
declare const VIRTU_API_ORIGIN: string;

// Text imports: content.css rides inside content.js (bun's text loader) so
// the menu's styles land in its shadow root, not on the host page.
declare module "*.css" {
  const text: string;
  export default text;
}

// Mirror of the seam's VirtuShell (client/src/shell.ts) — the contract is
// client/src/shell.md, and the extension can't import client code (no
// workspaces; extension/contract/ pins the two together instead).
interface VirtuShell {
  platform: "ios" | "android" | "extension";
  shellVersion: string;
  protocol: number;
  apiOrigin?: string;
  request(message: string): Promise<string>;
}

interface Window {
  virtuShell?: VirtuShell;
}

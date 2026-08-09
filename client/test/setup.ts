// Bun-test preload: unmount React trees between tests so each *.dom.test.tsx
// starts from a clean document. Loaded after happydom.ts (bunfig.toml), so the
// DOM already exists when @testing-library/react is imported here.

import { afterEach } from "bun:test";
import { cleanup } from "@testing-library/react";

afterEach(cleanup);

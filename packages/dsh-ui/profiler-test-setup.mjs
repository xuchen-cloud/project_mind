// Must run before src/test/setup.ts imports ReactDOM: this enables React 19's
// browser DEV UserTiming gate without changing application profiling behavior.
import { vi } from 'vitest';
Object.defineProperty(performance, 'measure', { configurable: true, value: vi.fn() });
Object.defineProperty(console, 'timeStamp', { configurable: true, value: vi.fn() });
globalThis.__dshProfilerTest = true;

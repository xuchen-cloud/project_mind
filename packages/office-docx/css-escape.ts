// Standards polyfill for upstream's CSS.escape calls in the Node engine.
// Injected by esbuild; upstream sources remain byte-for-byte unchanged.
import cssEscape from 'css.escape';
export { cssEscape };

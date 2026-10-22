# Pinned DSH runtime license supplements

`stage-dsh-runtime.mjs` uses these inputs only for its explicitly listed
package/version/SPDX tuples when the npm archive has no root license file.
The source package and production lockfile remain unchanged. Supplemental texts
are included in `DSH-THIRD-PARTY-NOTICES.txt` and its integrity inventory.
`sources.json` records the source and SHA-256 of every retained external text.
Preparation never fetches license texts.

## Source verification

The following npm release metadata supplied the upstream `gitHead` used to
retrieve original license notices. The repository's DSH lockfile pins the npm
archives, including their integrity values.

| Packages | Version | Upstream revision | Treatment |
| --- | --- | --- | --- |
| `@earendil-works/pi-ai`, `@earendil-works/pi-telemetry` | 0.87.1 | `f07218c4d4bbc12bef056a7058c3dd49dfe41abe` | Original MIT notice with Mario Zechner attribution. |
| `@xterm/headless`, `@xterm/addon-serialize` | 6.0.0 / 0.14.0 | `f447274f430fd22513f6adbf9862d19524471c04` | Original MIT notice with xterm.js and individual author attributions. |
| `@img/sharp-libvips-*` | 1.3.4 | `ebb95f8add54eee8bed840e3fb587e4cbec857d7` | Runtime LGPL-3.0-or-later declaration, package README and upstream third-party notices; LGPL and GPL reference texts. The build repository's Apache LICENSE is not substituted for the runtime license. |

`@koromix/koffi-*` 3.1.1 uses the unmodified `LICENSE.txt` from the pinned
`koffi@3.1.1` npm archive. The three AWS supplements reuse this repository's
complete Apache-2.0 text for `credential-provider-http@3.972.75`,
`credential-provider-login@3.972.80` and `nested-clients@3.997.47`.

## Explicit SPDX reference fallback

All SPDX reference texts come from `spdx/license-list-data` revision
`31ba1a50e5397e00a304dbadc76531740e89ee48`. Unknown package/version tuples or
mismatched SPDX declarations cannot use this fallback; missing notices fail.

## Removed Office converter

The local pinned Web manifest omits the disabled converter dependency; all
original patch rows remain, and the desktop overlay still disables Office-to-PDF.
The install graph and shipped runtime contain no LibreOffice engine. Its former nested-notice collector was removed with that
dependency, along with unused brotli/dfa/fontkit/saxes supplement code and texts.
The Web bundle's original MIT license remains in its vendor directory
and generated notices; see `packages/dsh-assistant/vendor/dsh-web-app/provenance.json`.

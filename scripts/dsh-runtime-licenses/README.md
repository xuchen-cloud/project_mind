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
| `saxes` | 6.0.0 | `211fa0ebec9b628affc09219199639887174bfc3` | Original ISC notice, including contributors' notices. |
| `@img/sharp-libvips-*` | 1.3.4 | `ebb95f8add54eee8bed840e3fb587e4cbec857d7` | Runtime LGPL-3.0-or-later declaration, package README and upstream third-party notices; LGPL and GPL reference texts. The build repository's Apache LICENSE is not substituted for the runtime license. |

`@koromix/koffi-*` 3.1.1 uses the unmodified `LICENSE.txt` from the pinned
`koffi@3.1.1` npm archive. The three AWS supplements reuse this repository's
complete Apache-2.0 text for `credential-provider-http@3.972.75`,
`credential-provider-login@3.972.80` and `nested-clients@3.997.47`.

## Explicit SPDX reference fallback

`brotli@1.3.3`, `dfa@1.2.0` and `fontkit@2.0.4` publish MIT declarations in both
package metadata and README, but omit a full MIT notice. Their release revisions
are respectively `e36051345f6d27a56e5f39ea70d2f789b8574046`,
`3f5e603e5082caedabefefdf53e8a6ca3111e966`, and
`fbf3b9ef21eebd219eb73e666faed573af0fba09`; those repository snapshots also lack
root license files. For these exact releases, retain the published declaration,
author and repository metadata and the canonical SPDX MIT reference text.
The template's copyright placeholders are explicitly labeled as reference text;
no copyright year or rights holder is invented. `brotli` additionally retains
the Google 2013 Apache-2.0 decoder notice from `dec/decode.js` and full Apache
text. The original decoder notices remain present in every staged source file.

All SPDX reference texts come from `spdx/license-list-data` revision
`31ba1a50e5397e00a304dbadc76531740e89ee48`. Unknown package/version tuples or
mismatched SPDX declarations cannot use this fallback; missing notices fail.

## LibreOffice's existing notices

The pinned `@deepseek-ai/libreoffice-kit` platform packages at 0.1.5 declare
MPL-2.0 and already ship their notices. The collector includes every regular file
in `licenses/` (MPL, DeepSeek MIT, third-party HTML), plus `LICENSE` and `NOTICE`
in the engine's published program directory. The release also retains the
original licenses and sources inside the dependency tree. No generic MPL
substitute is used.

# Backend utility license supplements

`boolbase@1.0.0` declares ISC in its npm package metadata but its published archive does not contain the copyright and permission notice. The build includes the upstream author's complete notice from [revision 54811f01c797a6bb1c263183ae90b7dd627e0638](https://github.com/fb55/boolbase/blob/54811f01c797a6bb1c263183ae90b7dd627e0638/LICENSE).

The retained file is `boolbase-1.0.0.LICENSE`, SHA-256 `cdf4d87ae0a6c160227263bf4e39a0a10e30e89ae7256e0f7ac7bde0836552c6`. The supplement is restricted to this exact package name, version and declared license. Other missing license files fail the worker build.

The DSH production tree has further npm archives that declare a license but omit its text. `record-worker-notices.mjs` permits the following supplements only for the listed package/version/license combinations; all other missing notices fail preparation. The supplements are committed, so packaging does not fetch license text from moving branches.

| Retained file | Applies to | Source | SHA-256 |
| --- | --- | --- | --- |
| `aws-sdk-js-v3.LICENSE` | Apache-2.0: `@aws-sdk/credential-provider-http@3.972.72`, `@aws-sdk/credential-provider-login@3.972.77`, `@aws-sdk/nested-clients@3.997.44` | [AWS SDK repository LICENSE at 0317bb822abed1302aaae350a8bbfa40f60ef32d](https://github.com/aws/aws-sdk-js-v3/blob/0317bb822abed1302aaae350a8bbfa40f60ef32d/LICENSE) | `edea91454b811f127fbdea3d86f378f6719bd372ed440abf82b232f6fca06c3d` |
| `proxy-agent-negotiate-1.1.0.LICENSE` | MIT: `proxy-agent-negotiate@1.1.0` (same repository and author as `https-proxy-agent`) | [proxy-agents https-proxy-agent LICENSE at 4813885d3f4e2ff837878ceffdba656a71dc31f0](https://github.com/TooTallNate/proxy-agents/blob/4813885d3f4e2ff837878ceffdba656a71dc31f0/packages/https-proxy-agent/LICENSE) | `8d8c55319c7729d57be811c747452636688d54f19701ee0752b6b15ad3771d9a` |
| `standardwebhooks-1.1.1.LICENSE` | MIT: `standardwebhooks@1.1.1` | [Standard Webhooks libraries LICENSE at npm release gitHead b4d2c14fc5b4ccff3ff271e3b087dff812254c59](https://github.com/standard-webhooks/standard-webhooks/blob/b4d2c14fc5b4ccff3ff271e3b087dff812254c59/libraries/LICENSE) | `5ec8c7b26b64d881a6706617bed25c049f97f2f35de034c756de8546fd6dbe27` |

`data-uri-to-buffer@4.0.1` publishes its complete MIT notice in `README.md`; the generator extracts that section.

# DSH Office browser Remote

Pinned `@deepseek-ai/dsh-office-to-pdf@0.2.0-rc.2` browser contribution, retained byte-for-byte with its supporting declarations and MIT license. `provenance.json` records the published archive identity and every copied file hash.

The local manifest exposes only `/remote` and declaration-only `/types`. It has no converter implementation and no LibreOffice dependency. The official DSH remotes component continues to mount this contribution. The desktop Host converter remains disabled by the pre-existing overlay; this package does not provide or simulate that service.

On upgrades, re-copy and verify the exact upstream files, update provenance, and run the DSH UI integrity and browser closure checks. Office operation/preview boundaries are documented in `../dsh-assistant/README.md`.

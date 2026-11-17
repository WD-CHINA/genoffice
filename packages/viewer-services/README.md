# Viewer-owned services

Viewer-only snapshots of GenOffice's original font, shaping, media and decryption
helpers, extracted from commit `4863835963c99793c47b72473900c483e9fa0c2a` and
refreshed against `ac19c54111849d9d8fb2c508223a0389b805c247`.
Existing apps and packages remain unchanged. `sources.json` records the inputs
and the commit the copies were last synced from.

PPT font/measurement state runs in one Node Worker per view session. Browser
width feedback is exposed through read-only measurement batches. HTML altChunk
uses the original html2docx PlaywrightDriver contract; Chrome lookup additionally
accepts VIEWER_CHROME_PATH. The original Electron driver is not imported.

The Viewer bundles these sources and required pure engines into its own output.

The current upstream baseline is `v0.13.18`. New font-rule, table-layout and
pagination modules are included with their transitive resources. Viewer-specific
changes remain explicit adapters; see `docs/upstream-v0.13.18-migration.zh-CN.md`.

# Viewer-owned services

Viewer-only snapshots of GenOffice's original font, shaping, media and decryption
helpers, extracted from commit `4863835963c99793c47b72473900c483e9fa0c2a` and
refreshed against `8c170596b6c2a5fc92a858dfd6f064c7762d835e`.
Existing apps and packages remain unchanged. `sources.json` records the inputs
and the commit the copies were last synced from.

PPT font/measurement state runs in one Node Worker per view session. Browser
width feedback is exposed through read-only measurement batches. HTML altChunk
uses the original html2docx PlaywrightDriver contract; Chrome lookup additionally
accepts VIEWER_CHROME_PATH. The original Electron driver is not imported.

The Viewer bundles these sources and required pure engines into its own output.

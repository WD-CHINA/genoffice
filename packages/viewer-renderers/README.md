# Viewer-owned renderers

Original drawing and pagination sources extracted from GenOffice commit
`4863835963c99793c47b72473900c483e9fa0c2a` and refreshed against
`8c170596b6c2a5fc92a858dfd6f064c7762d835e`, owned exclusively by `apps/viewer`.
Existing desktop applications continue importing their original files.
`sources.json` and `docs-sources.json` record the extraction inputs and the
commit the copies were last synced from.

Core SlideThumb/NodeBody/ChartBody/animation, PdfPage/LinkLayer and pure Word
pagination algorithms are retained byte-for-byte. PaginationPreview has Viewer-only
measurement/settling callbacks and sanitized interactive reading snapshots. Viewer adapters inject read-only
slide data, locale events, PDF disabled controls, document initialization and
layout inputs. The document controller calls the original per-block layout functions
before snapshotting; PDF search, outline and saved note threads use original modules.
PreviewMediaLayer follows the original App native player overlay;
ShowMediaLayer reports resource/decoder errors and stops detached players. Desktop image-copy hooks are optional; the AI queue extension is
not registered. Type-only editor contracts do not activate editing or AI services.

The package is source input for the Viewer bundler, not a standalone Node runtime.
The bundled runtime does not require this source directory. Keep upstream fixes
explicit: adapt the snapshot here and verify against original fixtures without
editing existing consumers. Full visual acceptance remains in the Viewer plan.

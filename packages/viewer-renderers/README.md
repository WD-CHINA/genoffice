# Viewer-owned renderers

Original drawing and pagination sources extracted from GenOffice commit
`4863835963c99793c47b72473900c483e9fa0c2a` and refreshed against
`ac19c54111849d9d8fb2c508223a0389b805c247`, owned exclusively by `apps/viewer`.
Existing desktop applications continue importing their original files.
`sources.json` and `docs-sources.json` record the extraction inputs and the
commit the copies were last synced from.

Core SlideThumb/NodeBody/ChartBody/animation, PDF and pure Word
pagination algorithms retain the upstream implementation. The Viewer PDF page
renderer additionally reports local failures; link overlays ignore failed annotations, and page probing and auxiliary scans
support cancellation and unreadable pages. PaginationPreview has Viewer-only
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

The current upstream baseline is `v0.13.18`. New font-rule, table-layout and
pagination modules are included with their transitive resources. Viewer-specific
changes remain explicit adapters; see `docs/upstream-v0.13.18-migration.zh-CN.md`.

PDF geometry and read-only forms are loaded per requested page. The Viewer uses
an adaptive resident pixel budget, a two-task render queue, and explicit canvas,
text-layer and page cleanup. Full-text outline generation is opt-in. These are
private Viewer adaptations, covered by `test:pdf-isolation` and `test:pdf-runtime`.

Project policy: port suitable main-application implementations first; add private
logic only for missing or incompatible behavior. Record the source and concrete
adaptation reason; see `docs/viewer-porting-rules.zh-CN.md`.

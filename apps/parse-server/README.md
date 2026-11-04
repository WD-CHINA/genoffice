# @genoffice/parse-server

Standalone document parse service for the GenOffice Viewer. v1 parses **PPTX / PDF**; DOCX and XLSX are out of scope (see `docs/parse-backend-architecture.zh-CN.md`).

This is the first vertical slice: content-addressed uploads, Range reads, the versioned contract, and an in-process PPTX session API. The Viewer remote provider is wired for PPTX (MVP).

## Run

```sh
# from the repo root
npm run dev -w @genoffice/parse-server
# -> http://127.0.0.1:8787 (data: ./.parse-server-data)
```

Environment:

| Variable                        | Default              | Meaning                                                             |
| ------------------------------- | -------------------- | ------------------------------------------------------------------- |
| `PARSE_SERVER_PORT`             | `8787`               | Listen port                                                         |
| `PARSE_SERVER_HOST`             | `127.0.0.1`          | Bind address; keep loopback unless behind a proxy                   |
| `PARSE_SERVER_DATA_DIR`         | `.parse-server-data` | Content store, metadata and temp uploads                            |
| `PARSE_SERVER_TOKEN`            | unset                | When set, non-public routes require `Authorization: Bearer <token>` |
| `PARSE_SERVER_ALLOWED_ORIGINS`  | empty                | Comma-separated CORS allowlist                                      |
| `PARSE_SERVER_MAX_UPLOAD_BYTES` | 2 GiB                | Upload cap                                                          |

## API (v1)

```text
GET    /v1/health                     {ok, parserVersion}
GET    /v1/capabilities               contract + formats (pptx/pdf) + limits
POST   /v1/files                      stream an upload -> {fileId,sha256,size,format}
GET    /v1/files/:id                  metadata
GET    /v1/files/:id/content          Range/ETag/HEAD
GET    /v1/files/:id/parts/:partPath  one OOXML part (media, charts, …)
DELETE /v1/files/:id

POST   /v1/sessions                   {fileId,width?} -> 201 {sessionId,state,model}
GET    /v1/sessions/:id               {state,model}
GET    /v1/sessions/:id/units         slide summaries (cursor/limit)
GET    /v1/sessions/:id/units/:unitId {slide,playback,measurements}
POST   /v1/sessions/:id/text-widths  {widths:[{key,width}]} -> remaining measurements
GET    /v1/sessions/:id/fonts/:fontId embedded font bytes (sfnt)
DELETE /v1/sessions/:id
```

Uploads are streamed to a temp file while hashing, then moved to `files/<sha256[0:2]>/<sha256>`; nothing holds a whole document in memory. `GET .../content` supports a single byte range, `ETag`, `Accept-Ranges` and `HEAD`.

## Tests

```sh
npm run test -w @genoffice/parse-server
npm run typecheck -w @genoffice/parse-server
```

## 1 GB upload smoke

```sh
# terminal 1
PARSE_SERVER_PORT=8799 PARSE_SERVER_DATA_DIR=/tmp/parse-server-data \
  node --import tsx src/bin.ts

# terminal 2
node scripts/upload-smoke.mjs --url http://127.0.0.1:8799 --size 1G --pid <server-pid>
```

The script streams a sparse file (with a PDF header so the sniffer accepts it) and reports throughput plus the server's peak RSS. On a local loopback run: ~867 MB/s and ~103 MB peak RSS, i.e. the upload path does not buffer the file.

## Viewer remote mode (MVP)

The Viewer can upload a PPTX and render the server-built slides. Serve the Viewer dev site with the server URL and the server with the Viewer origin allowed:

```sh
# terminal 1: parse server
PARSE_SERVER_ALLOWED_ORIGINS=http://localhost:11001 \
  npm run dev -w @genoffice/parse-server

# terminal 2: viewer (same-origin /v1 proxy -> parse-server)
PARSE_SERVER_URL=http://127.0.0.1:8787 npm run dev -w @genoffice/viewer
# open: http://localhost:11001/?parse=server&fileId=<fileId>
```

The Viewer dev server proxies `/v1` to `PARSE_SERVER_URL` (default `http://127.0.0.1:8787`), so the normal URL only needs `?parse=server&fileId=<fileId>`; no `server=` parameter. The file bar then shows a `解析位置：自动 / 本地 / 服务端` switch. If the server requires a token, pass `&token=<token>` in the Viewer URL. For a production static build, put the same `/v1` reverse proxy in front of the Viewer. Auto sends PPTX/PDF over 64 MiB to the server and keeps smaller files local; DOCX over 32 MiB fails with an explicit message. Server mode supports PPTX (session API) and PDF (the Viewer hands PDF.js the Range-capable `GET /v1/files/:id/content` URL); DOCX stays local.

### How a large PPTX avoids the memory blow-up

1. The upload is streamed to a content-addressed file; nothing is buffered.
2. `slimPptxFile` reads the central directory with `@genoffice/zip-reader`, copies every **non-media** part into a stored-only zip, and leaves `ppt/media/*` on disk. The parser (`openPptx`) only ever sees that slim archive, capped by `maxParseBytes` (default 256 MiB of XML parts, not the original file).
3. Slide render trees reference media through absolute `GET /v1/files/:id/parts/:partPath` URLs; the browser fetches each image when the slide needs it.

Local measurement: a 256 MiB deck (blank slide + 256 MiB stored media) opens a session in ~22 ms and adds ~0.5 MiB RSS (the media is never inflated). A 1 GiB upload alone has been measured at ~867 MB/s with ~103 MiB peak RSS.

### Fonts

The session advertises the deck's embedded fonts (`ppt/fonts/*.fntdata`) and serves each sfnt via `GET /v1/sessions/:id/fonts/:fontId`. The Viewer loads those plus its bundled metric-compatible faces (Carlito/Caladea/Liberation/Noto) before measuring text widths, so server-rendered slides use the same fonts as local mode. Some very old embedded fonts are rejected by Chromium's OTS sanitizer; the Viewer logs an OTS warning and keeps the fallback for those faces.

### Text width feedback

The server builds each slide with heuristic metrics and returns the run widths the browser should measure (`measurements`). The Viewer measures them on a canvas and posts them back; the server accepts the widths, invalidates its cached render trees and returns the remaining measurements. The same loop runs for the first slide, lazily loaded slides and the pre-slideshow preload.

Remaining MVP limits: stored PPTX media parts support Range, deflated parts still return whole; the first paint uses heuristic metrics until the browser widths arrive. In token mode the server signs content/part URLs (`?exp=&sig=`), so `<img>`, `<video>` and PDF.js can fetch them without an Authorization header; `GET /v1/files/:id/content-url` returns the signed PDF URL. The Viewer opens the first slide only and loads other slides on demand (page navigation, visible thumbnails); starting a slideshow preloads the remaining slides first.

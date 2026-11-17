# Validation runtime only. The desktop node_modules directory is never copied.
ARG BASE_IMAGE=node:22-bookworm-slim
FROM ${BASE_IMAGE}
WORKDIR /workspace
RUN printf '{"private":true,"type":"module"}\n' > package.json \
 && npm install --legacy-peer-deps --ignore-scripts --no-audit --no-fund --save-exact \
    tsx@4.23.15 vitest@4.1.12 mysql2@3.24.6 jszip@3.10.2 \
    fast-xml-parser@5.12.1 utif2@4.1.0 opentype.js@2.0.0 bidi-js@1.0.3 \
 && mkdir -p node_modules/@genoffice
COPY tsconfig.base.json ./
COPY pnpm-lock.yaml ./
COPY apps/parse-server ./apps/parse-server
COPY packages/pptx-engine ./packages/pptx-engine
COPY packages/pptx-render ./packages/pptx-render
COPY packages/docx-engine ./packages/docx-engine
COPY packages/font-metrics/package.json ./packages/font-metrics/package.json
COPY packages/font-metrics/src ./packages/font-metrics/src
COPY packages/font-metrics/measurements ./packages/font-metrics/measurements
COPY packages/font-metrics/word-faces.json ./packages/font-metrics/word-faces.json
COPY packages/viewer-services/src ./packages/viewer-services/src
COPY packages/parse-contract ./packages/parse-contract
COPY packages/zip-reader ./packages/zip-reader
COPY packages/zip-gate ./packages/zip-gate
COPY packages/agent-core ./packages/agent-core
COPY packages/ui/src/fonts ./packages/ui/src/fonts
RUN for package in pptx-engine pptx-render docx-engine parse-contract zip-reader zip-gate agent-core font-metrics; do \
      ln -s ../../packages/$package node_modules/@genoffice/$package; \
    done
WORKDIR /workspace/apps/parse-server
CMD ["node", "--import", "tsx", "src/bin.ts"]

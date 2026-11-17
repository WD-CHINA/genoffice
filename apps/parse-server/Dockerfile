# Build from the repository root. FFmpeg is part of the server runtime, not the browser bundle.
FROM node:22-bookworm-slim
RUN apt-get -o Acquire::Retries=3 update \
 && apt-get -o Acquire::Retries=3 install -y --no-install-recommends ca-certificates \
 && sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
 && apt-get -o Acquire::Retries=3 update \
 && apt-get -o Acquire::Retries=3 install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
RUN printf '{"private":true,"type":"module"}\n' > package.json \
 && npm install --legacy-peer-deps --ignore-scripts --no-audit --no-fund --save-exact \
    tsx@4.23.15 mysql2@3.24.6 jszip@3.10.2 fast-xml-parser@5.12.1 \
    utif2@4.1.0 opentype.js@2.0.0 bidi-js@1.0.3 \
 && mkdir -p node_modules/@genoffice
COPY tsconfig.base.json pnpm-lock.yaml ./
COPY apps/parse-server/package.json apps/parse-server/tsconfig.json ./apps/parse-server/
COPY apps/parse-server/src ./apps/parse-server/src
COPY packages/pptx-engine/package.json ./packages/pptx-engine/package.json
COPY packages/pptx-engine/src ./packages/pptx-engine/src
COPY packages/pptx-render/package.json ./packages/pptx-render/package.json
COPY packages/pptx-render/src ./packages/pptx-render/src
COPY packages/docx-engine/package.json ./packages/docx-engine/package.json
COPY packages/docx-engine/src ./packages/docx-engine/src
COPY packages/font-metrics/package.json ./packages/font-metrics/package.json
COPY packages/font-metrics/src ./packages/font-metrics/src
COPY packages/font-metrics/measurements ./packages/font-metrics/measurements
COPY packages/font-metrics/word-faces.json ./packages/font-metrics/word-faces.json
COPY packages/viewer-services/src ./packages/viewer-services/src
COPY packages/parse-contract ./packages/parse-contract
COPY packages/zip-reader ./packages/zip-reader
COPY packages/zip-gate ./packages/zip-gate
COPY packages/agent-core/package.json ./packages/agent-core/package.json
COPY packages/agent-core/src ./packages/agent-core/src
COPY packages/ui/src/fonts ./packages/ui/src/fonts
RUN for package in pptx-engine pptx-render docx-engine parse-contract zip-reader zip-gate agent-core font-metrics; do \
      ln -s ../../packages/$package node_modules/@genoffice/$package; \
    done \
 && chmod -R a+rX /workspace \
 && mkdir -p /data && chown node:node /data \
 && ffmpeg -hide_banner -encoders 2>/dev/null | grep -q libx264
ENV PARSE_SERVER_HOST=0.0.0.0 PARSE_SERVER_DATA_DIR=/data
USER node
WORKDIR /workspace/apps/parse-server
EXPOSE 8787
CMD ["node", "--import", "tsx", "src/bin.ts"]

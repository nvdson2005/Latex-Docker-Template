FROM node:22-bookworm-slim AS build
WORKDIR /opt/editor
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS texlab
ARG TARGETARCH
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) arch=x86_64; checksum=8697bd5e479d4584b14b7eed5c320c80ec4e1d91ebefbb6801e6bf38e9971300 ;; \
      arm64) arch=aarch64; checksum=a85cdfcd22454b8d8550f4b0f0620c45ab51760f302fac7a12bc18a890f70f8c ;; \
      *) exit 1 ;; \
    esac; \
    apt-get update && apt-get install -y --no-install-recommends curl ca-certificates; \
    curl -fsSL --retry 3 "https://github.com/latex-lsp/texlab/releases/download/v5.26.0/texlab-${arch}-linux.tar.gz" -o /tmp/texlab.tar.gz; \
    echo "$checksum  /tmp/texlab.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/texlab.tar.gz -C /tmp texlab

FROM texlive/texlive:latest
COPY --from=texlab /tmp/texlab /usr/local/bin/texlab
WORKDIR /opt/editor
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build /opt/editor/package.json ./
COPY --from=build /opt/editor/node_modules ./node_modules
COPY --from=build /opt/editor/dist ./dist
COPY entrypoint.sh /usr/local/bin/editor-entrypoint
ENTRYPOINT ["/bin/sh", "/usr/local/bin/editor-entrypoint"]
CMD ["node", "dist/server/index.js"]

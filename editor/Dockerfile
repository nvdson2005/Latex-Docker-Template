FROM node:22-bookworm-slim AS build
WORKDIR /opt/editor
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM texlive/texlive:latest
WORKDIR /opt/editor
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build /opt/editor/package.json ./
COPY --from=build /opt/editor/node_modules ./node_modules
COPY --from=build /opt/editor/dist ./dist
COPY entrypoint.sh /usr/local/bin/editor-entrypoint
ENTRYPOINT ["/bin/sh", "/usr/local/bin/editor-entrypoint"]
CMD ["node", "dist/server/index.js"]

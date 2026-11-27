# CSI Workspace — single image serving API + built client.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.server.json tsconfig.client.json vite.config.ts ./
COPY scripts ./scripts
COPY server ./server
COPY client ./client
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=4000 DATABASE_PATH=/data/csi-workspace.db
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/dist-client ./dist-client
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN mkdir -p /data && chown node:node /data
# Starts as root only to fix ownership of the mounted data disk, then drops to the "node" user.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
VOLUME ["/data"]
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "dist-server/server/index.js"]

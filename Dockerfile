# Multi-stage build: compile TypeScript in a full node image, run the
# result on a slim one. Produces one image used for both the API server
# and the worker — select which with the container command (see
# docker-compose.yml / DEPLOYMENT.md).

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY public ./public
COPY data ./data

EXPOSE 3000

# Default: run the API server. Override the command to `node dist/worker.js`
# for the worker service, or `node dist/scripts/migrate.js` to run migrations
# — see docker-compose.yml.
CMD ["node", "dist/server.js"]

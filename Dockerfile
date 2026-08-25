# Build the daemon and the dashboard, then ship only what is needed to run them.
FROM node:22-alpine AS build
WORKDIR /app

# Dependencies first, so edits to source do not invalidate the install layer. The workspace
# manifests are part of that: npm needs them to resolve the @tdb/* links.
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/server/package.json ./packages/server/
COPY packages/daemon/package.json ./packages/daemon/
RUN npm ci
COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix web ci

COPY tsconfig.json tsconfig.base.json ./
COPY packages ./packages
RUN npm run build

COPY web ./web
RUN npm --prefix web run build


FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/server/package.json ./packages/server/
COPY packages/daemon/package.json ./packages/daemon/
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/daemon/dist ./packages/daemon/dist
COPY --from=build /app/web/dist ./web/dist

# Runtime state lives on a volume so credentials survive rebuilds.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 4400

# Binding to 0.0.0.0 is required for the port to be reachable from outside the
# container. What is actually exposed is decided by the port mapping in compose,
# which publishes to 127.0.0.1 by default.
CMD ["node", "packages/daemon/dist/index.js", \
     "--web", "--web-addr", "0.0.0.0:4400", \
     "--config", "/data/config.json", \
     "--auth", "/data/auth.json", \
     "--steam", "/data/steam.json", \
     "--state", "/data/state.json", \
     "--claims", "/data/claims.json"]

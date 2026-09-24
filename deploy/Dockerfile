# One image with the API and both built frontends. The same image runs as
# the customer/worker app (SERVE_FRONTEND=web) and the admin panel
# (SERVE_FRONTEND=admin). Multi-arch base: works on x86 and ARM (Oracle
# Ampere). Build context: the repository root.

FROM node:22-bookworm-slim AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-bookworm-slim AS admin
WORKDIR /src/admin
COPY admin/package.json admin/package-lock.json ./
RUN npm ci
COPY admin/ ./
RUN npm run build

FROM node:22-bookworm-slim AS api-deps
# Toolchain in case a native module (argon2) has no prebuilt binary for this CPU.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=api-deps /app/backend/node_modules backend/node_modules
COPY backend/package.json backend/
COPY backend/src backend/src
COPY --from=web /src/web/dist web/dist
COPY --from=admin /src/admin/dist admin/dist
# Never run as root.
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "backend/src/server.js"]

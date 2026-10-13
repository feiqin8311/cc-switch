# CC Switch Enterprise: server + admin console in one image.
# Build:  docker build -t ccse ./enterprise
FROM node:24-slim AS base
RUN npm install -g pnpm@10.12.3
WORKDIR /app

# ---- build the admin console -------------------------------------------------
FROM base AS admin-build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY contracts/package.json contracts/
COPY server/package.json server/
COPY admin/package.json admin/
RUN pnpm install --frozen-lockfile --filter "@ccse/admin..."
COPY tsconfig.base.json ./
COPY contracts contracts
COPY admin admin
RUN pnpm --filter @ccse/admin build

# ---- runtime: server (TypeScript runs natively on Node 24) ------------------
FROM base AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000 \
    DATA_DIR=/data \
    ADMIN_DIST_DIR=/app/admin/dist
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY contracts/package.json contracts/
COPY server/package.json server/
COPY admin/package.json admin/
RUN pnpm install --frozen-lockfile --prod --filter "@ccse/server..."
COPY contracts contracts
COPY server/src server/src
COPY server/drizzle server/drizzle
COPY server/package.json server/package.json
COPY --from=admin-build /app/admin/dist admin/dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/src/index.ts"]

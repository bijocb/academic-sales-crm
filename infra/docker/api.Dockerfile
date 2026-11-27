# API image (NestJS + Prisma). Build from the repository root:
#   docker build -f infra/docker/api.Dockerfile .
FROM node:22.21-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @crm/api...
COPY packages/contracts packages/contracts
COPY apps/api apps/api
COPY infra/docker/api-start.sh infra/docker/api-start.sh
RUN pnpm --filter @crm/contracts build && pnpm --filter @crm/api build
ENV NODE_ENV=production
EXPOSE 8080
CMD ["bash", "infra/docker/api-start.sh"]

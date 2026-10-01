FROM node:20-alpine

WORKDIR /app

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY .npmrc package.json pnpm-lock.yaml* ./
RUN pnpm install --no-frozen-lockfile

COPY . .
RUN pnpm build

ENV PORT=3000
ENV PROOF_DATA_DIR=/app/data
EXPOSE 3000

# 单进程：同时提供 /api 规则校对服务与 dist/ 静态资源
CMD ["node", "server/index.js"]

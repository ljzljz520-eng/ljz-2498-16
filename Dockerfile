FROM node:20-alpine

WORKDIR /app

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV PORT=8787

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY .npmrc package.json pnpm-lock.yaml* ./
RUN pnpm install --no-frozen-lockfile

COPY . .

# 生产构建：随后由零依赖 Node 服务同源托管页面与校对 API
RUN pnpm build

EXPOSE 8787

CMD ["node", "server/http.js"]

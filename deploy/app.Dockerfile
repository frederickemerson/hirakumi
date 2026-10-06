FROM node:22-bookworm-slim
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
ARG APP_DIR
ENV APP_DIR=${APP_DIR} NODE_ENV=production
CMD ["sh", "-c", "exec pnpm -C \"$APP_DIR\" start"]

# syntax=docker/dockerfile:1
FROM node:24.12.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run build

FROM node:24.12.0-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist/src ./dist/src
# Mount points for the data directory and the dedicated Pi state area. A new named volume inherits
# this ownership and mode, so the unprivileged user can write without running as root.
RUN mkdir -p /data /var/lib/natsumi-pi \
  && chown node:node /data /var/lib/natsumi-pi \
  && chmod 700 /data /var/lib/natsumi-pi
USER node
ENTRYPOINT ["node", "/app/dist/src/server/main.js"]
CMD ["serve", "--config", "/etc/natsumi/config.json", "--data-dir", "/data"]

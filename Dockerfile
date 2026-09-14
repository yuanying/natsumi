# syntax=docker/dockerfile:1
FROM node:24.12.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run build

# Holds the network namespace of the fixed-IPv6 layout (compose.ipv6.example.yaml) and sets the interface token.
# Only this image carries iproute2, and only its container gets NET_ADMIN. Built on the same base to share layers.
FROM node:24.12.0-bookworm-slim AS ipv6-netns
RUN apt-get update \
  && apt-get install -y --no-install-recommends iproute2 \
  && rm -rf /var/lib/apt/lists/*
COPY --chmod=755 docker/ipv6-netns.sh /usr/local/bin/natsumi-ipv6-netns
ENTRYPOINT ["natsumi-ipv6-netns"]

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
# 8443: HTTPS with certificate files. 443 and 80: HTTPS and the ACME challenge listener (ADR 0007).
EXPOSE 8443 443 80
ENTRYPOINT ["node", "/app/dist/src/server/main.js"]
CMD ["serve", "--config", "/etc/natsumi/config.json", "--data-dir", "/data"]

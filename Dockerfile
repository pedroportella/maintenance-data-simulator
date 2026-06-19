# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22.18.0

FROM node:${NODE_VERSION}-bookworm-slim AS dependencies
WORKDIR /workspace

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM dependencies AS test
COPY src ./src
COPY schemas ./schemas
COPY scenarios ./scenarios
COPY scripts ./scripts
COPY tests ./tests
RUN node --test

FROM test AS runtime-files
RUN mkdir -p /runtime/scripts \
  && cp package.json /runtime/package.json \
  && cp -R node_modules /runtime/node_modules \
  && cp -R src /runtime/src \
  && cp -R schemas /runtime/schemas \
  && cp scripts/simulator.mjs /runtime/scripts/simulator.mjs \
  && cp scripts/api-scenario-smoke.mjs /runtime/scripts/api-scenario-smoke.mjs

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app

ARG VCS_REF=local
ARG BUILD_DATE=unknown

ENV NODE_ENV=production

LABEL org.opencontainers.image.title="maintenance-data-simulator" \
  org.opencontainers.image.description="Synthetic source-system simulator runner for maintenance planning review workflows" \
  org.opencontainers.image.revision="${VCS_REF}" \
  org.opencontainers.image.created="${BUILD_DATE}"

RUN groupadd --gid 10001 simulator \
  && useradd --uid 10001 --gid 10001 --home-dir /app --shell /usr/sbin/nologin simulator \
  && chown -R 10001:10001 /app

COPY --from=runtime-files --chown=10001:10001 /runtime/ /app/

USER 10001:10001

ENTRYPOINT ["node", "/app/scripts/simulator.mjs"]
CMD ["--help"]

# NuraVolt web app + seed toolchain.
#
# One image serves two roles in docker-compose: the `web` service builds the
# Next.js app and runs it, and the same image runs the synthetic demo seed
# (scripts/seed_local_demo.sh) before the server starts, which needs the
# Python analytics package for the twin/soiling/BESS generators.
#
#   docker compose up            # db + web (seeded) + agent
#
# Build-time env holds syntactically valid placeholders only; real values are
# injected at runtime from .env.docker / the compose file.

FROM node:22-bookworm-slim AS base
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip python3-venv build-essential libpq-dev curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ---- Python analytics package (seed generators, twins, BESS engine) ----
FROM base AS python-deps
COPY pyproject.toml setup.py README.md ./
COPY nuravolt ./nuravolt
RUN python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
 && /opt/venv/bin/pip install --no-cache-dir -e . psycopg2-binary python-dotenv

# ---- Node dependencies ----
FROM base AS node-deps
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund

# ---- Next.js production build ----
FROM base AS build
COPY --from=node-deps /app/node_modules ./node_modules
COPY . .
ENV NODE_OPTIONS=--max-old-space-size=8192 \
    NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_URL=postgresql://build:build@localhost:5432/build \
    BETTER_AUTH_SECRET=build-only-placeholder-secret-0123456789abcdef \
    RESEND_API_KEY=re_build_placeholder \
    NEXT_PUBLIC_SITE_URL=http://localhost:3000 \
    NEXT_PUBLIC_APP_URL=http://localhost:3000
RUN npx prisma generate && npx next build

# ---- Runtime ----
FROM base AS runtime
ENV NODE_ENV=production \
    PATH=/opt/venv/bin:$PATH \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_OPTIONS=--max-http-header-size=32768
COPY --from=python-deps /opt/venv /opt/venv
COPY --from=build /app /app
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --retries=20 --start-period=60s \
  CMD curl -fsS http://localhost:3000/sign-in > /dev/null || exit 1
CMD ["node", "server.js"]

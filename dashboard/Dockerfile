FROM node:20-alpine AS base

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci

# ADAPTER_INTERNAL_URL is baked into rewrites() at build time.
# Pass it as a build arg so the proxy points at the right container hostname.
ARG ADAPTER_INTERNAL_URL=http://localhost:8001
ENV ADAPTER_INTERNAL_URL=$ADAPTER_INTERNAL_URL

# Default INR→USD rate pre-filled in the billing console. NEXT_PUBLIC_ values
# are inlined into the browser bundle at build time, so this must be a build
# arg. It is a public default, never a secret.
ARG NEXT_PUBLIC_DEFAULT_USD_INR_RATE=0.0112
ENV NEXT_PUBLIC_DEFAULT_USD_INR_RATE=$NEXT_PUBLIC_DEFAULT_USD_INR_RATE

# Build
COPY . .
RUN npm run build

# Production image
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

COPY --from=base /app/.next/standalone ./
COPY --from=base /app/.next/static ./.next/static
COPY --from=base /app/public ./public

EXPOSE 3001

ENV PORT=3001
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]

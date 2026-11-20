FROM mcr.microsoft.com/playwright:v1.50.1-noble

WORKDIR /app

# Install dependencies first for Docker layer caching
COPY package.json package-lock.json* ./
RUN npm install

# Copy TypeScript source and build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune devDependencies after build to slim image runtime
RUN npm prune --omit=dev

ENV NODE_ENV=production
ENV PORT=3090
ENV MAX_CONCURRENCY=2
ENV PAGE_TIMEOUT_MS=15000

EXPOSE 3090

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3090) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/index.js"]

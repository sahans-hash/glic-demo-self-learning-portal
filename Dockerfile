FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public ./public

# data.json / settings.json are written here at runtime — mount a volume
# over /app/data if you want them to survive container replacement.
RUN mkdir -p /app/data && chown -R node:node /app/data
ENV DATA_DIR=/app/data

ENV PORT=4100
EXPOSE 4100

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 4100) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

USER node

CMD ["node", "server.js"]

FROM node:18-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --include=optional
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:18-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --include=optional && npm cache clean --force
COPY --from=builder /app/dist/ ./dist/
RUN mkdir -p /home/node/.relayplane && \
    chown -R node:node /home/node/.relayplane
USER node
EXPOSE 4801
ENV RELAYPLANE_PROXY_HOST=0.0.0.0
ENV RELAYPLANE_PROXY_PORT=4801
ENTRYPOINT ["node", "dist/cli.js"]

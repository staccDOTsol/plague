FROM node:22-bookworm-slim
WORKDIR /app/backend
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY backend/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY backend/src ./src
COPY frontend /app/frontend
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node", "src/hook-market-server.js"]

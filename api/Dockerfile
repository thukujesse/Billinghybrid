# Multi-stage build for the JTM billing API
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY api/package.json ./api/package.json
COPY web/package.json ./web/package.json
RUN npm ci
COPY api ./api
RUN npm run build --workspace api

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/api/package.json ./api/package.json
COPY --from=build /app/api/dist ./api/dist
WORKDIR /app/api
EXPOSE 4000
# Apply migrations, then start the API.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/server.js"]

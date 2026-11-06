FROM node:24-bookworm-slim AS build

WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /usr/src/app/dist ./dist
COPY welcomepic.png ./welcomepic.png

# Bothost keeps persistent data in /app/data.
RUN mkdir -p /app/data
ENV DATABASE_PATH=/app/data/support.db
ENV BANNER_PATH=/usr/src/app/welcomepic.png

EXPOSE 3000
CMD ["node", "dist/index.js"]

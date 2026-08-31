# ---- Étape 1 : build ----
FROM node:20-slim AS build
WORKDIR /app

# OpenSSL requis par le moteur Prisma sur les images Debian slim
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json tsconfig.seed.json ./
COPY src ./src
RUN npm run build

# ---- Étape 2 : image de production ----
FROM node:20-slim AS production
WORKDIR /app

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev

COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-seed ./dist-seed
COPY prisma ./prisma

EXPOSE 4000
CMD ["node", "dist/index.js"]

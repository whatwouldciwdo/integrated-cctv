FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY index.html vite.config.js ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY package*.json ./
COPY server ./server
COPY --from=build /app/dist ./dist
RUN npm ci --omit=dev && chown -R node:node /app
USER node
EXPOSE 8080
CMD ["node", "server/index.js"]
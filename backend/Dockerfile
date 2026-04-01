FROM node:22-alpine

WORKDIR /app

COPY package.json package.json
RUN npm install

COPY tsconfig.json tsconfig.json
COPY src src
COPY sql sql

RUN npm run build

EXPOSE 4000

CMD ["sh", "-c", "npm run migrate && npm run seed && node dist/server.js"]


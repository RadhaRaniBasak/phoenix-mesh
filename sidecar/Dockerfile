
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev

COPY agent.js ./


ENV NODE_ENV=production


EXPOSE 9090
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s \
  CMD wget -qO- http://localhost:9090/status || exit 1

USER node

CMD ["node", "agent.js"]

FROM node:24-alpine

ARG APP_VERSION=development

LABEL org.opencontainers.image.title="Nodelight"
LABEL org.opencontainers.image.description="A lightweight dashboard for a headless Ubuntu server"
LABEL org.opencontainers.image.version="${APP_VERSION}"

WORKDIR /app

COPY --chown=node:node package.json server.js ./
COPY --chown=node:node web ./web
COPY --chown=node:node tests ./tests

RUN apk add --no-cache smartmontools tzdata

RUN node --test tests/*.test.js

RUN mkdir /data && chown node:node /data

ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION} \
    PORT=8080 \
    HOST_PROC=/host/proc \
    HOST_SYS=/host/sys \
    HOST_ETC=/host/etc \
    HOST_ROOT=/host/root \
    DATA_DIR=/data

USER node
EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "server.js"]

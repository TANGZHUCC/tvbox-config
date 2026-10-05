FROM node:22-alpine

WORKDIR /app

COPY server.mjs ./server.mjs
COPY library.json ./library.json

ENV PORT=19999
ENV HOST=0.0.0.0
ENV NODE_ENV=production

EXPOSE 19999

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||19999)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7860 \
    SPREADSHEET_SERVER_TRUST_PROXY=true \
    SPREADSHEET_SERVER_FRAME_ANCESTORS=https://huggingface.co \
    SPREADSHEET_AUTH_SECURE_COOKIES=true \
    SPREADSHEET_AUTH_SAME_SITE=none
COPY --from=build --chown=1000:1000 /app /app
USER 1000
EXPOSE 7860
CMD ["node", "server/main.ts"]

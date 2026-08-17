FROM mcr.microsoft.com/playwright:v1.62.1-noble

ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PORT=3000 \
    ARTIFACT_DIR=/artifacts

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && find /ms-playwright -mindepth 1 -maxdepth 1 -type d \
       \( -name 'firefox-*' -o -name 'webkit-*' \) -exec rm -rf {} +

COPY src ./src
RUN mkdir -p /artifacts \
    && chown -R pwuser:pwuser /app /artifacts

USER pwuser
EXPOSE 3000

CMD ["node", "src/server.js"]

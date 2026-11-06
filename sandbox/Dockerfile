FROM mcr.microsoft.com/playwright:v1.64.1-noble
WORKDIR /opt/verify
RUN npm init -y >/dev/null && npm install --no-audit --no-fund playwright@1.64.1 && npm cache clean --force
COPY runner.mjs netguard.mjs ./
ENV CI=1 EXPO_OFFLINE=1 EXPO_NO_TELEMETRY=1 EXPO_UNSTABLE_HEADLESS=1 NODE_PATH=/opt/verify/node_modules
WORKDIR /app
CMD ["sleep", "infinity"]

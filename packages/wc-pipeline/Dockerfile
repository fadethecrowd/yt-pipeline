FROM node:22-slim
RUN apt-get update \
 && apt-get install -y ffmpeg fontconfig \
 && rm -rf /var/lib/apt/lists/*

# Install Bebas Neue display font for thumbnail SVG rendering.
RUN mkdir -p /usr/share/fonts/truetype/custom
COPY assets/fonts/BebasNeue-Regular.ttf /usr/share/fonts/truetype/custom/
RUN fc-cache -f -v

WORKDIR /app
COPY package*.json ./
COPY packages/pipeline-core/package.json ./packages/pipeline-core/
COPY packages/wc-pipeline/package.json ./packages/wc-pipeline/
COPY prisma ./prisma/
RUN npm ci --workspace=packages/pipeline-core --workspace=packages/wc-pipeline --include-workspace-root
COPY packages/pipeline-core ./packages/pipeline-core/
COPY packages/wc-pipeline ./packages/wc-pipeline/
RUN npm run build --workspace=packages/pipeline-core && npm run build --workspace=packages/wc-pipeline
RUN npx prisma generate
CMD ["node", "packages/wc-pipeline/dist/index.js"]

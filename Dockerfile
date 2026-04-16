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
COPY prisma ./prisma/
RUN npm ci
COPY . .
RUN npm run build
CMD ["npm", "run", "start"]

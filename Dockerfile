FROM node:18-bullseye

RUN apt-get update && apt-get install -y \
    ffmpeg \
    fonts-roboto \
    fonts-noto-color-emoji \
    fontconfig \
    && fc-cache -fv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["npm", "start"]

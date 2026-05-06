# Friend's Fix: Upgrading to Node 20 / Bookworm
FROM node:20-bookworm

RUN apt-get -o Acquire::Retries=3 update && \
    apt-get -o Acquire::Retries=3 install -y \
    ffmpeg \
    fonts-roboto \
    fonts-noto-color-emoji \
    fontconfig \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    pkg-config \
    && fc-cache -fv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install

# THE MASTER FIX: Force canvas to recompile against the Bookworm color emoji libraries!
RUN npm rebuild canvas --build-from-source

COPY . .
EXPOSE 3000
CMD ["npm", "start"]

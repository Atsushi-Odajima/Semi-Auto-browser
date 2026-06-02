FROM mcr.microsoft.com/playwright:v1.60.0-noble

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src
COPY public ./public
COPY README.md ./

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001
CMD ["npm", "start"]

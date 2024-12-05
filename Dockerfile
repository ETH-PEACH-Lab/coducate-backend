FROM --platform=linux/amd64 node:22.11.0-bookworm-slim

WORKDIR /usr/src/coducate-backend

COPY package.json ./

COPY package-lock.json ./

RUN npm install

COPY . .

CMD ["npm", "start"]

EXPOSE 1234

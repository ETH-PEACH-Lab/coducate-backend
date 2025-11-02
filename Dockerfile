FROM node:25-alpine3.22

WORKDIR /usr/src/coducate-backend

RUN apk update && apk add --no-cache mariadb-client bash ca-certificates wget && \
    wget https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -O /usr/local/share/ca-certificates/rds-global-bundle.pem && \
    update-ca-certificates

COPY package.json package-lock.json ./

RUN npm ci

COPY . .

EXPOSE 1234

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npm", "start"]

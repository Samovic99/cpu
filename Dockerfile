FROM node:18-alpine
WORKDIR /app

COPY package.json yarn.lock ./

# Retry logic for yarn install
RUN yarn config set registry https://registry.npmjs.org/ \
    && yarn install --production || (sleep 10 && yarn install --production) || (sleep 10 && yarn install --production)

COPY . .

EXPOSE 5000
CMD ["node", "app.js"]


FROM apify/actor-node-playwright-chrome:24

COPY --chown=myuser:myuser package*.json ./

RUN npm install --include=dev --audit=false

COPY --chown=myuser:myuser . ./

RUN npm run build

CMD ["node", "dist/main.js"]

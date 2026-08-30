FROM apify/actor-node-playwright-chrome:24 AS builder

# Copy package files first for better Docker layer caching
COPY --chown=myuser:myuser package*.json ./

# Install dependencies
RUN npm install --include=dev --audit=false

# Copy source code
COPY --chown=myuser:myuser . ./

# Build TypeScript
RUN npm run build


# Final image
FROM apify/actor-node-playwright-chrome:24

# Copy package files
COPY --chown=myuser:myuser package*.json ./

# Install production dependencies
RUN npm --quiet set progress=false \
    && npm install --omit=dev --audit=false \
    && rm -rf ~/.npm

# Copy compiled JavaScript
COPY --from=builder --chown=myuser:myuser /usr/src/app/dist ./dist

# Copy remaining project files
COPY --chown=myuser:myuser . ./

# Start Actor
CMD ["node", "dist/main.js"]

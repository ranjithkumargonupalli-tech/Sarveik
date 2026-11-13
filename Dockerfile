# ---- Builder Stage ----
FROM node:22-slim AS builder

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --include=optional

# Copy the rest of the application code
COPY . .

# Run the build script to generate tools.json
RUN npm run build

# ---- Runner Stage ----
FROM node:22-slim AS runner

WORKDIR /app

# Copy the built node_modules and application files from the builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/server.js ./
COPY --from=builder /app/embeddingIndex.js ./
COPY --from=builder /app/tools.json ./
COPY --from=builder /app/public ./public
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/utils ./utils
COPY --from=builder /app/database.js ./
COPY --from=builder /app/.env ./

# Set the environment to production
ENV NODE_ENV=production

# Expose the port Railway will use
EXPOSE 3000

# Start the application
CMD ["node", "server.js"]
# Warden in a container: Node + Chromium come from the official Playwright image.
#
# Build:
#   docker build -t warden .
#
# One-off run (config, .env and reports/ come from the mounted directory):
#   docker run --rm -v "$PWD:/work" -w /work warden https://example.com --no-email
#   docker run --rm --env-file .env -v "$PWD:/work" -w /work warden        # uses ./qa.config.json
#
# Local web page (the server must listen on 0.0.0.0 inside the container to be reachable):
#   docker run --rm -p 4173:4173 -v "$PWD:/work" -w /work warden --serve --host 0.0.0.0
#
# Keep the image tag in step with the "playwright" version in package-lock.json,
# so the bundled browser matches what the library expects.
FROM mcr.microsoft.com/playwright:v1.64.1-noble

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY prompts ./prompts
COPY qa.config.example.json .env.example LICENSE README.md ./

# Reports, qa.config.json and .env are read from / written to the working directory.
WORKDIR /work

EXPOSE 4173
ENTRYPOINT ["node", "/app/src/cli.js"]

FROM mcr.microsoft.com/playwright:v1.40.0-focal

WORKDIR /app

COPY d2l-mcp/package*.json ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install

COPY d2l-mcp/ ./

RUN npm run build

ENV MCP_TRANSPORT=http

EXPOSE 3000

CMD ["npm", "start"]

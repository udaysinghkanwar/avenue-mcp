FROM mcr.microsoft.com/playwright:v1.40.0-focal

WORKDIR /app

COPY d2l-mcp/package*.json ./
RUN npm install playwright@1.40.0 --save-exact
RUN npm install

COPY d2l-mcp/ ./

RUN npm run build

ENV MCP_TRANSPORT=http
ENV PLAYWRIGHT_BROWSERS_PATH=0

EXPOSE 3000

CMD ["npm", "start"]

import { fileURLToPath } from "node:url";

const packageBuild = new URL("./node_modules/@kkaminsk/linear-mcp/build/", import.meta.url);
process.argv[1] = fileURLToPath(new URL("runner.mjs", packageBuild));

const { BaseHandler } = await import(new URL("core/handlers/base.handler.js", packageBuild));
const originalCreateResponse = BaseHandler.prototype.createResponse;
BaseHandler.prototype.createResponse = function createResponseWithPortableText(text, structuredContent) {
  const portableText = structuredContent === undefined
    ? text
    : `${text}\n${JSON.stringify(structuredContent)}`;
  return originalCreateResponse.call(this, portableText, structuredContent);
};

const { runCli } = await import(new URL("index.js", packageBuild));
await runCli();

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

// linear-mcp 1.0.0 reads `issue` off the raw GraphQL data, which nests it
// under `issueCreate`, so every create answered with an empty issue and no
// identifier. Hand the handler the payload it expects.
const { LinearGraphQLClient } = await import(new URL("graphql/client.js", packageBuild));
const originalCreateIssue = LinearGraphQLClient.prototype.createIssue;
LinearGraphQLClient.prototype.createIssue = async function createIssueUnwrapped(input) {
  const data = await originalCreateIssue.call(this, input);
  return data?.issueCreate ?? data;
};

const { runCli } = await import(new URL("index.js", packageBuild));
await runCli();

import { Agent, setGlobalDispatcher } from "undici";

// Keep outbound fetch on HTTP/1.1. Node's bundled undici negotiates HTTP/2 with
// TLS servers (mcp.exa.ai), and its HTTP/2 idle timeout emits an `error` on a
// stream nobody listens to, which kills the process (UND_ERR_INFO, INF-589).
// This module must be imported before anything that calls fetch.
setGlobalDispatcher(new Agent({ allowH2: false }));

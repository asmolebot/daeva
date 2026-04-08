# Daeva Proxy Architecture

## Goal
Transform Daeva into a **Dual-Mode Engine** to seamlessly support both custom automation (via the internal job queue) and generic, off-the-shelf native integrations (like OpenClaw's `comfy` provider) that expect to talk directly to the underlying service API.

## Core Concepts

### 1. Native Mode (Existing)
The original `POST /jobs` architecture remains. This is for custom integrations that want to submit background jobs, track state asynchronously, and handle explicit pod management.

### 2. Proxy Mode (New)
A transparent HTTP/WebSocket proxy layer exposed at `/proxy/:podId/*`. 
This allows generic clients to point their `baseUrl` to Daeva (e.g., `http://razerblade.local:8787/proxy/comfyapi`). 

To the generic client, it looks exactly like the target service. Under the hood, Daeva acts as an **API-aware Queueing Proxy**:
1. **Intercept:** Catch incoming HTTP/WS requests on the proxy route.
2. **Queue / Lock:** Acquire the GPU exclusivity lock (waiting if the GPU is currently used by another pod, like Whisper).
3. **Wake:** Ensure the requested pod (`:podId`) is running (starting it via `pod-controller` if it's currently stopped).
4. **Proxy:** Forward the raw traffic to the pod's internal `baseUrl`.
5. **Release:** Once the connection closes (or the request completes), release the GPU lock so other queued pods can spin up.

## Implementation Details
- Hook into the Fastify server (`src/server.ts`) to add a catch-all proxy route.
- Use a proxy library (like `@fastify/http-proxy` or standard Node HTTP proxying) to pipe the requests.
- Integrate with `job-manager.ts` or `pod-controller.ts` to request and hold the execution lock for the duration of the proxy request.
- Ensure WebSocket upgrades are supported (critical for ComfyUI's `/ws` endpoint).
- Keep it transparent: headers, query params, and body must pass through unchanged.
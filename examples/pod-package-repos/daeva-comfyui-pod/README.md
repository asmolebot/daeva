# daeva-comfyui-pod

Portable Comfy package for Daeva using the canonical pod id `comfyapi`.

## Canonical identity

- Pod id: `comfyapi`
- Proxy base URL: `$DAEVA_BASE/proxy/comfyapi`
- Legacy alias: `comfy` (compat only)

Install it with:

```bash
curl -X POST http://127.0.0.1:8787/pods/create   -H 'Content-Type: application/json'   -d '{"alias":"comfyapi"}'
```

## Layout

Readonly package assets:
- `workflows/text-to-image.json`
- `scripts/`
- `artifacts/models/comfyapi-demo-placeholder.safetensors`

Writable runtime directories are resolved by install hooks under the package data dir:
- `data/models`
- `data/input`
- `data/output`
- `data/temp`
- `data/custom_nodes`

## Stock workflow contract

Bundled workflow: `workflows/text-to-image.json`

Daeva uses this workflow directly when `generate-image` jobs hit the packaged `comfyapi` pod. It injects `input.prompt` into the configured node, submits `{ "prompt": <graph>, "client_id": ... }` to `/prompt`, then polls `/history/<prompt_id>` and resolves output image metadata.

- `promptNodeId`: `2`
- `promptInputName`: `text`
- `outputNodeId`: `7`
- expected checkpoint: `checkpoints/comfyapi-demo-placeholder.safetensors`

This bundled checkpoint is a deterministic placeholder so installs and tests have an exact artifact contract. It is **not** a production model. For real generations, override:
- `COMFY_DEFAULT_MODEL_SOURCE_URL`
- `COMFY_DEFAULT_MODEL_SHA256`
- `COMFY_DEFAULT_MODEL_FILENAME`

Expected default artifact:
- filename: `comfyapi-demo-placeholder.safetensors`
- source: `file://${PACKAGE_DIR}/artifacts/models/comfyapi-demo-placeholder.safetensors`
- sha256: `1252c303db5df9e4941c8b72d8e8fb79a89b0c1384f8d2ef2baeb28750da4329`
- destination: `models/checkpoints/comfyapi-demo-placeholder.safetensors`

## OpenClaw provider example

Point clients at Daeva's proxy, not raw port 8188:

```json
{
  "providers": {
    "comfy": {
      "baseUrl": "http://127.0.0.1:8787/proxy/comfyapi",
      "workflowPath": "./workflows/text-to-image.json",
      "promptNodeId": "2",
      "promptInputName": "text",
      "outputNodeId": "7"
    }
  }
}
```

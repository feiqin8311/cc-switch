/**
 * Codex 配置模板
 * 用于新建自定义供应商时的默认配置
 */

export interface CodexTemplate {
  auth: Record<string, any>;
  config: string;
}

/**
 * 第三方 Codex 反代生图：走本机 image_gen，不要 ChatGPT hosted 工具。
 * `requires_openai_auth = true` 会让 Codex 把图写到 `/mnt/data`，本机预览打不开。
 */
export const CODEX_THIRD_PARTY_IMAGE_GEN_TOML = `requires_openai_auth = false
http_headers = { "x-openai-actor-authorization" = "local-image-extension" }`;

/**
 * 获取 Codex 自定义模板
 * @returns Codex 模板配置
 */
export function getCodexCustomTemplate(): CodexTemplate {
  const config = `model_provider = "custom"
model = "gpt-5.6-sol"
model_reasoning_effort = "high"
disable_response_storage = true

[model_providers.custom]
name = "custom"
wire_api = "responses"
${CODEX_THIRD_PARTY_IMAGE_GEN_TOML}`;

  return {
    auth: { OPENAI_API_KEY: "" },
    config,
  };
}

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SECRET_SCRIPT = join(PROJECT_ROOT, "scripts", "provider-secret.ps1");
export const DEFAULT_PROVIDER_DIRECTORY = process.env.KAMI_PROVIDER_DIRECTORY || join(PROJECT_ROOT, "data", "runtime");

function paths(directory) {
  return {
    config: join(directory, "provider.json"),
    secret: join(directory, "provider-key.dpapi"),
    embeddingSecret: join(directory, "provider-embedding-key.dpapi")
  };
}

function runDpapi(action, value) {
  if (process.platform !== "win32") throw new Error("当前系统不支持 Windows DPAPI");
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SECRET_SCRIPT, action], {
    input: String(value || ""),
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

/** 每个模型角色的思考开关与思考强度；键名固定，方便面板按角色读写。 */
export const MODEL_THINKING_ROLES = ["main", "fast", "quality", "mt"];

/**
 * 出口协议：工作台要能挂不同形态的模型服务。
 * openai = OpenAI 兼容 /chat/completions；responses = OpenAI Responses /responses；
 * anthropic = Anthropic Messages /messages。旧配置没有这个字段，一律按 openai 处理。
 */
export const MODEL_PROTOCOLS = ["openai", "responses", "anthropic"];

export function normalizeProviderProtocol(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return MODEL_PROTOCOLS.includes(text) ? text : "openai";
}

function modelThinkingFields(config) {
  const fields = {};
  for (const role of MODEL_THINKING_ROLES) {
    fields[`${role}Thinking`] = String(config?.[`${role}Thinking`] ?? "");
    fields[`${role}Effort`] = String(config?.[`${role}Effort`] ?? "");
  }
  return fields;
}

export function saveProviderConfig(config, directory = DEFAULT_PROVIDER_DIRECTORY) {
  const target = paths(directory);
  const baseUrl = String(config.baseUrl || "").replace(/\/$/, "");
  const model = String(config.model || "");
  const fastModel = String(config.fastModel || "");
  const qualityModel = String(config.qualityModel || "");
  const mtModel = String(config.mtModel || "");
  const thinking = modelThinkingFields(config);
  const embeddingModel = String(config.embeddingModel || "");
  const embeddingBaseUrl = String(config.embeddingBaseUrl || "").replace(/\/$/, "");
  const apiKey = String(config.apiKey || "");
  const embeddingApiKey = String(config.embeddingApiKey || "");
  const inputPricePerMTok = String(config.inputPricePerMTok ?? "").trim();
  const outputPricePerMTok = String(config.outputPricePerMTok ?? "").trim();
  if (apiKey) atomicWrite(target.secret, runDpapi("protect", apiKey));
  else if (existsSync(target.secret)) rmSync(target.secret);
  if (embeddingApiKey) atomicWrite(target.embeddingSecret, runDpapi("protect", embeddingApiKey));
  else if (existsSync(target.embeddingSecret)) rmSync(target.embeddingSecret);
  atomicWrite(target.config, JSON.stringify({
    baseUrl, model, fastModel, qualityModel, mtModel, embeddingModel, embeddingBaseUrl,
    protocol: normalizeProviderProtocol(config.protocol),
    ...thinking,
    inputPricePerMTok, outputPricePerMTok,
    apiKeyConfigured: Boolean(apiKey), embeddingApiKeyConfigured: Boolean(embeddingApiKey),
    updatedAt: new Date().toISOString()
  }, null, 2));
  return { mode: "windows-dpapi", persisted: true, apiKeyPersisted: Boolean(apiKey), embeddingApiKeyPersisted: Boolean(embeddingApiKey) };
}

export function loadProviderConfig(directory = DEFAULT_PROVIDER_DIRECTORY) {
  const target = paths(directory);
  if (!existsSync(target.config)) return { config: {}, persistence: { mode: "windows-dpapi", persisted: false, apiKeyPersisted: false, embeddingApiKeyPersisted: false } };
  try {
    const metadata = JSON.parse(readFileSync(target.config, "utf8"));
    let apiKey = "";
    if (existsSync(target.secret)) apiKey = runDpapi("unprotect", readFileSync(target.secret, "utf8"));
    let embeddingApiKey = "";
    if (existsSync(target.embeddingSecret)) {
      try {
        embeddingApiKey = runDpapi("unprotect", readFileSync(target.embeddingSecret, "utf8"));
      } catch {
        embeddingApiKey = "";
      }
    }
    return {
      config: {
        baseUrl: metadata.baseUrl || "",
        model: metadata.model || "",
        fastModel: metadata.fastModel || "",
        qualityModel: metadata.qualityModel || "",
        mtModel: metadata.mtModel || "",
        protocol: normalizeProviderProtocol(metadata.protocol),
        ...modelThinkingFields(metadata),
        embeddingModel: metadata.embeddingModel || "",
        embeddingBaseUrl: metadata.embeddingBaseUrl || "",
        inputPricePerMTok: String(metadata.inputPricePerMTok ?? ""),
        outputPricePerMTok: String(metadata.outputPricePerMTok ?? ""),
        apiKey,
        embeddingApiKey
      },
      persistence: {
        mode: "windows-dpapi",
        persisted: true,
        apiKeyPersisted: Boolean(apiKey),
        embeddingApiKeyPersisted: Boolean(embeddingApiKey)
      }
    };
  } catch (error) {
    return {
      config: {},
      persistence: {
        mode: "windows-dpapi",
        persisted: false,
        apiKeyPersisted: false,
        embeddingApiKeyPersisted: false,
        warning: `本地模型配置读取失败：${error.message}`
      }
    };
  }
}

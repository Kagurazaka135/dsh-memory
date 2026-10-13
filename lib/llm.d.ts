/**
 * 整理专用 LLM 客户端 —— 走**本地凭证代理（broker）**。
 *
 * 铁律：代码里只有 `http://127.0.0.1:9999` 和假 key `local-broker`；
 * 真钥匙由 broker 按模型名注入，本文件（及整个仓库）不可能出现任何真 key。
 *
 * broker 不可达 / 超时 / 返回不可解析 → 抛错，由调用方决定"宁可不写记忆"。
 */
export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}
export interface BrokerOptions {
    baseUrl: string;
    model: string;
    timeoutMs?: number;
    /** 输出上限；推理模型的 reasoning token 也计入，给足余量（默认 8192）。 */
    maxTokens?: number;
}
export declare const BROKER_FAKE_KEY = "local-broker";
export declare function chat(options: BrokerOptions, messages: readonly ChatMessage[], signal?: AbortSignal): Promise<string>;
/**
 * 从 OpenAI 兼容响应里取第一个 choice 的文本。
 * 推理模型（如 deepseek-flash）的 `reasoning_content` 会先于 `content` 生成：
 * content 为空但 reasoning 里带完整 JSON 时回退到 reasoning（extractJsonObject 会抠出来），
 * 两者都空才报错 —— 错误里带上 finish_reason 便于定位（如 length = token 预算耗尽）。
 */
export declare function extractContent(raw: string): string;
/** 从模型输出里抠出第一个 JSON 对象（容忍 ```json 代码栅栏与前后废话）。 */
export declare function extractJsonObject(raw: string): Record<string, unknown> | undefined;

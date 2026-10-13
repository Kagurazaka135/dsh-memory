/**
 * 整理专用 LLM 客户端 —— 走**本地凭证代理（broker）**。
 *
 * 铁律：代码里只有 `http://127.0.0.1:9999` 和假 key `local-broker`；
 * 真钥匙由 broker 按模型名注入，本文件（及整个仓库）不可能出现任何真 key。
 *
 * broker 不可达 / 超时 / 返回不可解析 → 抛错，由调用方决定"宁可不写记忆"。
 */
export const BROKER_FAKE_KEY = 'local-broker';
export async function chat(options, messages, signal) {
    const url = `${options.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
    const timeoutMs = options.timeoutMs ?? 300_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('dsh-memory: broker 请求超时')), timeoutMs);
    const fused = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
    let response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${BROKER_FAKE_KEY}`,
            },
            body: JSON.stringify({
                model: options.model,
                messages,
                temperature: 0.2,
                max_tokens: options.maxTokens ?? 8192,
                stream: false,
            }),
            signal: fused,
        });
    }
    catch (error) {
        throw new Error(`dsh-memory: 无法连接本地 broker（${options.baseUrl}）：${error instanceof Error ? error.message : String(error)}`);
    }
    finally {
        clearTimeout(timer);
    }
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`dsh-memory: broker 返回 HTTP ${response.status}${body ? `：${body.slice(0, 300)}` : ''}`);
    }
    const text = await response.text();
    return extractContent(text);
}
/**
 * 从 OpenAI 兼容响应里取第一个 choice 的文本。
 * 推理模型（如 deepseek-flash）的 `reasoning_content` 会先于 `content` 生成：
 * content 为空但 reasoning 里带完整 JSON 时回退到 reasoning（extractJsonObject 会抠出来），
 * 两者都空才报错 —— 错误里带上 finish_reason 便于定位（如 length = token 预算耗尽）。
 */
export function extractContent(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new Error(`dsh-memory: broker 响应不是 JSON（前 120 字：${raw.slice(0, 120)}）`);
    }
    const choices = parsed.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
        throw new Error('dsh-memory: broker 响应没有 choices');
    }
    const choice = choices[0];
    const finish = typeof choice.finish_reason === 'string' ? choice.finish_reason : 'unknown';
    const content = choice.message?.content;
    const text = blocksToText(content);
    if (text.trim() !== '')
        return text;
    const reasoning = blocksToText(choice.message?.reasoning_content);
    if (reasoning.trim() !== '')
        return reasoning;
    throw new Error(`dsh-memory: broker 响应 content 为空（finish_reason=${finish}；可能是 token 预算被 reasoning 耗尽）`);
}
function blocksToText(content) {
    if (typeof content === 'string')
        return content;
    if (Array.isArray(content)) {
        const parts = [];
        for (const block of content) {
            if (typeof block === 'string')
                parts.push(block);
            else if (block !== null && typeof block === 'object' && typeof block.text === 'string') {
                parts.push(block.text);
            }
        }
        return parts.join('');
    }
    return '';
}
/** 从模型输出里抠出第一个 JSON 对象（容忍 ```json 代码栅栏与前后废话）。 */
export function extractJsonObject(raw) {
    const unfenced = raw.replace(/```(?:json)?\s*([\s\S]*?)```/g, (_, inner) => inner);
    for (const candidate of [unfenced, raw]) {
        const start = candidate.indexOf('{');
        const end = candidate.lastIndexOf('}');
        if (start === -1 || end <= start)
            continue;
        try {
            const parsed = JSON.parse(candidate.slice(start, end + 1));
            if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed;
            }
        }
        catch {
            /* 试下一个候选 */
        }
    }
    return undefined;
}

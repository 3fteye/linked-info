import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const [, , inputArgument, outputArgument, requestedSourceName] = process.argv;
if (!inputArgument || !outputArgument) {
  throw new Error(
    "usage: node scripts/build-redacted-account-import-draft.mjs <redacted.txt> <draft.json> [source-name]",
  );
}

const inputPath = resolve(inputArgument);
const outputPath = resolve(outputArgument);
const sourceName = requestedSourceName?.trim() || basename(inputPath);
const sourceText = (await readFile(inputPath, "utf8")).replace(/\r\n?/gu, "\n").trim();
if (!sourceText) throw new Error("redacted source is empty");

const emailPlaceholderPattern = /\[\[LI_EMAIL_\d{3}\]\]/gu;
const exactEmailPlaceholderPattern = /^\[\[LI_EMAIL_\d{3}\]\]$/u;
const candidates = new Map();
const tagDescriptions = new Map();
let recordSequence = 0;
let proxySequence = 0;
let promoSequence = 0;
let tokenSequence = 0;

function normalizeName(name) {
  return name.trim().toLocaleLowerCase("zh-CN");
}

function unique(values) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function mergeContent(left, right) {
  const values = unique([left ?? "", right ?? ""]);
  return values.length ? values.join("\n\n") : null;
}

function addCandidate(name, content = null, referenceNames = []) {
  const trimmedName = name.trim();
  if (!trimmedName || Array.from(trimmedName).length > 160) {
    throw new Error(`invalid candidate name: ${trimmedName}`);
  }
  const key = normalizeName(trimmedName);
  const current = candidates.get(key);
  const cleanReferences = unique(referenceNames)
    .filter((value) => normalizeName(value) !== key)
    .slice(0, 12);
  if (current) {
    current.content = mergeContent(current.content, content);
    current.referenceNames = unique([...current.referenceNames, ...cleanReferences]).slice(0, 12);
    return current;
  }
  const candidate = {
    name: trimmedName,
    content: content?.trim() || null,
    referenceNames: cleanReferences,
  };
  candidates.set(key, candidate);
  return candidate;
}

function ensureTag(name, description) {
  if (!tagDescriptions.has(name)) tagDescriptions.set(name, description);
  addCandidate(name, tagDescriptions.get(name), []);
  return name;
}

const sectionMatchers = [
  [/^antigravity\s+12\s+PRO$/iu, "Antigravity 12 PRO"],
  [/^欠谷歌钱的$/u, "欠谷歌费用"],
  [/^gcp被封禁了$/iu, "GCP 被封禁"],
  [/^有问题$/u, "存在登录或验证问题"],
  [/^因为5个同时加入到一个家庭组/u, "家庭组集中加入后异常"],
  [/^需要手机扫码验证$/u, "需要手机扫码验证"],
  [/^新购买账号$/u, "新购买账号"],
  [/^无法获取优惠链接/u, "无法获取优惠链接"],
  [/^figma\s*账号$/iu, "Figma 账号"],
  [/^===\s*卡密内容\s*===/u, "卡密内容（已使用邀请）"],
  [/^hostvds会送注册账号一美元$/iu, "HostVDS 注册奖励"],
  [/^webshare\s+api\s+key$/iu, "Webshare API Key"],
];

const keywordTags = [
  [/antigravity/iu, "服务：Antigravity", "文本明确提到 Antigravity。"],
  [/\bcodex\b|codex超牛会员|codex封禁|codex已?死/iu, "服务：Codex", "文本明确提到 Codex。"],
  [/\bgcp\b/iu, "服务：Google Cloud", "文本明确提到 GCP。"],
  [/youtube/iu, "服务：YouTube", "文本明确提到 YouTube。"],
  [/figma/iu, "服务：Figma", "文本明确提到 Figma。"],
  [/webshare/iu, "服务：Webshare", "文本明确提到 Webshare。"],
  [/hostvds/iu, "服务：HostVDS", "文本明确提到 HostVDS。"],
  [/711proxy|global\.rotgb/iu, "服务：711Proxy", "代理端点域名明确对应 711Proxy。"],
  [/codex\s*p\b|codex\s*plus|codex超牛会员/iu, "订阅：Codex Plus", "原文明确标记 Codex Plus 或等价缩写。"],
  [/正价plus/iu, "订阅：正价 Plus", "原文只标记“正价 Plus”，不推断具体服务。"],
  [/antigravity\s+12\s+pro/iu, "订阅：Antigravity Pro", "原文章节明确标记 Antigravity Pro。"],
  [/one\s*pro/iu, "订阅：Google One Pro", "原文明确标记 One Pro。"],
  [/antigravity免费pro/iu, "订阅：Antigravity 免费 Pro", "原文明确标记 Antigravity 免费 Pro。"],
  [/订阅\s*youtube/iu, "订阅：YouTube", "原文明确标记 YouTube 订阅。"],
  [/订阅加宽/u, "订阅：加宽", "保留原文中的“订阅加宽”分类，不推断具体套餐。"],
  [/家庭组/u, "关系：家庭组", "原文明确提到家庭组。"],
  [/codex\s*died|codex封禁/iu, "状态：Codex 封禁", "原文标记 Codex 已失效或封禁。"],
  [/gcp被封禁/iu, "状态：GCP 封禁", "原文明确标记 GCP 被封禁。"],
  [/申诉中/u, "状态：申诉中", "原文明确标记正在申诉。"],
  [/申诉成功需要登录/u, "状态：申诉成功待登录", "原文明确标记申诉成功但仍需登录。"],
  [/需要手机扫码|要登录手机扫码|三星手机|手势验证|验证手机号|绑死手机号/u, "状态：需要设备或手机号验证", "原文明确提到设备、扫码或手机号验证。"],
  [/感觉(?:像|是)个真人账号/u, "标记：疑似真人账号", "原文作者标记为疑似真人账号。"],
  [/欠谷歌(?:钱|费用)/u, "状态：Google 欠费", "原文章节明确标记 Google 欠费。"],
  [/无法获取优惠链接/u, "状态：无法获取优惠链接", "原文明确标记无法获取优惠链接。"],
];

function inferredReferences(text, sectionReference = null) {
  const references = [];
  if (sectionReference) references.push(sectionReference);
  for (const [pattern, name, description] of keywordTags) {
    if (!pattern.test(text)) continue;
    pattern.lastIndex = 0;
    references.push(ensureTag(name, description));
  }
  return unique(references).slice(0, 11);
}

function sectionNodeName(label) {
  return `批次：${label}`;
}

function findSection(line) {
  const trimmed = line.trim();
  for (const [pattern, label] of sectionMatchers) {
    if (pattern.test(trimmed)) return label;
  }
  return null;
}

function firstEmailPlaceholder(line) {
  emailPlaceholderPattern.lastIndex = 0;
  const match = emailPlaceholderPattern.exec(line);
  emailPlaceholderPattern.lastIndex = 0;
  return match?.[0] ?? null;
}

function finalizeAccountRecord(record) {
  if (!record) return;
  const content = record.lines.join("\n").trim();
  if (!content) return;
  recordSequence += 1;
  const accountName = `账号：${record.account}`;
  const typeTag = ensureTag("类型：账号", "账号实体；具体服务状态保存在引用它的记录节点中。\n");
  addCandidate(accountName, null, [typeTag]);
  const sectionReference = record.section
    ? ensureTag(
        sectionNodeName(record.section),
        `来自原文分组“${record.section}”；仅保留来源上下文，不把它强制解释成固定服务类型。`,
      )
    : null;
  const references = [
    accountName,
    ...inferredReferences(`${record.section ?? ""}\n${content}`, sectionReference),
  ];
  addCandidate(
    `账号记录：${record.account} / ${String(recordSequence).padStart(3, "0")}`,
    content,
    references,
  );
}

const lines = sourceText.split("\n");
let currentSection = null;
let currentRecord = null;

for (const line of lines) {
  const section = findSection(line);
  if (section) {
    finalizeAccountRecord(currentRecord);
    currentRecord = null;
    currentSection = section;
    ensureTag(
      sectionNodeName(section),
      `来自原文分组“${section}”；仅保留来源上下文，不把它强制解释成固定服务类型。`,
    );
    continue;
  }

  if (/^global\.rotgb\.711proxy\.com:/iu.test(line.trim())) {
    finalizeAccountRecord(currentRecord);
    currentRecord = null;
    proxySequence += 1;
    const service = ensureTag("服务：711Proxy", "代理端点域名明确对应 711Proxy。");
    addCandidate(
      `代理记录：711Proxy / ${String(proxySequence).padStart(2, "0")}`,
      line.trim(),
      [service],
    );
    continue;
  }

  if (/^\[\[LI_PROMO_CODE_\d{3}\]\]$/u.test(line.trim())) {
    finalizeAccountRecord(currentRecord);
    currentRecord = null;
    promoSequence += 1;
    const service = ensureTag("服务：OpenAI", "优惠码由用户明确说明属于 OpenAI。");
    const type = ensureTag("类型：优惠码", "可兑换或可消费的优惠码记录。");
    addCandidate(
      `优惠码记录：OpenAI / ${String(promoSequence).padStart(2, "0")}`,
      line.trim(),
      [service, type],
    );
    continue;
  }

  if (
    currentSection === "Webshare API Key" &&
    /^\[\[LI_TOKEN_\d{3}\]\]$/u.test(line.trim())
  ) {
    finalizeAccountRecord(currentRecord);
    currentRecord = null;
    tokenSequence += 1;
    const service = ensureTag("服务：Webshare", "文本明确提到 Webshare。");
    const type = ensureTag("类型：API 密钥", "API 密钥记录；值只保存在加密工作区内容中。");
    addCandidate(
      `API 密钥记录：Webshare / ${String(tokenSequence).padStart(2, "0")}`,
      line.trim(),
      [service, type],
    );
    continue;
  }

  const account = firstEmailPlaceholder(line);
  if (account) {
    finalizeAccountRecord(currentRecord);
    currentRecord = { account, section: currentSection, lines: [line] };
    continue;
  }

  if (currentRecord) currentRecord.lines.push(line);
}
finalizeAccountRecord(currentRecord);

for (const candidate of candidates.values()) {
  if (candidate.content && Array.from(candidate.content).length > 6_000) {
    throw new Error(`candidate content is too large: ${candidate.name}`);
  }
  if (candidate.referenceNames.length > 12) {
    throw new Error(`candidate has too many references: ${candidate.name}`);
  }
  for (const referenceName of candidate.referenceNames) {
    if (!candidates.has(normalizeName(referenceName))) {
      throw new Error(`candidate reference is missing: ${candidate.name} -> ${referenceName}`);
    }
  }
}

const candidateList = [...candidates.values()];
const responses = [];
for (let index = 0; index < candidateList.length; index += 24) {
  responses.push({ nodes: candidateList.slice(index, index + 24) });
}

const draft = {
  schemaVersion: 1,
  kind: "linked-info-document-import-draft",
  sourceName,
  sourceHash: createHash("sha256").update(sourceText, "utf8").digest("hex"),
  sourceText,
  handling: {
    secretsRemainAsLocalPlaceholders: true,
    generatedFromRedactedText: true,
    requiresCanvasPreview: true,
  },
  warnings: [
    "该草稿依据脱敏文本生成；占位符必须在原脱敏页面中本地还原。",
    "批次节点保留上下文但不强制解释为服务；服务和状态引用只来自原文明示关键词。",
    "简单密码、2FA、恢复码等秘密只保存在记录内容中，不进入节点名称。",
  ],
  responses,
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(draft, null, 2)}\n`, "utf8");

const summary = {
  outputPath,
  sourceName,
  sourceCharacters: Array.from(sourceText).length,
  candidates: candidateList.length,
  chunks: responses.length,
  accountNodes: candidateList.filter((item) => item.name.startsWith("账号：")).length,
  accountRecords: candidateList.filter((item) => item.name.startsWith("账号记录：")).length,
  tagNodes: candidateList.filter((item) => /^(?:类型|服务|状态|订阅|关系|标记|批次)：/u.test(item.name)).length,
  proxyRecords: proxySequence,
  promotionCodeRecords: promoSequence,
  apiKeyRecords: tokenSequence,
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
